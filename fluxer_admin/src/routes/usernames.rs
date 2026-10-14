// SPDX-License-Identifier: AGPL-3.0-or-later

use crate::{
    acl,
    api::{
        client::{AdminApiClient, ApiError},
        types::FlashMessage,
    },
    middleware::{auth::AuthContext, csrf},
    state::AppState,
    templates::pages::usernames::{self, UsernameDictionary},
};
use axum::{
    Form, Router,
    extract::{FromRequest, Query, Request, State},
    http::StatusCode,
    response::{Html, IntoResponse, Response},
    routing::get,
};
use reqwest::Method;
use serde::Deserialize;
use serde_json::json;

use super::{ActionQuery, acl_forbidden, bans_actions::to_flash};

#[derive(Default, Deserialize)]
struct ReserveForm {
    username: String,
    note: Option<String>,
    user_id: Option<String>,
    audit_log_reason: Option<String>,
}

#[derive(Default, Deserialize)]
struct DictionaryForm {
    scope: String,
    add: Option<String>,
    remove: Option<String>,
    audit_log_reason: Option<String>,
}

#[derive(Default, Deserialize)]
struct DictionaryQuery {
    scope: Option<String>,
    page: Option<usize>,
}

#[derive(Deserialize)]
pub struct ReservationQuery {
    #[serde(default)]
    pub bucket: u16,
    #[serde(default = "reservation_limit")]
    pub limit: usize,
    pub cursor: Option<String>,
}

fn reservation_limit() -> usize {
    50
}

impl Default for ReservationQuery {
    fn default() -> Self {
        Self {
            bucket: 0,
            limit: 50,
            cursor: None,
        }
    }
}

impl ReservationQuery {
    fn valid(&self) -> bool {
        self.bucket <= 1023
            && (1..=100).contains(&self.limit)
            && self.cursor.as_deref().is_none_or(valid_reservation_cursor)
    }
}

fn valid_reservation_cursor(value: &str) -> bool {
    (1..=32).contains(&value.len())
        && value
            .bytes()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == b'_')
}

#[derive(Deserialize)]
pub struct ReservationItem {
    pub username: String,
    pub state: String,
    pub user_id: Option<String>,
    pub held_by: Option<String>,
    pub note: Option<String>,
    pub blocked_until: Option<String>,
    pub updated_at: String,
}

#[derive(Deserialize)]
pub struct ReservationPage {
    pub bucket: u16,
    pub items: Vec<ReservationItem>,
    pub next_cursor: Option<String>,
}

#[derive(Deserialize)]
struct ClaimResponse {
    ok: bool,
    username: Option<String>,
    noop: Option<bool>,
    code: Option<String>,
    available_at: Option<String>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/usernames-reserve", get(reserve).post(reserve_post))
        .route(
            "/username-dictionary",
            get(dictionary).post(dictionary_post),
        )
}

fn render_reserve(
    state: &AppState,
    auth: &AuthContext,
    token: &str,
    flash: Option<&FlashMessage>,
    status: StatusCode,
) -> Response {
    (
        status,
        Html(
            usernames::reserve_page(
                state.config(),
                auth,
                flash,
                token,
                &ReservationQuery::default(),
                None,
            )
            .into_string(),
        ),
    )
        .into_response()
}

async fn reserve(
    State(state): State<AppState>,
    auth: axum::Extension<AuthContext>,
    request: Request,
) -> Response {
    if let Some(response) = acl_forbidden(state.config(), &auth.0, acl::USERNAME_RESERVE) {
        return response;
    }
    let query = match Query::<ReservationQuery>::try_from_uri(request.uri()) {
        Ok(Query(mut query)) => {
            query.cursor = query.cursor.filter(|cursor| !cursor.is_empty());
            if !query.valid() {
                return (
                    StatusCode::BAD_REQUEST,
                    "Invalid reservation bucket, cursor, or page size",
                )
                    .into_response();
            }
            query
        }
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                "Invalid reservation bucket, cursor, or page size",
            )
                .into_response();
        }
    };
    let client = AdminApiClient::new(state.http_client(), state.config(), &auth.0.session);
    let bucket = query.bucket.to_string();
    let limit = query.limit.to_string();
    let params = [
        ("bucket", bucket.as_str()),
        ("limit", limit.as_str()),
        ("cursor", query.cursor.as_deref().unwrap_or("")),
    ];
    let (page, flash) = match client
        .get::<ReservationPage>("/admin/usernames/reservations", Some(&params))
        .await
    {
        Ok(page)
            if page.bucket == query.bucket
                && page.items.len() <= query.limit
                && page
                    .next_cursor
                    .as_deref()
                    .is_none_or(valid_reservation_cursor)
                && page
                    .items
                    .iter()
                    .all(|item| matches!(item.state.as_str(), "held" | "pending")) =>
        {
            (Some(page), None)
        }
        Ok(_) => (
            None,
            Some(to_flash(
                "error",
                "Unexpected reservation page. No results were substituted.",
            )),
        ),
        Err(error) => (None, Some(api_error("load reservations", &error))),
    };
    Html(
        usernames::reserve_page(
            state.config(),
            &auth.0,
            flash.as_ref(),
            &csrf::get_csrf_token(&request),
            &query,
            page.as_ref(),
        )
        .into_string(),
    )
    .into_response()
}

