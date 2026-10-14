// SPDX-License-Identifier: AGPL-3.0-or-later

use super::{ActionQuery, acl_forbidden, api_failure};
use crate::{
    acl,
    api::{
        client::{AdminApiClient, ApiError, ApiResultExt},
        types::ShopAdminOrder,
    },
    middleware::{
        auth::AuthContext,
        csrf::CsrfToken,
        flash::{self, FlashData},
    },
    state::AppState,
    templates::{self, pages::shop::ShopPageData},
    utils::forms::MultiValueForm,
};
use axum::{
    Router,
    extract::{Query, Request, State},
    response::{Html, IntoResponse, Response},
    routing::get,
};
use serde::Deserialize;
use serde_json::{Value, json};
use time::{OffsetDateTime, UtcOffset, format_description::well_known::Rfc3339};

// SetShopPricesRequest takes at most 10,000,000 cents ($100,000.00).
const MAX_PRICE_CENTS: i64 = 10_000_000;
// ApplyShopCampaignRequest and RemoveShopCampaignRequest take at most 200 SKUs.
const MAX_SKUS_PER_REQUEST: usize = 200;

#[derive(Deserialize)]
struct ShopQuery {
    #[serde(rename = "type")]
    product_type: Option<String>,
    order: Option<String>,
}

pub fn router() -> Router<AppState> {
    Router::new().route("/shop", get(shop_page).post(shop_post))
}

async fn shop_page(
    State(state): State<AppState>,
    auth: axum::Extension<AuthContext>,
    csrf: axum::Extension<CsrfToken>,
    flash: Option<axum::Extension<FlashData>>,
    Query(query): Query<ShopQuery>,
) -> Response {
    let config = state.config();
    if let Some(response) = acl_forbidden(config, &auth.0, acl::SHOP_MANAGE) {
        return response;
    }
    let client = AdminApiClient::new(state.http_client(), config, &auth.0.session);
    let mut flash = flash.map(|flash| flash.0.to_flash_message());
    let mut order = None;
    if let Some(raw) = query.order.as_deref() {
        match find_order(&client, raw).await {
            Ok(found) => order = Some(found),
            Err(error) => flash = Some(error.to_flash_message()),
        }
    }
    let shop = client.get_shop().await.log_error("load the shop");
    let visionary = client
        .get_shop_visionary()
        .await
        .log_error("load the Visionary numbers");
    let admin_acls = auth
        .0
        .admin_user
        .as_ref()
        .map(|user| user.acls.as_slice())
        .unwrap_or(&[]);
    // Item names and images need COSMETICS_MANAGE; without it the item rows show their SKU.
    let items = if acl::has_permission(admin_acls, acl::COSMETICS_MANAGE) {
        client
            .list_cosmetic_items()
            .await
            .log_error("list cosmetic items")
    } else {
        None
    };
    let markup = templates::pages::shop::shop_page(
        config,
        &auth.0,
        &csrf.0.0,
        flash.as_ref(),
        &ShopPageData {
            shop: shop.as_ref(),
            items: items.as_deref(),
            product_type: query.product_type.as_deref().unwrap_or(""),
            order_query: query.order.as_deref().unwrap_or(""),
            order: order.as_ref(),
            visionary: visionary.as_ref(),
        },
    );
    Html(markup.into_string()).into_response()
}

// Payriff shows every payment as "Micup #<order_id> …", so support starts from that number.
async fn find_order(client: &AdminApiClient, raw: &str) -> Result<ShopAdminOrder, FlashData> {
    let Some(order_id) = raw.trim().parse::<i64>().ok().filter(|id| *id > 0) else {
        return Err(FlashData::error("Enter an order number."));
    };
    match client.get_shop_order(&order_id.to_string()).await {
        Ok(order) => Ok(order),
        Err(ApiError::Http { status: 404, .. }) => {
            Err(FlashData::error("No order with that number."))
        }
        Err(error) => Err(api_failure("load the order", &error)),
    }
}

