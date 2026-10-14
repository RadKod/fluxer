// SPDX-License-Identifier: AGPL-3.0-or-later

use super::{ActionQuery, acl_forbidden, api_failure, form_snowflake};
use crate::{
    acl,
    api::client::AdminApiClient,
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

#[derive(Deserialize)]
struct FeedModerationQuery {
    post_id: Option<String>,
    comment_id: Option<String>,
}

pub fn router() -> Router<AppState> {
    Router::new().route(
        "/feed-moderation",
        get(feed_moderation_page).post(feed_moderation_post),
    )
}

async fn feed_moderation_page(
    State(state): State<AppState>,
    auth: axum::Extension<AuthContext>,
    csrf: axum::Extension<CsrfToken>,
    flash: Option<axum::Extension<FlashData>>,
    Query(query): Query<FeedModerationQuery>,
) -> Response {
    let config = state.config();
    if let Some(response) = acl_forbidden(config, &auth.0, acl::FEED_MODERATE) {
        return response;
    }
    let flash = flash.map(|flash| flash.0.to_flash_message());
    let markup = templates::pages::feed_moderation::feed_moderation_page(
        config,
        &auth.0,
        &csrf.0.0,
        flash.as_ref(),
        query.post_id.as_deref().unwrap_or(""),
        query.comment_id.as_deref().unwrap_or(""),
    );
    Html(markup.into_string()).into_response()
}

async fn feed_moderation_post(
    State(state): State<AppState>,
    auth: axum::Extension<AuthContext>,
    Query(aq): Query<ActionQuery>,
    request: Request,
) -> Response {
    let config = state.config();
    if let Some(response) = acl_forbidden(config, &auth.0, acl::FEED_MODERATE) {
        return response;
    }
    let flash = match MultiValueForm::from_request(request).await {
        None => FlashData::error("Invalid form data"),
        Some(form) => {
            let client = AdminApiClient::new(state.http_client(), config, &auth.0.session);
            delete_feed_item(&client, &form, aq.action.as_deref().unwrap_or("")).await
        }
    };
    flash::redirect_with_flash(
        &format!("{}/feed-moderation", config.base_path),
        flash,
        config.secure_cookies(),
    )
}

async fn delete_feed_item(
    client: &AdminApiClient,
    form: &MultiValueForm,
    action: &str,
) -> FlashData {
    let Some(post_id) = form_snowflake(form, "post_id") else {
        return FlashData::error("A valid post ID is required");
    };
    match action {
        "delete-post" => match client.delete_feed_post(&post_id).await {
            Ok(()) => FlashData::success(format!("Feed post {post_id} deleted")),
            Err(error) => api_failure("delete the feed post", &error),
        },
        "delete-comment" => {
            let Some(comment_id) = form_snowflake(form, "comment_id") else {
                return FlashData::error("A valid comment ID is required");
            };
            match client.delete_feed_comment(&post_id, &comment_id).await {
                Ok(()) => FlashData::success(format!("Feed comment {comment_id} deleted")),
                Err(error) => api_failure("delete the feed comment", &error),
            }
        }
        _ => FlashData::error("Unknown feed moderation action"),
    }
}