fn api_error(action: &str, error: &ApiError) -> FlashMessage {
    tracing::warn!(%error, action, "admin API request failed");
    let detail = match error {
        ApiError::Http { status, .. } => format!("HTTP {status}"),
        ApiError::Network(_) => "network error".to_owned(),
        ApiError::Parse(_) => "unexpected API response".to_owned(),
    };
    to_flash("error", &format!("Failed to {action} ({detail})"))
}

fn claim_flash(result: ClaimResponse, success: &str) -> FlashMessage {
    if result.ok && result.username.is_some() && result.noop.is_some() {
        return to_flash("success", success);
    }
    let code = result.code.as_deref().unwrap_or("UNAVAILABLE");
    let available = result
        .available_at
        .map(|at| format!("; available at {at}"))
        .unwrap_or_default();
    to_flash(
        "error",
        &format!("Username operation rejected: {code}{available}"),
    )
}

fn audit_reason(value: Option<&str>) -> Result<&str, &'static str> {
    let reason = value.unwrap_or("").trim();
    if reason.is_empty()
        || reason.chars().any(char::is_control)
        || reason.encode_utf16().count() > 512
    {
        return Err(
            "An audit reason of at most 512 characters, without control characters, is required",
        );
    }
    Ok(reason)
}

async fn reserve_post(
    State(state): State<AppState>,
    auth: axum::Extension<AuthContext>,
    request: Request,
) -> Response {
    if let Some(response) = acl_forbidden(state.config(), &auth.0, acl::USERNAME_RESERVE) {
        return response;
    }
    let token = csrf::get_csrf_token(&request);
    let Query(query) = Query::<ActionQuery>::try_from_uri(request.uri())
        .unwrap_or(Query(ActionQuery { action: None }));
    let action = query.action.as_deref().unwrap_or("");
    if action == "assign"
        && let Some(response) = acl_forbidden(state.config(), &auth.0, acl::USER_UPDATE_USERNAME)
    {
        return response;
    }
    let form = match Form::<ReserveForm>::from_request(request, &state).await {
        Ok(Form(form)) => form,
        Err(_) => {
            return render_reserve(
                &state,
                &auth.0,
                &token,
                Some(&to_flash("error", "Invalid form data")),
                StatusCode::BAD_REQUEST,
            );
        }
    };
    let name = form.username.trim();
    let reason = match audit_reason(form.audit_log_reason.as_deref()) {
        Ok(reason) => reason,
        Err(message) => {
            return render_reserve(
                &state,
                &auth.0,
                &token,
                Some(&to_flash("error", message)),
                StatusCode::BAD_REQUEST,
            );
        }
    };
    let note = form.note.as_deref().unwrap_or("").trim();
    if name.is_empty() || note.encode_utf16().count() > 1000 {
        return render_reserve(
            &state,
            &auth.0,
            &token,
            Some(&to_flash(
                "error",
                "Username and audit reason are required; the note must be at most 1,000 characters",
            )),
            StatusCode::BAD_REQUEST,
        );
    }
    let client = AdminApiClient::new(state.http_client(), state.config(), &auth.0.session);
    let flash = match action {
        "hold" => match client
            .send::<ClaimResponse, _>(
                Method::POST,
                "/admin/usernames/reserve",
                Some(&json!({"username":name, "note":note})),
                Some(reason),
            )
            .await
        {
            Ok(result) => claim_flash(result, "Reservation held successfully"),
            Err(error) => api_error("hold reservation", &error),
        },
        "unhold" => match client
            .send_void(
                Method::POST,
                "/admin/usernames/unreserve",
                Some(&json!({"username":name})),
                Some(reason),
            )
            .await
        {
            Ok(()) => to_flash("success", "Reservation released successfully"),
            Err(error) => api_error("release reservation", &error),
        },
        "assign" => {
            let user_id = form.user_id.as_deref().unwrap_or("").trim();
            if user_id.parse::<u64>().ok().filter(|id| *id > 0).is_none() {
                return render_reserve(
                    &state,
                    &auth.0,
                    &token,
                    Some(&to_flash("error", "A valid user ID is required")),
                    StatusCode::BAD_REQUEST,
                );
            }
            match client
                .send::<ClaimResponse, _>(
                    Method::POST,
                    "/admin/usernames/assign",
                    Some(&json!({"username":name, "user_id":user_id})),
                    Some(reason),
                )
                .await
            {
                Ok(result) => claim_flash(result, "Username assigned successfully"),
                Err(error) => api_error("assign username", &error),
            }
        }
        _ => {
            return render_reserve(
                &state,
                &auth.0,
                &token,
                Some(&to_flash("error", "Unknown action")),
                StatusCode::BAD_REQUEST,
            );
        }
    };
    render_reserve(&state, &auth.0, &token, Some(&flash), StatusCode::OK)
}

