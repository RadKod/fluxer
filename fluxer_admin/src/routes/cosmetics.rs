// SPDX-License-Identifier: AGPL-3.0-or-later

use super::{ActionQuery, acl_forbidden, api_failure, form_snowflake};
use crate::{
    acl,
    api::client::{AdminApiClient, ApiResultExt},
    middleware::{
        auth::AuthContext,
        csrf::CsrfToken,
        flash::{self, FlashData},
    },
    state::AppState,
    templates::{
        self,
        pages::cosmetics::{ULTRA_COLUMNS, ULTRA_SURFACES},
    },
    utils::forms::{MultiValueForm, clean_string},
};
use axum::{
    Router, body,
    extract::{Query, Request, State},
    response::{Html, IntoResponse, Response},
    routing::get,
};
use serde::Deserialize;
use serde_json::{Map, Value, json};

const ITEM_TYPES: &[&str] = &[
    "avatar_decoration",
    "avatar_ultra",
    "profile_effect",
    "nameplate",
];
const AVAILABILITIES: &[&str] = &["free", "premium", "owned"];
// Micup (angel-wings): a full in-front set (closed + up to 30 frames + loop) reaches about 3.07 MB
// once base64 and URL encoded. Only this route needs the larger body; the shared admin form reader
// stays at 1 MiB.
const COSMETIC_FORM_MAX_BYTES: usize = 3 * 1024 * 1024;
const AUDIT_REASON_MAX_CHARS: usize = 512;
const ULTRA_NUMBER_ERROR: &str =
    "Sizes take 0.50-6.00 and offsets -3.00-3.00, with at most two decimals";

#[derive(Deserialize)]
struct CosmeticsQuery {
    edit: Option<String>,
    ultra: Option<String>,
    // sanalyer: catalog search over name, series and ID.
    q: Option<String>,
}

pub fn router() -> Router<AppState> {
    Router::new().route("/cosmetics", get(cosmetics_page).post(cosmetics_post))
}

async fn cosmetics_page(
    State(state): State<AppState>,
    auth: axum::Extension<AuthContext>,
    csrf: axum::Extension<CsrfToken>,
    flash: Option<axum::Extension<FlashData>>,
    Query(query): Query<CosmeticsQuery>,
) -> Response {
    let config = state.config();
    if let Some(response) = acl_forbidden(config, &auth.0, acl::COSMETICS_MANAGE) {
        return response;
    }
    let client = AdminApiClient::new(state.http_client(), config, &auth.0.session);
    let items = client
        .list_cosmetic_items()
        .await
        .log_error("list cosmetic items");
    let flash = flash.map(|flash| flash.0.to_flash_message());
    let markup = templates::pages::cosmetics::cosmetics_page(
        config,
        &auth.0,
        &csrf.0.0,
        flash.as_ref(),
        items.as_deref(),
        query.edit.as_deref(),
        query.ultra.as_deref(),
        query.q.as_deref().map(str::trim).filter(|q| !q.is_empty()),
    );
    Html(markup.into_string()).into_response()
}

async fn cosmetics_post(
    State(state): State<AppState>,
    auth: axum::Extension<AuthContext>,
    Query(aq): Query<ActionQuery>,
    request: Request,
) -> Response {
    let config = state.config();
    if let Some(response) = acl_forbidden(config, &auth.0, acl::COSMETICS_MANAGE) {
        return response;
    }
    let flash = match body::to_bytes(request.into_body(), COSMETIC_FORM_MAX_BYTES).await {
        Err(_) => FlashData::error("Invalid form data"),
        Ok(bytes) => {
            let form = MultiValueForm::parse(bytes.as_ref());
            let client = AdminApiClient::new(state.http_client(), config, &auth.0.session);
            match aq.action.as_deref().unwrap_or("") {
                "create" => create_item(&client, &form).await,
                "update" => update_item(&client, &form).await,
                "retire" => retire_item(&client, &form).await,
                "grant" => set_user_item(&client, &form, true).await,
                "revoke" => set_user_item(&client, &form, false).await,
                "ultra" => save_ultra_layout(&client, &form, false).await,
                "ultra_reset" => save_ultra_layout(&client, &form, true).await,
                "ultra_front" => {
                    let body = front_body(bytes.as_ref());
                    patch_item(&client, &form, body, "now opens in front").await
                }
                "ultra_front_reset" => {
                    let body = Ok(json!({"ultra_front": null}));
                    patch_item(&client, &form, body, "is drawn behind again").await
                }
                "relist" => {
                    let body = Ok(json!({"on_sale": true}));
                    patch_item(&client, &form, body, "is back on sale as an owned item").await
                }
                _ => FlashData::error("Unknown cosmetics action"),
            }
        }
    };
    flash::redirect_with_flash(
        &format!("{}/cosmetics", config.base_path),
        flash,
        config.secure_cookies(),
    )
}

