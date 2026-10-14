// SPDX-License-Identifier: AGPL-3.0-or-later

use super::{ActionQuery, acl_forbidden, api_failure, form_snowflake};
use crate::{
    acl,
    api::client::{AdminApiClient, ApiError, ApiResultExt},
    middleware::{
        auth::AuthContext,
        csrf::CsrfToken,
        error_handler::AppError,
        flash::{self, FlashData},
    },
    state::AppState,
    templates::{
        self,
        pages::referral::{MonthCount, ReferralPageData, ReferralUserPageData},
    },
    utils::forms::MultiValueForm,
};
use axum::{
    Router,
    extract::{Path, Query, Request, State},
    response::{Html, IntoResponse, Response},
    routing::get,
};
use serde::Deserialize;
use serde_json::{Value, json};
use time::OffsetDateTime;

#[derive(Deserialize)]
struct ReferralQuery {
    month: Option<String>,
    cursor: Option<String>,
}

#[derive(Deserialize)]
struct UserQuery {
    cursor: Option<String>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/referral", get(referral_page).post(referral_post))
        .route("/referral/users/{user_id}", get(referral_user_page))
}

/// The API refuses a month that is not `YYYY-MM` and a cursor over 200 characters; a stale or
/// hand-edited link just starts from the first page of the current month.
pub(crate) fn valid_month(month: &str) -> bool {
    let bytes = month.as_bytes();
    bytes.len() == 7
        && bytes.iter().enumerate().all(|(at, byte)| {
            if at == 4 {
                *byte == b'-'
            } else {
                byte.is_ascii_digit()
            }
        })
        && (1..=12).contains(&month[5..].parse::<u8>().unwrap_or(0))
}

/// `YYYY-MM` of the month `now` is in and the `count - 1` before it, newest first.
pub(crate) fn last_months(now: OffsetDateTime, count: usize) -> Vec<String> {
    let mut months = Vec::with_capacity(count);
    let (mut year, mut month) = (now.year(), now.month() as i32);
    for _ in 0..count {
        months.push(format!("{year:04}-{month:02}"));
        month -= 1;
        if month == 0 {
            (year, month) = (year - 1, 12);
        }
    }
    months
}

fn valid_cursor(cursor: &str) -> bool {
    !cursor.is_empty() && cursor.len() <= 200
}

async fn referral_page(
    State(state): State<AppState>,
    auth: axum::Extension<AuthContext>,
    csrf: axum::Extension<CsrfToken>,
    flash: Option<axum::Extension<FlashData>>,
    Query(query): Query<ReferralQuery>,
) -> Response {
    let config = state.config();
    if let Some(response) = acl_forbidden(config, &auth.0, acl::REFERRAL_MANAGE) {
        return response;
    }
    let client = AdminApiClient::new(state.http_client(), config, &auth.0.session);
    let flash = flash.map(|flash| flash.0.to_flash_message());
    let month = query.month.as_deref().filter(|month| valid_month(month));
    let cursor = query
        .cursor
        .as_deref()
        .filter(|cursor| valid_cursor(cursor));
    let referral = client
        .get_referral()
        .await
        .log_error("load the referral settings");
    // The last three months are counted from their first page each; the month on show is read
    // with its cursor, or taken from the counting call when it is that same first page.
    let months = last_months(OffsetDateTime::now_utc(), 3);
    let selected = month.unwrap_or(&months[0]).to_owned();
    let (first, second, third) = tokio::join!(
        client.list_referral_pending_rewards(Some(&months[0]), None),
        client.list_referral_pending_rewards(Some(&months[1]), None),
        client.list_referral_pending_rewards(Some(&months[2]), None),
    );
    let mut pages: Vec<_> = [first, second, third]
        .into_iter()
        .map(|page| page.log_error("count the pending referral rewards"))
        .collect();
    let counts: Vec<_> = months
        .iter()
        .zip(&pages)
        .map(|(month, page)| MonthCount {
            month,
            // (waiting on the first page, more pages follow)
            count: page
                .as_ref()
                .map(|page| (page.items.len(), page.next_cursor.is_some())),
        })
        .collect();
    let pending = match months
        .iter()
        .position(|month| *month == selected)
        .filter(|_| cursor.is_none())
    {
        Some(at) => pages[at].take(),
        None => client
            .list_referral_pending_rewards(Some(&selected), cursor)
            .await
            .log_error("list the pending referral rewards"),
    };
    // Item names and the decoration picker need COSMETICS_MANAGE; without it a cosmetic reward
    // shows its item ID and no new one can be picked.
    let admin_acls = auth
        .0
        .admin_user
        .as_ref()
        .map(|user| user.acls.as_slice())
        .unwrap_or(&[]);
    let items = if acl::has_permission(admin_acls, acl::COSMETICS_MANAGE) {
        client
            .list_cosmetic_items()
            .await
            .log_error("list cosmetic items")
    } else {
        None
    };
    let markup = templates::pages::referral::referral_page(
        config,
        &auth.0,
        &csrf.0.0,
        flash.as_ref(),
        &ReferralPageData {
            referral: referral.as_ref(),
            pending: pending.as_ref(),
            items: items.as_deref(),
            month: &selected,
            months: &counts,
        },
    );
    Html(markup.into_string()).into_response()
}