async fn shop_post(
    State(state): State<AppState>,
    auth: axum::Extension<AuthContext>,
    Query(aq): Query<ActionQuery>,
    request: Request,
) -> Response {
    let config = state.config();
    if let Some(response) = acl_forbidden(config, &auth.0, acl::SHOP_MANAGE) {
        return response;
    }
    let flash = match MultiValueForm::from_request(request).await {
        None => FlashData::error("Invalid form data"),
        Some(form) => {
            let client = AdminApiClient::new(state.http_client(), config, &auth.0.session);
            match aq.action.as_deref().unwrap_or("") {
                "settings" => save_settings(&client, &form).await,
                "refresh_try_rate" => match client.refresh_shop_try_rate().await {
                    Ok(()) => FlashData::success("CBAR rate refresh queued."),
                    Err(error) => api_failure("queue the CBAR rate refresh", &error),
                },
                "save_prices" => save_prices(&client, &form).await,
                "apply_campaign" => apply_campaign(&client, &form).await,
                "remove_campaign" => remove_campaign(&client, &form).await,
                "visionary_price" => save_visionary_price(&client, &form).await,
                "visionary_sale" => save_visionary_sale(&client, &form).await,
                "visionary_slots" => save_visionary_slots(&client, &form).await,
                "visionary_rewards" => save_visionary_rewards(&client, &form).await,
                "bundle_create" => create_bundle(&client, &form).await,
                "bundle_update" => update_bundle(&client, &form).await,
                "bundle_delete" => delete_bundle(&client, &form).await,
                _ => FlashData::error("Unknown shop action"),
            }
        }
    };
    flash::redirect_with_flash(
        &format!("{}/shop", config.base_path),
        flash,
        config.secure_cookies(),
    )
}

async fn save_settings(client: &AdminApiClient, form: &MultiValueForm) -> FlashData {
    let rate = match parse_rate_micro(form.first("usd_to_azn_rate").unwrap_or("")) {
        Ok(rate) => rate,
        Err(message) => return FlashData::error(message),
    };
    let try_override = form.first("try_to_azn_rate_override").unwrap_or("").trim();
    if !try_override.is_empty()
        && !matches!(parse_decimal(try_override, 6), Some(1_000..=1_000_000))
    {
        return FlashData::error(
            "The TRY → AZN override must be 0.001–1.0 with at most six decimals, or blank for automatic.",
        );
    }
    let Some(discount) = form
        .parse_u32("premium_discount_percent")
        .filter(|percent| *percent <= 95)
    else {
        return FlashData::error("Plus member discount must be 0–95.");
    };
    let body = json!({
        "premium_sales_open": form.bool_value("premium_sales_open"),
        "item_sales_open": form.bool_value("item_sales_open"),
        "usd_to_azn_rate_micro": rate,
        "premium_discount_percent": discount,
        "try_to_azn_rate_override": (!try_override.is_empty()).then_some(try_override),
    });
    match client.update_shop_settings(&body).await {
        Ok(()) => FlashData::success("Shop settings saved."),
        Err(error) => api_failure("save the shop settings", &error),
    }
}

// Each table row posts its SKU in "rows" and the price it showed in "was_<sku>"; only prices the
// admin changed are sent, so a form opened before someone else's change never undoes it.
async fn save_prices(client: &AdminApiClient, form: &MultiValueForm) -> FlashData {
    let mut changes = Vec::new();
    for sku in form.list_values("rows") {
        let Some(input) = form.first(&format!("price_{sku}")) else {
            continue;
        };
        let cents = match parse_usd_cents(input) {
            Ok(cents) => cents,
            Err(message) => return FlashData::error(format!("{sku}: {message}")),
        };
        let shown = parse_usd_cents(form.first(&format!("was_{sku}")).unwrap_or(""));
        if Ok(cents) != shown {
            changes.push(json!({ "sku": sku, "base_usd_cents": cents }));
        }
    }
    if changes.is_empty() {
        return FlashData::info("No prices changed.");
    }
    match client.set_shop_prices(&json!({ "prices": changes })).await {
        Ok(()) => FlashData::success(format!("Saved {}.", count_of(changes.len(), "price"))),
        Err(error) => api_failure("save the prices", &error),
    }
}

// The campaign routes take 1–200 SKUs; "Select every product" can tick more.
fn selected_products(form: &MultiValueForm) -> Result<Vec<String>, FlashData> {
    match form.list_values("product_ids") {
        skus if skus.is_empty() => Err(FlashData::error("Select at least one product.")),
        skus if skus.len() > MAX_SKUS_PER_REQUEST => Err(FlashData::error(format!(
            "Select at most {MAX_SKUS_PER_REQUEST} products at a time."
        ))),
        skus => Ok(skus),
    }
}

