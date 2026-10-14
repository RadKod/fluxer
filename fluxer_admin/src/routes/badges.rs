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
    templates,
    utils::forms::MultiValueForm,
};
use axum::{
    Router,
    extract::{Query, Request, State},
    response::{Html, IntoResponse, Response},
    routing::get,
};
use serde::Deserialize;
use serde_json::{Map, Value, json};

#[derive(Deserialize)]
struct BadgesQuery {
    edit: Option<String>,
}

pub fn router() -> Router<AppState> {
    Router::new().route("/badges", get(badges_page).post(badges_post))
}

async fn badges_page(
    State(state): State<AppState>,
    auth: axum::Extension<AuthContext>,
    csrf: axum::Extension<CsrfToken>,
    flash: Option<axum::Extension<FlashData>>,
    Query(query): Query<BadgesQuery>,
) -> Response {
    let config = state.config();
    if let Some(response) = acl_forbidden(config, &auth.0, acl::BADGES_MANAGE) {
        return response;
    }
    let client = AdminApiClient::new(state.http_client(), config, &auth.0.session);
    let badges = client.list_badges().await.log_error("list badges");
    let flash = flash.map(|flash| flash.0.to_flash_message());
    let markup = templates::pages::badges::badges_page(
        config,
        &auth.0,
        &csrf.0.0,
        flash.as_ref(),
        badges.as_deref(),
        query.edit.as_deref(),
    );
    Html(markup.into_string()).into_response()
}

async fn badges_post(
    State(state): State<AppState>,
    auth: axum::Extension<AuthContext>,
    Query(aq): Query<ActionQuery>,
    request: Request,
) -> Response {
    let config = state.config();
    if let Some(response) = acl_forbidden(config, &auth.0, acl::BADGES_MANAGE) {
        return response;
    }
    let flash = match MultiValueForm::from_request(request).await {
        None => FlashData::error("Invalid form data"),
        Some(form) => {
            let client = AdminApiClient::new(state.http_client(), config, &auth.0.session);
            match aq.action.as_deref().unwrap_or("") {
                "create" => create_badge(&client, &form).await,
                "update" => update_badge(&client, &form).await,
                "grant" => set_user_badge(&client, &form, true).await,
                "revoke" => set_user_badge(&client, &form, false).await,
                _ => FlashData::error("Unknown badge action"),
            }
        }
    };
    flash::redirect_with_flash(
        &format!("{}/badges", config.base_path),
        flash,
        config.secure_cookies(),
    )
}

async fn create_badge(client: &AdminApiClient, form: &MultiValueForm) -> FlashData {
    let (Some(icon), Some(description)) = (form.clean("icon"), form.clean("description")) else {
        return FlashData::error("Icon and text are required");
    };
    let body = json!({"icon": icon, "description": description});
    match client.create_badge(&body).await {
        Ok(badge) => FlashData::success(format!("Badge {} created", badge.id)),
        Err(error) => api_failure("create the badge", &error),
    }
}

async fn update_badge(client: &AdminApiClient, form: &MultiValueForm) -> FlashData {
    let Some(badge_id) = form_snowflake(form, "badge_id") else {
        return FlashData::error("A valid badge ID is required");
    };
    let mut body = Map::new();
    for key in ["icon", "description"] {
        if let Some(value) = form.clean(key) {
            body.insert(key.to_owned(), Value::String(value));
        }
    }
    if body.is_empty() {
        return FlashData::error("Fill in at least one field to change");
    }
    match client.update_badge(&badge_id, &Value::Object(body)).await {
        Ok(_) => FlashData::success(format!("Badge {badge_id} updated")),
        Err(error) => api_failure("update the badge", &error),
    }
}

async fn set_user_badge(client: &AdminApiClient, form: &MultiValueForm, grant: bool) -> FlashData {
    let (Some(user_id), Some(badge_id)) = (
        form_snowflake(form, "user_id"),
        form_snowflake(form, "badge_id"),
    ) else {
        return FlashData::error("A valid user ID and badge ID are required");
    };
    if grant {
        match client.grant_user_badge(&user_id, &badge_id).await {
            Ok(()) => FlashData::success(format!("Badge {badge_id} given to user {user_id}")),
            Err(error) => api_failure("give the badge", &error),
        }
    } else {
        match client.revoke_user_badge(&user_id, &badge_id).await {
            Ok(()) => FlashData::success(format!("Badge {badge_id} taken from user {user_id}")),
            Err(error) => api_failure("take the badge back", &error),
        }
    }
}