async fn referral_user_page(
    State(state): State<AppState>,
    auth: axum::Extension<AuthContext>,
    flash: Option<axum::Extension<FlashData>>,
    Path(user_id): Path<String>,
    Query(query): Query<UserQuery>,
) -> Response {
    let config = state.config();
    if let Some(response) = acl_forbidden(config, &auth.0, acl::REFERRAL_MANAGE) {
        return response;
    }
    if user_id.parse::<u64>().is_err() {
        return AppError::not_found("User not found.", &config.base_path).into_response();
    }
    let client = AdminApiClient::new(state.http_client(), config, &auth.0.session);
    let flash = flash.map(|flash| flash.0.to_flash_message());
    let cursor = query
        .cursor
        .as_deref()
        .filter(|cursor| valid_cursor(cursor));
    let referrals = client
        .get_user_referrals(&user_id, cursor)
        .await
        .log_error("load the user's referrals");
    let markup = templates::pages::referral::referral_user_page(
        config,
        &auth.0,
        flash.as_ref(),
        &ReferralUserPageData {
            user_id: &user_id,
            referrals: referrals.as_ref(),
        },
    );
    Html(markup.into_string()).into_response()
}

async fn referral_post(
    State(state): State<AppState>,
    auth: axum::Extension<AuthContext>,
    Query(aq): Query<ActionQuery>,
    request: Request,
) -> Response {
    let config = state.config();
    if let Some(response) = acl_forbidden(config, &auth.0, acl::REFERRAL_MANAGE) {
        return response;
    }
    let mut target = format!("{}/referral", config.base_path);
    let flash = match MultiValueForm::from_request(request).await {
        None => FlashData::error("Invalid form data"),
        Some(form) => {
            // Back to the month the admin was looking at.
            if let Some(month) = form.first("month").filter(|month| valid_month(month)) {
                target = format!("{target}?month={month}");
            }
            let client = AdminApiClient::new(state.http_client(), config, &auth.0.session);
            match aq.action.as_deref().unwrap_or("") {
                "settings" => save_settings(&client, &form).await,
                "tier_create" => create_tier(&client, &form).await,
                "tier_update" => update_tier(&client, &form).await,
                "tier_toggle" => toggle_tier(&client, &form).await,
                "deliver" => deliver_reward(&client, &form).await,
                "notify" => notify_reward(&client, &form).await,
                _ => FlashData::error("Unknown referral action"),
            }
        }
    };
    flash::redirect_with_flash(&target, flash, config.secure_cookies())
}

async fn save_settings(client: &AdminApiClient, form: &MultiValueForm) -> FlashData {
    let in_range = |key: &str, max: u32| form.parse_u32(key).filter(|n| (1..=max).contains(n));
    let (Some(days), Some(cap), Some(ip_limit)) = (
        in_range("min_active_days", 30),
        in_range("daily_valid_cap", 10_000),
        in_range("ip_registration_limit", 100),
    ) else {
        return FlashData::error(
            "Active days take 1–30, the daily cap 1–10000 and the sign-ups per IP 1–100.",
        );
    };
    let body = json!({
        "enabled": form.bool_value("enabled"),
        "min_active_days": days,
        "daily_valid_cap": cap,
        "ip_registration_limit": ip_limit,
    });
    match client.update_referral_settings(&body).await {
        Ok(()) => FlashData::success("Referral settings saved."),
        Err(error) => api_failure("save the referral settings", &error),
    }
}

fn threshold_of(form: &MultiValueForm) -> Result<u32, String> {
    form.parse_u32("threshold")
        .filter(|n| (1..=1_000_000).contains(n))
        .ok_or_else(|| "The threshold takes 1–1000000 valid referrals.".to_owned())
}

/// The add-tier form as the API body: a threshold of 1–1,000,000 and one reward of the chosen type.
/// The fields of the other reward types stay in the form and are ignored.
pub(crate) fn tier_body(form: &MultiValueForm) -> Result<Value, String> {
    let threshold = threshold_of(form)?;
    let reward = match form.first("reward_type").unwrap_or("") {
        "cosmetic" => match form_snowflake(form, "item_id").filter(|id| id != "0") {
            Some(item_id) => json!({ "type": "cosmetic", "item_id": item_id }),
            None => return Err("Pick the decoration from the list.".to_owned()),
        },
        "premium_days" => match form.parse_u32("days").filter(|n| (1..=3650).contains(n)) {
            Some(days) => json!({ "type": "premium_days", "days": days }),
            None => return Err("Plus days take 1–3650.".to_owned()),
        },
        "offsite" => match form.clean("description") {
            // Counted in UTF-16 units, as the API counts them.
            Some(text) if text.encode_utf16().count() <= 200 => {
                json!({ "type": "offsite", "description": text })
            }
            _ => return Err("Describe the off-site reward in 1–200 characters.".to_owned()),
        },
        _ => return Err("Pick a reward type.".to_owned()),
    };
    Ok(json!({
        "threshold": threshold,
        "reward": reward,
        "enabled": form.bool_value("enabled"),
    }))
}

