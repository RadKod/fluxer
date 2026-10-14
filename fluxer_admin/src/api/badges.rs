// SPDX-License-Identifier: AGPL-3.0-or-later

use reqwest::Method;

use super::client::{AdminApiClient, ApiResult};
use super::types::Badge;
use serde_json::Value;

fn user_badge_path(user_id: &str, badge_id: &str) -> String {
    format!(
        "/admin/users/{}/badges/{}",
        urlencoding::encode(user_id),
        urlencoding::encode(badge_id)
    )
}

impl AdminApiClient {
    pub async fn list_badges(&self) -> ApiResult<Vec<Badge>> {
        self.get("/admin/badges", None).await
    }

    pub async fn create_badge(&self, body: &Value) -> ApiResult<Badge> {
        self.send(Method::POST, "/admin/badges", Some(body), None)
            .await
    }

    pub async fn update_badge(&self, badge_id: &str, body: &Value) -> ApiResult<Badge> {
        let path = format!("/admin/badges/{}", urlencoding::encode(badge_id));
        self.send(Method::PATCH, &path, Some(body), None).await
    }

    pub async fn grant_user_badge(&self, user_id: &str, badge_id: &str) -> ApiResult<()> {
        self.send_void(
            Method::POST,
            &user_badge_path(user_id, badge_id),
            None::<&Value>,
            None,
        )
        .await
    }

    pub async fn revoke_user_badge(&self, user_id: &str, badge_id: &str) -> ApiResult<()> {
        self.send_void(
            Method::DELETE,
            &user_badge_path(user_id, badge_id),
            None::<&Value>,
            None,
        )
        .await
    }
}