async fn apply_campaign(client: &AdminApiClient, form: &MultiValueForm) -> FlashData {
    let skus = match selected_products(form) {
        Ok(skus) => skus,
        Err(flash) => return flash,
    };
    let Some(percent) = form
        .parse_u32("discount_percent")
        .filter(|percent| (1..=95).contains(percent))
    else {
        return FlashData::error("Discount must be 1–95.");
    };
    let ends_at = match turkey_local_to_utc(form.first("ends_at").unwrap_or("")) {
        Ok(ends_at) => ends_at,
        Err(message) => return FlashData::error(message),
    };
    let body = json!({ "skus": skus, "percent": percent, "ends_at": ends_at });
    match client.apply_shop_campaign(&body).await {
        Ok(()) => {
            let until = ends_at
                .as_deref()
                .map(|at| format!(" until {}", turkey_time_label(at)))
                .unwrap_or_default();
            let products = count_of(skus.len(), "product");
            FlashData::success(format!(
                "Campaign −{percent}% applied to {products}{until}."
            ))
        }
        Err(error) => api_failure("apply the campaign", &error),
    }
}

async fn remove_campaign(client: &AdminApiClient, form: &MultiValueForm) -> FlashData {
    let skus = match selected_products(form) {
        Ok(skus) => skus,
        Err(flash) => return flash,
    };
    match client.remove_shop_campaign(&json!({ "skus": skus })).await {
        Ok(()) => {
            let products = count_of(skus.len(), "product");
            FlashData::success(format!("Campaign removed from {products}."))
        }
        Err(error) => api_failure("remove the campaign", &error),
    }
}

// Micup (Visionary): blank takes it out of the shop, like a blank row in the price table.
async fn save_visionary_price(client: &AdminApiClient, form: &MultiValueForm) -> FlashData {
    let cents = match parse_usd_cents(form.first("visionary_price").unwrap_or("")) {
        Ok(cents) => cents,
        Err(message) => return FlashData::error(message),
    };
    let body = json!({ "prices": [{ "sku": "visionary", "base_usd_cents": cents }] });
    match client.set_shop_prices(&body).await {
        Ok(()) => FlashData::success(match cents {
            Some(cents) => format!("Visionary price set to {}.", format_usd(cents)),
            None => "Visionary is out of the shop: it has no price.".to_owned(),
        }),
        Err(error) => api_failure("save the Visionary price", &error),
    }
}

async fn save_visionary_sale(client: &AdminApiClient, form: &MultiValueForm) -> FlashData {
    let on_sale = form.bool_value("visionary_on_sale");
    match client
        .update_shop_settings(&json!({ "visionary_on_sale": on_sale }))
        .await
    {
        Ok(()) if on_sale => FlashData::success("Visionary is on sale."),
        Ok(()) => FlashData::success("Visionary is hidden."),
        Err(error) => api_failure("change whether Visionary sells", &error),
    }
}

async fn save_visionary_slots(client: &AdminApiClient, form: &MultiValueForm) -> FlashData {
    let Some(total) = form.parse_u32("total").filter(|total| *total <= 100_000) else {
        return FlashData::error("The total must be a whole number from 0 to 100000.");
    };
    match client.set_visionary_slots(&json!({ "total": total })).await {
        Ok(()) => FlashData::success(format!("Visionary numbers set to {total}.")),
        Err(ApiError::Http { message, .. }) if message.contains("CANNOT_SHRINK_RESERVED_SLOTS") => {
            FlashData::error("Numbers that are sold or held cannot be removed.")
        }
        Err(error) => api_failure("set the Visionary numbers", &error),
    }
}