async fn create_tier(client: &AdminApiClient, form: &MultiValueForm) -> FlashData {
    let body = match tier_body(form) {
        Ok(body) => body,
        Err(message) => return FlashData::error(message),
    };
    match client.create_referral_tier(&body).await {
        Ok(()) => FlashData::success("Tier added."),
        Err(error) => api_failure("add the tier", &error),
    }
}

// A tier's reward cannot change (members already earned it): the edit form sends the threshold
// and the switch only. A different reward is a new tier, with the old one turned off.
async fn update_tier(client: &AdminApiClient, form: &MultiValueForm) -> FlashData {
    let Some(tier_id) = form_snowflake(form, "tier_id") else {
        return FlashData::error("Unknown tier.");
    };
    let threshold = match threshold_of(form) {
        Ok(threshold) => threshold,
        Err(message) => return FlashData::error(message),
    };
    let body = json!({ "threshold": threshold, "enabled": form.bool_value("enabled") });
    match client.update_referral_tier(&tier_id, &body).await {
        Ok(()) => FlashData::success("Tier saved."),
        Err(error) => api_failure("save the tier", &error),
    }
}

async fn toggle_tier(client: &AdminApiClient, form: &MultiValueForm) -> FlashData {
    let Some(tier_id) = form_snowflake(form, "tier_id") else {
        return FlashData::error("Unknown tier.");
    };
    let enabled = form.bool_value("enabled");
    match client
        .update_referral_tier(&tier_id, &json!({ "enabled": enabled }))
        .await
    {
        Ok(()) if enabled => FlashData::success("Tier turned on."),
        Ok(()) => FlashData::success("Tier turned off."),
        Err(error) => api_failure("change the tier", &error),
    }
}

fn reward_target(form: &MultiValueForm) -> Option<(String, String)> {
    Some((
        form_snowflake(form, "user_id")?,
        form_snowflake(form, "tier_id")?,
    ))
}

// The pasted code goes to the API and nowhere else: not into the flash, the redirect or a log line.
async fn deliver_reward(client: &AdminApiClient, form: &MultiValueForm) -> FlashData {
    let Some((user_id, tier_id)) = reward_target(form) else {
        return FlashData::error("Unknown reward.");
    };
    let code = form.clean("code");
    let note = form.clean("note");
    if code
        .as_deref()
        .is_some_and(|code| code.encode_utf16().count() > 256)
    {
        return FlashData::error("The code takes at most 256 characters.");
    }
    if note
        .as_deref()
        .is_some_and(|note| note.encode_utf16().count() > 500)
    {
        return FlashData::error("The note takes at most 500 characters.");
    }
    let has_code = code.is_some();
    let body = json!({ "code": code, "note": note });
    match client
        .deliver_referral_reward(&user_id, &tier_id, &body)
        .await
    {
        Ok(()) if has_code => {
            FlashData::success("Reward delivered. The user was told it is ready.")
        }
        Ok(()) => FlashData::success("Reward marked delivered."),
        Err(error) => api_failure("deliver the reward", &error),
    }
}

async fn notify_reward(client: &AdminApiClient, form: &MultiValueForm) -> FlashData {
    let Some((user_id, tier_id)) = reward_target(form) else {
        return FlashData::error("Unknown reward.");
    };
    let Some(content) = form
        .clean("content")
        .filter(|content| content.encode_utf16().count() <= 2000)
    else {
        return FlashData::error("The notice takes 1–2000 characters.");
    };
    match client
        .notify_referral_reward(&user_id, &tier_id, &json!({ "content": content }))
        .await
    {
        Ok(()) => FlashData::success("Notice sent. The reward still waits for delivery."),
        // The API refuses a notice that contains the stored code.
        Err(ApiError::Http { status: 400, .. }) => {
            FlashData::error("The notice was refused: it must not contain the reward code.")
        }
        Err(error) => api_failure("send the notice", &error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::{Date, Month};

    fn at(year: i32, month: Month, day: u8) -> OffsetDateTime {
        Date::from_calendar_date(year, month, day)
            .unwrap()
            .midnight()
            .assume_utc()
    }

    #[test]
    fn last_months_counts_back_across_the_year_end() {
        assert_eq!(
            last_months(at(2026, Month::October, 15), 3),
            ["2026-10", "2026-09", "2026-08"]
        );
        assert_eq!(
            last_months(at(2027, Month::January, 31), 3),
            ["2027-01", "2026-12", "2026-11"]
        );
    }

    #[test]
    fn month_must_be_year_dash_month() {
        for ok in ["2026-10", "2026-01", "2026-12"] {
            assert!(valid_month(ok), "{ok}");
        }
        for bad in [
            "2026-13",
            "2026-00",
            "2026-1",
            "202610",
            "oct",
            "2026-+1",
            "２０２６-10",
            "",
        ] {
            assert!(!valid_month(bad), "{bad}");
        }
    }
}
