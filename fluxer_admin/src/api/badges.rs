// SPDX-License-Identifier: AGPL-3.0-or-later

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
        self.post("/admin/badges", Some(body)).await
    }

    pub async fn update_badge(&self, badge_id: &str, body: &Value) -> ApiResult<Badge> {
        let path = format!("/admin/badges/{}", urlencoding::encode(badge_id));
        self.patch(&path, Some(body)).await
    }

    pub async fn grant_user_badge(&self, user_id: &str, badge_id: &str) -> ApiResult<()> {
        self.post_void(&user_badge_path(user_id, badge_id), None)
            .await
    }

    pub async fn revoke_user_badge(&self, user_id: &str, badge_id: &str) -> ApiResult<()> {
        self.delete_void(&user_badge_path(user_id, badge_id), None)
            .await
    }
}
