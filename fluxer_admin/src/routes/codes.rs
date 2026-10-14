// SPDX-License-Identifier: AGPL-3.0-or-later

use crate::{
    acl,
    api::{
        client::{AdminApiClient, ApiError, ApiResultExt},
        generated::types::GiftCodeDurationTypeSchema,
        types::{CosmeticItem, PremiumMode},
    },
    middleware::{
        auth::AuthContext,
        csrf::CsrfToken,
        flash::{self, FlashData},
    },
    state::AppState,
    templates::{
        self,
        pages::gift_codes::{GeneratedGiftCodes, GiftCodesPremium, MAX_GIFT_CODES},
    },
};
use axum::{
    Form, Router,
    extract::{FromRequest, Request, State},
    http::header,
    response::{Html, IntoResponse, Redirect, Response},
    routing::get,
};
use serde::Deserialize;
use std::time::{Duration, Instant};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

// The API issues at most this many codes per call (MAX_GIFT_CODES_PER_REQUEST).
const GIFT_CODES_PER_API_CALL: u32 = 100;
// No new API call starts after this, so a proxy timeout never swallows codes that already exist.
const GENERATION_TIME_BUDGET: Duration = Duration::from_secs(60);
const CSV_HEADER: &str = "code,url,duration_type,duration_quantity,created_at\n";
// Item codes: an item code row names the item instead of a duration.
const ITEM_CSV_HEADER: &str = "code,url,item_id,item_name,created_at\n";

#[derive(Deserialize)]
struct GiftCodesForm {
    #[serde(default)]
    _csrf: Option<String>,
    #[serde(default)]
    count: Option<u32>,
    #[serde(default)]
    duration_type: Option<GiftCodeDurationTypeSchema>,
    #[serde(default)]
    duration_quantity: Option<u32>,
    #[serde(default)]
    format: Option<String>,
    // Item codes: "cosmetic" issues item codes; anything else keeps the premium form.
    #[serde(default)]
    gives: Option<String>,
    #[serde(default)]
    item_id: Option<String>,
}

struct GeneratedCode {
    url: String,
    created_at: String,
}

// Item codes: what every code of one batch gives.
enum CodeGrant<'a> {
    Premium(GiftCodeDurationTypeSchema, u32),
    Item(&'a CosmeticItem),
}

pub fn router() -> Router<AppState> {
    Router::new().route("/gift-codes", get(gift_codes_page).post(gift_codes_post))
}

// Gift codes: a self-hosted instance issues gift codes only in premium_mode mirror; a failed lookup stays closed.
async fn gift_codes_available(client: &AdminApiClient, self_hosted: bool) -> bool {
    if !self_hosted {
        return true;
    }
    match client.get_instance_config().await {
        Ok(instance) => matches!(instance.policy.premium_mode, PremiumMode::Mirror),
        Err(error) => {
            tracing::warn!(%error, "admin API request failed: load premium mode");
            false
        }
    }
}

// Item codes: item codes also need COSMETICS_MANAGE. Without it, when the catalog does not
// load or when no item is sold as owned only, the page offers premium codes alone.
async fn code_items(client: &AdminApiClient, auth: &AuthContext) -> Option<Vec<CosmeticItem>> {
    let admin_acls = auth
        .admin_user
        .as_ref()
        .map(|user| user.acls.as_slice())
        .unwrap_or(&[]);
    if !acl::has_permission(admin_acls, acl::COSMETICS_MANAGE) {
        return None;
    }
    let items: Vec<CosmeticItem> = client
        .list_cosmetic_items()
        .await
        .log_error("list cosmetic items")?
        .into_iter()
        .filter(|item| item.availability == "owned")
        .collect();
    (!items.is_empty()).then_some(items)
}

async fn gift_codes_page(
    State(state): State<AppState>,
    auth: axum::Extension<AuthContext>,
    csrf: axum::Extension<CsrfToken>,
    flash: Option<axum::Extension<FlashData>>,
) -> Response {
    let config = state.config();
    let client = AdminApiClient::new(state.http_client(), config, &auth.0.session);
    if !gift_codes_available(&client, config.self_hosted).await {
        return Redirect::to(&format!("{}/dashboard", config.base_path)).into_response();
    }
    let items = code_items(&client, &auth.0).await;
    let flash = flash.map(|flash| flash.0.to_flash_message());
    let premium = GiftCodesPremium::from_branding(
        config.self_hosted,
        state.premium_branding(&client).await.as_ref(),
    );

    let markup = templates::pages::gift_codes::gift_codes_page(
        config,
        &auth.0,
        &csrf.0.0,
        flash.as_ref(),
        None,
        items.as_deref(),
        &premium,
    );
    Html(markup.into_string()).into_response()
}