// The API also refuses priced or non-owned items; the picker only offers unpriced owned ones.
async fn save_visionary_rewards(client: &AdminApiClient, form: &MultiValueForm) -> FlashData {
    let ids = form.list_values("reward_item_ids");
    if ids.len() > 10 {
        return FlashData::error("Pick at most 10 reward decorations.");
    }
    if !ids
        .iter()
        .all(|id| id.parse::<i64>().is_ok_and(|id| id > 0))
    {
        return FlashData::error("Pick the reward decorations from the list.");
    }
    let body = json!({ "visionary_reward_item_ids": ids });
    match client.update_shop_settings(&body).await {
        Ok(()) => FlashData::success(format!(
            "Visionary rewards saved: {}.",
            count_of(ids.len(), "decoration")
        )),
        Err(error) => api_failure("save the Visionary rewards", &error),
    }
}

// For bundles, the API checks the same limits and also refuses items that
// are not owned-only and on sale, or are Visionary rewards; the picker offers only owned-only non-rewards.
async fn create_bundle(client: &AdminApiClient, form: &MultiValueForm) -> FlashData {
    let body = match bundle_body(form) {
        Ok(body) => body,
        Err(message) => return FlashData::error(message),
    };
    match client.create_shop_bundle(&body).await {
        Ok(()) => FlashData::success(format!(
            "Bundle {} created. Give it a price in the table below to sell it.",
            body["name"].as_str().unwrap_or_default()
        )),
        Err(error) => api_failure("create the bundle", &error),
    }
}

async fn update_bundle(client: &AdminApiClient, form: &MultiValueForm) -> FlashData {
    let Some(bundle_id) = bundle_id(form) else {
        return FlashData::error("Unknown bundle.");
    };
    let body = match bundle_body(form) {
        Ok(body) => body,
        Err(message) => return FlashData::error(message),
    };
    match client.update_shop_bundle(&bundle_id, &body).await {
        Ok(()) => FlashData::success(format!(
            "Bundle {} saved.",
            body["name"].as_str().unwrap_or_default()
        )),
        Err(error) => api_failure("save the bundle", &error),
    }
}

async fn delete_bundle(client: &AdminApiClient, form: &MultiValueForm) -> FlashData {
    let Some(bundle_id) = bundle_id(form) else {
        return FlashData::error("Unknown bundle.");
    };
    match client.delete_shop_bundle(&bundle_id).await {
        Ok(()) => FlashData::success("Bundle and its price deleted. Paid orders still deliver."),
        Err(error) => api_failure("delete the bundle", &error),
    }
}

fn bundle_id(form: &MultiValueForm) -> Option<String> {
    let id = form.first("bundle_id")?.trim().parse::<i64>().ok()?;
    (id > 0).then(|| id.to_string())
}

/// The create and edit forms as the API body: a name of 1–64 and a description of at most 256
/// characters, counted in UTF-16 units as the API counts them, a blank description as null, and
/// 2–10 item IDs with repeats dropped in place.
pub(crate) fn bundle_body(form: &MultiValueForm) -> Result<Value, String> {
    let name = form.first("name").unwrap_or_default().trim();
    if !(1..=64).contains(&name.encode_utf16().count()) {
        return Err("The bundle name must be 1–64 characters.".to_owned());
    }
    let description = form.first("description").unwrap_or_default().trim();
    if description.encode_utf16().count() > 256 {
        return Err("The bundle description must be at most 256 characters.".to_owned());
    }
    let mut item_ids: Vec<String> = Vec::new();
    for raw in form.list_values("item_ids") {
        let Some(id) = raw.parse::<i64>().ok().filter(|id| *id > 0) else {
            return Err("Pick the bundle items from the list.".to_owned());
        };
        let id = id.to_string();
        if !item_ids.contains(&id) {
            item_ids.push(id);
        }
    }
    if !(2..=10).contains(&item_ids.len()) {
        return Err("A bundle takes 2–10 different items.".to_owned());
    }
    Ok(json!({
        "name": name,
        "description": (!description.is_empty()).then_some(description),
        "item_ids": item_ids,
    }))
}

pub(crate) fn count_of(count: usize, noun: &str) -> String {
    let plural = if count == 1 { "" } else { "s" };
    format!("{count} {noun}{plural}")
}