async fn render_dictionary(
    state: &AppState,
    auth: &AuthContext,
    token: &str,
    flash: Option<&FlashMessage>,
    query: &DictionaryQuery,
    status: StatusCode,
) -> Response {
    let client = AdminApiClient::new(state.http_client(), state.config(), &auth.session);
    let acls = auth
        .admin_user
        .as_ref()
        .map(|user| user.acls.as_slice())
        .unwrap_or(&[]);
    let mut load_error = None;
    let entries = if acl::has_permission(acls, acl::BAN_PROFILE_SUBSTRING_CHECK) {
        match client
            .get::<UsernameDictionary>("/admin/username-dictionary", None)
            .await
        {
            Ok(entries) => Some(entries),
            Err(error) => {
                load_error = Some(api_error("load dictionary", &error));
                None
            }
        }
    } else {
        None
    };
    (
        status,
        Html(
            usernames::dictionary_page(
                state.config(),
                auth,
                flash.or(load_error.as_ref()),
                token,
                entries.as_ref(),
                query.scope.as_deref(),
                query.page.unwrap_or(0),
            )
            .into_string(),
        ),
    )
        .into_response()
}

async fn dictionary(
    State(state): State<AppState>,
    auth: axum::Extension<AuthContext>,
    request: Request,
) -> Response {
    if let Some(response) = acl_forbidden(state.config(), &auth.0, acl::BAN_PROFILE_SUBSTRING_CHECK)
    {
        return response;
    }
    let Query(query) = Query::<DictionaryQuery>::try_from_uri(request.uri())
        .unwrap_or(Query(DictionaryQuery::default()));
    render_dictionary(
        &state,
        &auth.0,
        &csrf::get_csrf_token(&request),
        None,
        &query,
        StatusCode::OK,
    )
    .await
}

fn parse_entries(value: Option<&str>) -> Result<Vec<String>, &'static str> {
    let entries: Vec<String> = value
        .unwrap_or("")
        .split_whitespace()
        .map(|value| value.to_ascii_lowercase())
        .collect();
    if entries.len() > 20_000
        || entries.iter().any(|value| {
            value.is_empty()
                || value.len() > 32
                || !value
                    .bytes()
                    .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit())
        })
    {
        return Err("Entries must be 1–32 letters or digits, with at most 20,000 entries per list");
    }
    Ok(entries)
}

async fn dictionary_post(
    State(state): State<AppState>,
    auth: axum::Extension<AuthContext>,
    request: Request,
) -> Response {
    let token = csrf::get_csrf_token(&request);
    let form = match Form::<DictionaryForm>::from_request(request, &state).await {
        Ok(Form(form)) => form,
        Err(_) => return (StatusCode::BAD_REQUEST, "Invalid form data").into_response(),
    };
    let scope = form.scope.as_str();
    if !["uname_exact", "uname_contains", "uname_allow"].contains(&scope) {
        return (StatusCode::BAD_REQUEST, "Invalid dictionary scope").into_response();
    }
    let (add, remove) = match (
        parse_entries(form.add.as_deref()),
        parse_entries(form.remove.as_deref()),
    ) {
        (Ok(add), Ok(remove)) => (add, remove),
        _ => return (StatusCode::BAD_REQUEST, "Invalid dictionary entries").into_response(),
    };
    let add_acl = if scope == "uname_allow" {
        acl::BAN_PROFILE_SUBSTRING_REMOVE
    } else {
        acl::BAN_PROFILE_SUBSTRING_ADD
    };
    let remove_acl = if scope == "uname_allow" {
        acl::BAN_PROFILE_SUBSTRING_ADD
    } else {
        acl::BAN_PROFILE_SUBSTRING_REMOVE
    };
    for (entries, required) in [(&add, add_acl), (&remove, remove_acl)] {
        if !entries.is_empty()
            && let Some(response) = acl_forbidden(state.config(), &auth.0, required)
        {
            return response;
        }
    }
    let reason = match audit_reason(form.audit_log_reason.as_deref()) {
        Ok(reason) => reason,
        Err(message) => return (StatusCode::BAD_REQUEST, message).into_response(),
    };
    if add.is_empty() && remove.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            "An audit reason and a dictionary change are required",
        )
            .into_response();
    }
    let client = AdminApiClient::new(state.http_client(), state.config(), &auth.0.session);
    let query = DictionaryQuery {
        scope: Some(scope.to_owned()),
        page: None,
    };
    match client
        .send::<UsernameDictionary, _>(
            Method::PATCH,
            "/admin/username-dictionary",
            Some(&json!({"scope":scope, "add":add, "remove":remove})),
            Some(reason),
        )
        .await
    {
        Ok(published) => {
            let flash = to_flash("success", "Dictionary generation published successfully");
            (
                StatusCode::OK,
                Html(
                    usernames::dictionary_page(
                        state.config(),
                        &auth.0,
                        Some(&flash),
                        &token,
                        Some(&published),
                        Some(scope),
                        0,
                    )
                    .into_string(),
                ),
            )
                .into_response()
        }
        Err(error) => {
            render_dictionary(
                &state,
                &auth.0,
                &token,
                Some(&api_error("publish dictionary", &error)),
                &query,
                StatusCode::BAD_GATEWAY,
            )
            .await
        }
    }
}