async fn gift_codes_post(
    State(state): State<AppState>,
    auth: axum::Extension<AuthContext>,
    csrf: axum::Extension<CsrfToken>,
    request: Request,
) -> Response {
    let config = state.config();
    let base = &config.base_path;
    let client = AdminApiClient::new(state.http_client(), config, &auth.0.session);
    if !gift_codes_available(&client, config.self_hosted).await {
        return Redirect::to(&format!("{base}/dashboard")).into_response();
    }
    let form: GiftCodesForm = match Form::from_request(request, &state).await {
        Ok(Form(f)) => f,
        Err(error) => {
            tracing::warn!(%error, "failed to parse gift codes form");
            return flash::redirect_with_flash(
                &format!("{base}/gift-codes"),
                FlashData::error("Invalid form data"),
                config.secure_cookies(),
            );
        }
    };
    let count = form.count.unwrap_or(1).clamp(1, MAX_GIFT_CODES);
    let items = code_items(&client, &auth.0).await;
    let grant = if form.gives.as_deref() == Some("cosmetic") {
        // Only an item offered on the page is accepted; an item request never falls back to premium.
        let chosen = form
            .item_id
            .as_deref()
            .and_then(|id| items.as_deref()?.iter().find(|item| item.id == id));
        let Some(item) = chosen else {
            return flash::redirect_with_flash(
                &format!("{base}/gift-codes"),
                FlashData::error("Choose an item sold as owned only (needs cosmetics:manage)"),
                config.secure_cookies(),
            );
        };
        CodeGrant::Item(item)
    } else {
        CodeGrant::Premium(
            form.duration_type
                .unwrap_or(GiftCodeDurationTypeSchema::Months),
            form.duration_quantity.unwrap_or(1),
        )
    };
    let (codes, error) = generate_in_chunks(&client, count, &grant).await;
    if error.is_none() && form.format.as_deref() == Some("csv") {
        return csv_response(&codes, &grant);
    }
    let urls: Vec<String> = codes.into_iter().map(|code| code.url).collect();
    let premium = GiftCodesPremium::from_branding(
        config.self_hosted,
        state.premium_branding(&client).await.as_ref(),
    );
    let markup = templates::pages::gift_codes::gift_codes_page(
        config,
        &auth.0,
        &csrf.0.0,
        None,
        Some(&GeneratedGiftCodes {
            urls: &urls,
            requested: count,
            error: error.as_deref(),
        }),
        items.as_deref(),
        &premium,
    );
    Html(markup.into_string()).into_response()
}

// Sequential on purpose: the API's admin:code:generation bucket (30/min) makes parallel calls fail sooner, not
// faster. On any failure the codes already issued are returned so they are never lost.
async fn generate_in_chunks(
    client: &AdminApiClient,
    count: u32,
    grant: &CodeGrant<'_>,
) -> (Vec<GeneratedCode>, Option<String>) {
    let started = Instant::now();
    let mut codes: Vec<GeneratedCode> = Vec::with_capacity(count as usize);
    while codes.len() < count as usize {
        if started.elapsed() >= GENERATION_TIME_BUDGET {
            return (codes, Some("time limit reached".to_owned()));
        }
        let chunk = (count - codes.len() as u32).min(GIFT_CODES_PER_API_CALL);
        let result = match grant {
            CodeGrant::Premium(duration_type, duration_quantity) => {
                client
                    .generate_gift_codes(chunk, *duration_type, *duration_quantity)
                    .await
            }
            CodeGrant::Item(item) => client.create_cosmetic_gift_codes(chunk, &item.id).await,
        };
        let created_at = OffsetDateTime::now_utc()
            .format(&Rfc3339)
            .unwrap_or_default();
        match result {
            Ok(response) if !response.codes.is_empty() => {
                codes.extend(response.codes.into_iter().map(|url| GeneratedCode {
                    url,
                    created_at: created_at.clone(),
                }));
            }
            Ok(_) => return (codes, Some("the API returned no codes".to_owned())),
            Err(error) => {
                tracing::warn!(%error, "admin API request failed: generate gift codes");
                let reason = match error {
                    ApiError::Http { status, .. } => format!("HTTP {status}"),
                    _ => "the API request failed".to_owned(),
                };
                return (codes, Some(reason));
            }
        }
    }
    (codes, None)
}

// Built per request and never stored by the admin panel.
fn csv_response(codes: &[GeneratedCode], grant: &CodeGrant<'_>) -> Response {
    let (header, grant_columns) = match grant {
        CodeGrant::Premium(duration_type, duration_quantity) => {
            (CSV_HEADER, format!("{duration_type},{duration_quantity}"))
        }
        CodeGrant::Item(item) => (
            ITEM_CSV_HEADER,
            format!("{},{}", item.id, csv_field(&item.name)),
        ),
    };
    let mut csv = String::from(header);
    for GeneratedCode { url, created_at } in codes {
        let code = url.rsplit('/').next().unwrap_or(url);
        csv.push_str(&format!("{code},{url},{grant_columns},{created_at}\n"));
    }
    (
        [
            (header::CONTENT_TYPE, "text/csv; charset=utf-8".to_owned()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"gift-codes-{}.csv\"", codes.len()),
            ),
        ],
        csv,
    )
        .into_response()
}

// An item name with a comma, quote or line break is quoted, so every row keeps five columns.
fn csv_field(value: &str) -> String {
    if value.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::csv_field;

    #[test]
    fn csv_field_quotes_commas_quotes_and_line_breaks() {
        assert_eq!(csv_field("Yitik Melek"), "Yitik Melek");
        assert_eq!(csv_field("Kuzgun, Kara"), "\"Kuzgun, Kara\"");
        assert_eq!(csv_field("The \"Wing\""), "\"The \"\"Wing\"\"\"");
        assert_eq!(csv_field("two\nlines"), "\"two\nlines\"");
    }
}