// "12.34" with at most `decimals` digits after the point, in units of 10^-decimals.
fn parse_decimal(input: &str, decimals: usize) -> Option<i64> {
    let input = input.trim();
    let (whole, fraction) = input.split_once('.').unwrap_or((input, ""));
    let digits = |part: &str| part.bytes().all(|byte| byte.is_ascii_digit());
    if whole.is_empty() || fraction.len() > decimals || !digits(whole) || !digits(fraction) {
        return None;
    }
    let fraction: i64 = format!("{fraction:0<decimals$}").parse().ok()?;
    whole
        .parse::<i64>()
        .ok()?
        .checked_mul(10_i64.pow(decimals as u32))?
        .checked_add(fraction)
}

/// "1.7", "1.7000" and "2" read as 1_700_000, 1_700_000 and 2_000_000 AZN per USD in millionths.
/// At most four decimals, because the API shows every rate with four (orders, the shop), so the rate
/// support reads is the rate that was charged; anything outside 1.0000–3.0000 is refused.
pub(crate) fn parse_rate_micro(input: &str) -> Result<i32, String> {
    match parse_decimal(input, 6) {
        Some(micro @ 1_000_000..=3_000_000) if micro % 100 == 0 => Ok(micro as i32),
        _ => Err(
            "The USD → AZN rate must be a number from 1.0000 to 3.0000 with at most four decimals."
                .to_owned(),
        ),
    }
}

/// A blank price takes the product out of the shop (`Ok(None)`); "5", "5.00" and "0.06" read as
/// 500, 500 and 6 cents. At most two decimals; zero and negative prices are refused.
pub(crate) fn parse_usd_cents(input: &str) -> Result<Option<i32>, String> {
    if input.trim().is_empty() {
        return Ok(None);
    }
    match parse_decimal(input, 2) {
        Some(cents @ 1..=MAX_PRICE_CENTS) => Ok(Some(cents as i32)),
        Some(0) => Err("Price must be at least $0.01.".to_owned()),
        _ => Err(
            "Enter the price in dollars with at most two decimals, up to $100000.00.".to_owned(),
        ),
    }
}

/// A `datetime-local` value in Turkey time (UTC+3 all year) as a UTC timestamp for the API:
/// "2026-10-05T23:59" becomes "2026-10-05T20:59:00Z"; blank means no end.
pub(crate) fn turkey_local_to_utc(input: &str) -> Result<Option<String>, String> {
    let input = input.trim();
    if input.is_empty() {
        return Ok(None);
    }
    OffsetDateTime::parse(&format!("{input}:00+03:00"), &Rfc3339)
        .ok()
        .and_then(|at| at.to_offset(UtcOffset::UTC).format(&Rfc3339).ok())
        .map(Some)
        .ok_or_else(|| "Enter the campaign end as a date and time, or leave it blank.".to_owned())
}

/// 500 cents read as "$5.00"; display only, the API prices everything.
pub(crate) fn format_usd(cents: i32) -> String {
    format!("${}.{:02}", cents / 100, cents % 100)
}