fn choice(form: &MultiValueForm, key: &str, allowed: &[&str]) -> Option<String> {
    form.clean(key)
        .filter(|value| allowed.contains(&value.as_str()))
}

async fn create_item(client: &AdminApiClient, form: &MultiValueForm) -> FlashData {
    let (Some(item_type), Some(name), Some(availability), Some(asset)) = (
        choice(form, "type", ITEM_TYPES),
        form.clean("name"),
        choice(form, "availability", AVAILABILITIES),
        form.clean("asset"),
    ) else {
        return FlashData::error("Type, name, availability and image are required");
    };
    let body = json!({
        "type": item_type,
        "name": name,
        "description": form.clean("description"),
        "series": form.clean("series"),
        "availability": availability,
        "asset": asset,
    });
    match client.create_cosmetic_item(&body).await {
        Ok(item) => FlashData::success(format!("Cosmetic item {} created", item.id)),
        Err(error) => api_failure("create the cosmetic item", &error),
    }
}

async fn update_item(client: &AdminApiClient, form: &MultiValueForm) -> FlashData {
    let Some(item_id) = form_snowflake(form, "item_id") else {
        return FlashData::error("A valid item ID is required");
    };
    let mut body = Map::new();
    for key in ["name", "description", "series", "asset"] {
        if let Some(value) = form.clean(key) {
            body.insert(key.to_owned(), Value::String(value));
        }
    }
    if let Some(value) = choice(form, "availability", AVAILABILITIES) {
        body.insert("availability".to_owned(), Value::String(value));
    }
    if body.is_empty() {
        return FlashData::error("Fill in at least one field to change");
    }
    match client
        .update_cosmetic_item(&item_id, &Value::Object(body))
        .await
    {
        Ok(_) => FlashData::success(format!("Cosmetic item {item_id} updated")),
        Err(error) => api_failure("update the cosmetic item", &error),
    }
}

async fn retire_item(client: &AdminApiClient, form: &MultiValueForm) -> FlashData {
    let Some(item_id) = form_snowflake(form, "item_id") else {
        return FlashData::error("A valid item ID is required");
    };
    match client.retire_cosmetic_item(&item_id).await {
        Ok(()) => FlashData::success(format!("Cosmetic item {item_id} taken off sale")),
        Err(error) => api_failure("take the cosmetic item off sale", &error),
    }
}

// Micup (shop): the reason travels as the X-Audit-Log-Reason header, which carries one line of
// printable ASCII only; anything else would fail inside the API client with a vague error.
pub(crate) fn audit_reason(form: &MultiValueForm) -> Result<String, &'static str> {
    let Some(reason) = form.clean("audit_log_reason") else {
        return Err("A reason is required");
    };
    if !reason.chars().all(|c| c == ' ' || c.is_ascii_graphic()) {
        return Err("Write the reason on one line in plain ASCII, without Turkish letters");
    }
    if reason.len() > AUDIT_REASON_MAX_CHARS {
        return Err("The reason takes at most 512 characters");
    }
    Ok(reason)
}

