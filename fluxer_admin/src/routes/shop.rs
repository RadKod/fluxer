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

// sanalyer: SetShopPricesRequest takes kuruş from 100 (₺1) to 10,000,000 (₺100.000).
const MIN_PRICE_KURUS: i64 = 100;
const MAX_PRICE_KURUS: i64 = 10_000_000;
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

// sanalyer: support starts from the order number the user or the payment provider shows.
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

// sanalyer: prices are set in lira directly, so there is no exchange rate to save.
async fn save_settings(client: &AdminApiClient, form: &MultiValueForm) -> FlashData {
    let Some(discount) = form
        .parse_u32("premium_discount_percent")
        .filter(|percent| *percent <= 95)
    else {
        return FlashData::error("Plus member discount must be 0–95.");
    };
    let body = json!({
        "premium_sales_open": form.bool_value("premium_sales_open"),
        "item_sales_open": form.bool_value("item_sales_open"),
        "premium_discount_percent": discount,
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
        let kurus = match parse_try_minor(input) {
            Ok(kurus) => kurus,
            Err(message) => return FlashData::error(format!("{sku}: {message}")),
        };
        let shown = parse_try_minor(form.first(&format!("was_{sku}")).unwrap_or(""));
        if Ok(kurus) != shown {
            changes.push(json!({ "sku": sku, "base_try_minor": kurus }));
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
    let kurus = match parse_try_minor(form.first("visionary_price").unwrap_or("")) {
        Ok(kurus) => kurus,
        Err(message) => return FlashData::error(message),
    };
    let body = json!({ "prices": [{ "sku": "visionary", "base_try_minor": kurus }] });
    match client.set_shop_prices(&body).await {
        Ok(()) => FlashData::success(match kurus {
            Some(kurus) => format!("Visionary price set to {}.", format_try(kurus)),
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

// sanalyer: "149,99" or "149.99" (Turkish keyboards type a comma) with at most two decimals, in kuruş.
// One separator at most, so "1.250" is refused rather than guessed as ₺1.25 or ₺1250.
fn parse_lira_decimal(input: &str) -> Option<i64> {
    let input = input.trim();
    let (whole, fraction) = input.split_once([',', '.']).unwrap_or((input, ""));
    let digits = |part: &str| part.bytes().all(|byte| byte.is_ascii_digit());
    if whole.is_empty() || fraction.len() > 2 || !digits(whole) || !digits(fraction) {
        return None;
    }
    let fraction: i64 = format!("{fraction:0<2}").parse().ok()?;
    whole
        .parse::<i64>()
        .ok()?
        .checked_mul(100)?
        .checked_add(fraction)
}

/// sanalyer: prices are Turkish lira. A blank price takes the product out of the shop (`Ok(None)`);
/// "150", "149,99", "149.99" and "149,5" read as 15000, 14999, 14999 and 14950 kuruş.
/// ₺1–₺100000 with at most two decimals, as SetShopPricesRequest takes.
pub(crate) fn parse_try_minor(input: &str) -> Result<Option<i32>, String> {
    if input.trim().is_empty() {
        return Ok(None);
    }
    match parse_lira_decimal(input) {
        Some(kurus @ MIN_PRICE_KURUS..=MAX_PRICE_KURUS) => Ok(Some(kurus as i32)),
        Some(_) => Err("Price must be from ₺1 to ₺100000.".to_owned()),
        None => Err(
            "Enter the price in lira with at most two decimals and no thousands separator, \
             e.g. 149,99."
                .to_owned(),
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

/// sanalyer: kuruş as the app shows them (Intl tr-TR, TRY, narrow symbol): a whole-lira price drops the
/// decimals, any other shows two, "." groups thousands. 15000 reads "₺150", 14999 "₺149,99",
/// 125000 "₺1.250". Display only, the API prices everything.
pub(crate) fn format_try(kurus: i32) -> String {
    format!("₺{}", lira_number(kurus, Some('.')))
}

/// kuruş as a price field shows them: "150" or "149,99", no symbol or thousands separator, so
/// parse_try_minor reads it back unchanged.
pub(crate) fn try_input_value(kurus: i32) -> String {
    lira_number(kurus, None)
}

fn lira_number(kurus: i32, group: Option<char>) -> String {
    let sign = if kurus < 0 { "-" } else { "" };
    let kurus = kurus.unsigned_abs();
    let whole = (kurus / 100).to_string();
    let mut grouped = String::new();
    for (index, digit) in whole.chars().enumerate() {
        if let Some(group) = group.filter(|_| index > 0 && (whole.len() - index) % 3 == 0) {
            grouped.push(group);
        }
        grouped.push(digit);
    }
    match kurus % 100 {
        0 => format!("{sign}{grouped}"),
        fraction => format!("{sign}{grouped},{fraction:02}"),
    }
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
    fn price_reads_lira_with_comma_or_dot_and_blank_takes_the_product_out() {
        assert_eq!(parse_try_minor(""), Ok(None));
        assert_eq!(parse_try_minor("  "), Ok(None));
        assert_eq!(parse_try_minor("150"), Ok(Some(15_000)));
        assert_eq!(parse_try_minor("149,99"), Ok(Some(14_999)));
        assert_eq!(parse_try_minor("149.99"), Ok(Some(14_999)));
        assert_eq!(parse_try_minor(" 149,5 "), Ok(Some(14_950)));
        assert_eq!(parse_try_minor("1"), Ok(Some(100)));
        assert_eq!(parse_try_minor("1,00"), Ok(Some(100)));
        assert_eq!(parse_try_minor("100000"), Ok(Some(10_000_000)));
        for input in [
            "0",
            "0,99",
            "0.5",
            "-1",
            "149,999",
            "1.250",
            "1.250,00",
            "abc",
            "100000,01",
            "₺150",
            "1e3",
            ",50",
        ] {
            assert!(parse_try_minor(input).is_err(), "{input}");
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
    fn labels_show_lira_and_turkey_time() {
        assert_eq!(format_try(15_000), "₺150");
        assert_eq!(format_try(14_999), "₺149,99");
        assert_eq!(format_try(14_950), "₺149,50");
        assert_eq!(format_try(125_000), "₺1.250");
        assert_eq!(format_try(10_000_000), "₺100.000");
        assert_eq!(format_try(123_456_789), "₺1.234.567,89");
        assert_eq!(format_try(6), "₺0,06");
        assert_eq!(try_input_value(15_000), "150");
        assert_eq!(try_input_value(14_999), "149,99");
        assert_eq!(try_input_value(125_000), "1250");
        for kurus in [100, 14_999, 15_000, 125_050, 10_000_000] {
            assert_eq!(parse_try_minor(&try_input_value(kurus)), Ok(Some(kurus)));
        }
        assert_eq!(turkey_time_label("2026-10-05T20:59:00.000Z"), "5 Oct 23:59");
        assert_eq!(turkey_time_label("2025-12-31T22:00:00Z"), "1 Jan 01:00");
    }
}