/// An API timestamp in Turkey time, as the admin typed it: "5 Oct 23:59".
pub(crate) fn turkey_time_label(utc: &str) -> String {
    let Ok(at) = OffsetDateTime::parse(utc, &Rfc3339) else {
        return utc.to_owned();
    };
    let at = at.to_offset(UtcOffset::from_hms(3, 0, 0).expect("UTC+3 is a valid offset"));
    let month = at.month().to_string();
    format!(
        "{} {} {:02}:{:02}",
        at.day(),
        &month[..3],
        at.hour(),
        at.minute()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rate_reads_up_to_four_decimals_between_one_and_three() {
        assert_eq!(parse_rate_micro("1.7"), Ok(1_700_000));
        assert_eq!(parse_rate_micro("1.7000"), Ok(1_700_000));
        assert_eq!(parse_rate_micro("2"), Ok(2_000_000));
        assert_eq!(parse_rate_micro(" 1.7023 "), Ok(1_702_300));
        assert_eq!(parse_rate_micro("1.702300"), Ok(1_702_300));
        for input in [
            "0.017",
            "17",
            "abc",
            "",
            "1.7000001",
            "1.702345",
            "1.70001",
            "-1.7",
            "1e0",
        ] {
            assert!(parse_rate_micro(input).is_err(), "{input}");
        }
    }

    #[test]
    fn price_reads_dollars_and_blank_takes_the_product_out() {
        assert_eq!(parse_usd_cents(""), Ok(None));
        assert_eq!(parse_usd_cents("  "), Ok(None));
        assert_eq!(parse_usd_cents("5"), Ok(Some(500)));
        assert_eq!(parse_usd_cents("5.00"), Ok(Some(500)));
        assert_eq!(parse_usd_cents("0.06"), Ok(Some(6)));
        assert_eq!(parse_usd_cents("100000"), Ok(Some(10_000_000)));
        for input in ["0", "0.00", "-1", "5.001", "abc", "100000.01"] {
            assert!(parse_usd_cents(input).is_err(), "{input}");
        }
    }

    #[test]
    fn campaign_end_in_turkey_time_goes_to_the_api_in_utc() {
        assert_eq!(
            turkey_local_to_utc("2026-10-05T23:59"),
            Ok(Some("2026-10-05T20:59:00Z".to_owned()))
        );
        assert_eq!(
            turkey_local_to_utc("2026-01-01T01:00"),
            Ok(Some("2025-12-31T22:00:00Z".to_owned()))
        );
        assert_eq!(turkey_local_to_utc(""), Ok(None));
        for input in [
            "2026-13-01T00:00",
            "2026-10-05",
            "tomorrow",
            "2026-10-05T23:59:00Z",
        ] {
            assert!(turkey_local_to_utc(input).is_err(), "{input}");
        }
    }

    fn bundle_form(query: &str) -> Result<serde_json::Value, String> {
        bundle_body(&MultiValueForm::parse(query.as_bytes()))
    }

    fn items(count: usize) -> String {
        (1..=count)
            .map(|n| format!("item_ids={n}"))
            .collect::<Vec<_>>()
            .join("&")
    }

    #[test]
    fn bundle_takes_two_to_ten_different_items() {
        assert!(bundle_form(&format!("name=Set&{}", items(1))).is_err());
        assert_eq!(
            bundle_form(&format!("name=Set&{}", items(2))),
            Ok(json!({ "name": "Set", "description": null, "item_ids": ["1", "2"] }))
        );
        let ten = bundle_form(&format!("name=Set&{}", items(10))).unwrap();
        assert_eq!(ten["item_ids"].as_array().map(Vec::len), Some(10));
        assert!(bundle_form(&format!("name=Set&{}", items(11))).is_err());
        // A repeated item counts once, in the place it first appeared.
        assert_eq!(
            bundle_form("name=Set&item_ids=9&item_ids=5&item_ids=9").unwrap()["item_ids"],
            json!(["9", "5"])
        );
        assert!(bundle_form("name=Set&item_ids=5&item_ids=5").is_err());
        for bad in ["abc", "0", "-5", "1.5", "9223372036854775808"] {
            let form = format!("name=Set&item_ids=5&item_ids={bad}");
            assert!(bundle_form(&form).is_err(), "{bad}");
        }
    }

    #[test]
    fn bundle_name_is_one_to_sixty_four_and_a_blank_description_is_null() {
        let two = items(2);
        assert!(bundle_form(&format!("name=&{two}")).is_err());
        assert!(bundle_form(&format!("name=++&{two}")).is_err());
        assert!(bundle_form(&two).is_err());
        let long = "a".repeat(65);
        assert!(bundle_form(&format!("name={long}&{two}")).is_err());
        let longest = "ş".repeat(64);
        assert_eq!(
            bundle_form(&format!("name={longest}&{two}")).unwrap()["name"],
            json!(longest)
        );
        assert_eq!(
            bundle_form(&format!("name=+Set+&description=++&{two}")).unwrap(),
            json!({ "name": "Set", "description": null, "item_ids": ["1", "2"] })
        );
        assert_eq!(
            bundle_form(&format!("name=Set&description=+Night+set+&{two}")).unwrap()["description"],
            json!("Night set")
        );
        let description = "d".repeat(257);
        assert!(bundle_form(&format!("name=Set&description={description}&{two}")).is_err());
    }

    #[test]
    fn labels_show_dollars_and_turkey_time() {
        assert_eq!(format_usd(500), "$5.00");
        assert_eq!(format_usd(6), "$0.06");
        assert_eq!(turkey_time_label("2026-10-05T20:59:00.000Z"), "5 Oct 23:59");
        assert_eq!(turkey_time_label("2025-12-31T22:00:00Z"), "1 Jan 01:00");
    }
}