async fn set_user_item(client: &AdminApiClient, form: &MultiValueForm, grant: bool) -> FlashData {
    let (Some(user_id), Some(item_id)) = (
        form_snowflake(form, "user_id"),
        form_snowflake(form, "item_id"),
    ) else {
        return FlashData::error("A valid user ID and item are required");
    };
    let reason = match audit_reason(form) {
        Ok(reason) => reason,
        Err(message) => return FlashData::error(message),
    };
    let result = if grant {
        client
            .grant_user_cosmetic(&user_id, &item_id, &reason)
            .await
    } else {
        client
            .revoke_user_cosmetic(&user_id, &item_id, &reason)
            .await
    };
    let change = match result {
        Ok(change) => change,
        Err(error) if grant => return api_failure("give the item", &error),
        Err(error) => return api_failure("take the item back", &error),
    };
    let name = item_name(client, &item_id).await;
    match (grant, change.changed, change.unequipped) {
        (true, true, _) => FlashData::success(format!("Gave {name} to {user_id}.")),
        (true, false, _) => FlashData::info(format!("User already owns {name}.")),
        (false, true, true) => FlashData::success(format!(
            "Took {name} back from {user_id}; it was worn and has been taken off."
        )),
        (false, true, false) => FlashData::success(format!("Took {name} back from {user_id}.")),
        (false, false, _) => FlashData::info("User does not own this item."),
    }
}

async fn item_name(client: &AdminApiClient, item_id: &str) -> String {
    client
        .list_cosmetic_items()
        .await
        .log_error("list cosmetic items")
        .and_then(|items| items.into_iter().find(|item| item.id == item_id))
        .map_or_else(|| format!("item {item_id}"), |item| item.name)
}

async fn save_ultra_layout(
    client: &AdminApiClient,
    form: &MultiValueForm,
    reset: bool,
) -> FlashData {
    let Some(item_id) = form_snowflake(form, "item_id") else {
        return FlashData::error("A valid item ID is required");
    };
    let layout = if reset {
        Value::Null
    } else {
        match parse_ultra_layout(form) {
            Ok(layout) => layout,
            Err(message) => return FlashData::error(message),
        }
    };
    match client.update_ultra_layout(&item_id, &layout).await {
        Ok(item) if reset => {
            FlashData::success(format!("{} uses the default sizes again", item.name))
        }
        Ok(item) => FlashData::success(format!("Saved the sizes of {}", item.name)),
        Err(error) => api_failure("save the ultra sizes", &error),
    }
}

// Micup (angel-wings): one PATCH of the item; the message names the item the API answered with.
async fn patch_item(
    client: &AdminApiClient,
    form: &MultiValueForm,
    body: Result<Value, String>,
    done: &str,
) -> FlashData {
    let Some(item_id) = form_snowflake(form, "item_id") else {
        return FlashData::error("A valid item ID is required");
    };
    let body = match body {
        Ok(body) => body,
        Err(message) => return FlashData::error(message),
    };
    match client.update_cosmetic_item(&item_id, &body).await {
        Ok(item) => FlashData::success(format!("{} {done}", item.name)),
        Err(error) => api_failure("update the cosmetic item", &error),
    }
}

// Micup (angel-wings): the frames are data URLs, which hold a comma that
// MultiValueForm::list_values splits on, so they are read from the body as sent. A blank frame is
// one the browser had not finished reading: the set is refused rather than saved with a step missing.
pub(crate) fn front_body(body: &[u8]) -> Result<Value, String> {
    let (mut closed, mut idle, mut open) = (None, None, Vec::new());
    for (key, value) in url::form_urlencoded::parse(body) {
        match key.as_ref() {
            "closed" if closed.is_none() => closed = Some(clean_string(&value)),
            "idle" if idle.is_none() => idle = Some(clean_string(&value)),
            "open" => open.push(clean_string(&value)),
            _ => {}
        }
    }
    let (Some(Some(closed)), Some(Some(idle))) = (closed, idle) else {
        return Err(
            "The closed frame, the opening frames and the loop are all required".to_owned(),
        );
    };
    let Some(open) = open.into_iter().collect::<Option<Vec<_>>>() else {
        return Err(
            "An opening frame was still loading or empty; pick the frames again".to_owned(),
        );
    };
    if !(2..=30).contains(&open.len()) {
        return Err("Upload 2-30 opening frames".to_owned());
    }
    Ok(json!({"ultra_front": {"closed": closed, "open": open, "idle": idle}}))
}

// Micup (shop): a blank surface is null, so the client keeps today's fixed size for it.
pub(crate) fn parse_ultra_layout(form: &MultiValueForm) -> Result<Value, String> {
    let mut layout = Map::new();
    for (surface, label, _) in ULTRA_SURFACES {
        let [width, height, offset_x, offset_y] =
            ULTRA_COLUMNS.map(|(number, _)| form.clean(&format!("{surface}_{number}")));
        let value = match (width, height, offset_x, offset_y) {
            (None, None, None, None) => Value::Null,
            (Some(width), Some(height), Some(offset_x), Some(offset_y)) => json!({
                "width": ultra_number(&width, 50, 600)?,
                "height": ultra_number(&height, 50, 600)?,
                "offset_x": ultra_number(&offset_x, -300, 300)?,
                "offset_y": ultra_number(&offset_y, -300, 300)?,
            }),
            _ => return Err(format!("Fill all four numbers of {label} or none")),
        };
        layout.insert((*surface).to_owned(), value);
    }
    Ok(Value::Object(layout))
}

// Plain decimals only ("2.3", "-0.25"): exponents, NaN and a leading "+" are refused. The limits
// are checked in hundredths so 0.50 and 6.00 are exact.
fn ultra_number(input: &str, min: i32, max: i32) -> Result<f64, String> {
    let digits = input.strip_prefix('-').unwrap_or(input);
    let (whole, fraction) = digits.split_once('.').unwrap_or((digits, ""));
    let plain = (1..=2).contains(&whole.len())
        && fraction.len() <= 2
        && whole
            .bytes()
            .chain(fraction.bytes())
            .all(|byte| byte.is_ascii_digit());
    let hundredths: i32 = match format!("{whole}{fraction:0<2}").parse() {
        Ok(value) if plain => value,
        _ => return Err(ULTRA_NUMBER_ERROR.to_owned()),
    };
    let value = if digits.len() < input.len() {
        -hundredths
    } else {
        hundredths
    };
    if (min..=max).contains(&value) {
        Ok(f64::from(value) / 100.0)
    } else {
        Err(ULTRA_NUMBER_ERROR.to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::{front_body, parse_ultra_layout};
    use crate::utils::forms::MultiValueForm;
    use serde_json::json;

    const NUMBER_ERROR: &str =
        "Sizes take 0.50-6.00 and offsets -3.00-3.00, with at most two decimals";
    const REQUIRED_ERROR: &str =
        "The closed frame, the opening frames and the loop are all required";
    const FRAMES_ERROR: &str = "Upload 2-30 opening frames";
    const BLANK_FRAME_ERROR: &str =
        "An opening frame was still loading or empty; pick the frames again";
    const CLOSED: &str = "data:image/webp;base64,Q0xPU0VE";
    const IDLE: &str = "data:image/webp;base64,SURMRQ==";
    const FRAME: &str = "data:image/webp;base64,RlJBTUU=";

    fn form(body: &str) -> MultiValueForm {
        MultiValueForm::parse(body.as_bytes())
    }

    fn front_form(open: &[&str]) -> String {
        let frames: String = open
            .iter()
            .map(|frame| format!("&open={}", urlencoding::encode(frame)))
            .collect();
        format!(
            "item_id=7&closed={}{frames}&idle={}",
            urlencoding::encode(CLOSED),
            urlencoding::encode(IDLE)
        )
    }

    #[test]
    fn a_full_set_becomes_one_ultra_front_body() {
        // Data URLs hold a comma; each one stays whole, in form order.
        let open = ["data:image/webp;base64,MDE=", "data:image/webp;base64,MDA="];
        assert_eq!(
            front_body(front_form(&open).as_bytes()),
            Ok(json!({"ultra_front": {"closed": CLOSED, "open": open, "idle": IDLE}}))
        );
    }

    #[test]
    fn thirty_frames_pass_one_and_thirty_one_are_refused() {
        let body = front_body(front_form(&[FRAME; 30]).as_bytes()).expect("30 frames are valid");
        assert_eq!(
            body["ultra_front"]["open"].as_array().map(Vec::len),
            Some(30)
        );
        for count in [0, 1, 31] {
            assert_eq!(
                front_body(front_form(&vec![FRAME; count]).as_bytes()),
                Err(FRAMES_ERROR.to_owned()),
                "{count} frames"
            );
        }
    }

    // A frame the browser had not finished reading arrives blank; saving the others would ship an
    // opening with a missing step, so the whole set is refused.
    #[test]
    fn a_blank_frame_is_refused_rather_than_dropped() {
        for blank in ["&open=", "&open=+"] {
            let body = format!("{}{blank}", front_form(&[FRAME, FRAME]));
            assert_eq!(
                front_body(body.as_bytes()),
                Err(BLANK_FRAME_ERROR.to_owned()),
                "{blank}"
            );
        }
    }

    #[test]
    fn closed_and_loop_are_required() {
        let frames = format!("&open={0}&open={0}", urlencoding::encode(FRAME));
        for body in [
            format!("item_id=7{frames}&idle=a"),
            format!("item_id=7&closed=a{frames}"),
            format!("item_id=7&closed=+{frames}&idle=a"),
        ] {
            assert_eq!(
                front_body(body.as_bytes()),
                Err(REQUIRED_ERROR.to_owned()),
                "{body}"
            );
        }
    }

    #[test]
    fn blank_surfaces_are_null() {
        assert_eq!(
            parse_ultra_layout(&form("item_id=7&compact_width=&voice_height=+")),
            Ok(json!({"compact": null, "voice": null, "profile": null}))
        );
    }

    #[test]
    fn a_filled_surface_is_sent_in_multiples() {
        let layout = parse_ultra_layout(&form(
            "profile_width=3.4&profile_height=3.40&profile_offset_x=-0.25&profile_offset_y=3",
        ));
        assert_eq!(
            layout,
            Ok(json!({
                "compact": null,
                "voice": null,
                "profile": {"width": 3.4, "height": 3.4, "offset_x": -0.25, "offset_y": 3.0}
            }))
        );
    }

    #[test]
    fn the_limits_themselves_are_accepted() {
        let layout = parse_ultra_layout(&form(
            "voice_width=0.5&voice_height=6&voice_offset_x=-3&voice_offset_y=3.00",
        ))
        .expect("limits are valid");
        assert_eq!(
            layout["voice"],
            json!({"width": 0.5, "height": 6.0, "offset_x": -3.0, "offset_y": 3.0})
        );
    }

    #[test]
    fn a_half_filled_surface_is_refused() {
        assert_eq!(
            parse_ultra_layout(&form(
                "compact_width=2.30&compact_height=2.30&compact_offset_x=0"
            )),
            Err("Fill all four numbers of Chat and member list or none".to_owned())
        );
    }

    #[test]
    fn numbers_outside_the_limits_or_not_plain_decimals_are_refused() {
        let bad = [
            ("width", "0.49"),
            ("width", "6.01"),
            ("height", "1.234"),
            ("offset_x", "-3.01"),
            ("offset_y", "3.5"),
            ("width", "abc"),
            ("width", "1e2"),
            ("width", "NaN"),
            ("height", "+2"),
            ("offset_x", "--1"),
        ];
        for (key, value) in bad {
            let body = ["width", "height", "offset_x", "offset_y"]
                .iter()
                .map(|number| {
                    let number_value = if *number == key { value } else { "1" };
                    format!("voice_{number}={}", urlencoding::encode(number_value))
                })
                .collect::<Vec<_>>()
                .join("&");
            assert_eq!(
                parse_ultra_layout(&form(&body)),
                Err(NUMBER_ERROR.to_owned()),
                "{key}={value}"
            );
        }
    }
}
