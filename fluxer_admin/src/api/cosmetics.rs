// SPDX-License-Identifier: AGPL-3.0-or-later

use reqwest::Method;

use super::client::{AdminApiClient, ApiResult};
use super::types::{AdminUserCosmetic, CosmeticItem};
use serde_json::{Value, json};

fn item_path(item_id: &str) -> String {
    format!("/admin/cosmetics/items/{}", urlencoding::encode(item_id))
}

fn user_item_path(user_id: &str, item_id: &str) -> String {
    format!(
        "/admin/users/{}/cosmetics/{}",
        urlencoding::encode(user_id),
        urlencoding::encode(item_id)
    )
}

impl AdminApiClient {
    // Micup: every item, off-sale ones included (their availability reads "owned").
    pub async fn list_cosmetic_items(&self) -> ApiResult<Vec<CosmeticItem>> {
        self.get("/admin/cosmetics/items", None).await
    }

    pub async fn create_cosmetic_item(&self, body: &Value) -> ApiResult<CosmeticItem> {
        self.send(Method::POST, "/admin/cosmetics/items", Some(body), None)
            .await
    }

    pub async fn update_cosmetic_item(
        &self,
        item_id: &str,
        body: &Value,
    ) -> ApiResult<CosmeticItem> {
        self.send(Method::PATCH, &item_path(item_id), Some(body), None)
            .await
    }

    pub async fn retire_cosmetic_item(&self, item_id: &str) -> ApiResult<()> {
        self.send_void(Method::DELETE, &item_path(item_id), None::<&Value>, None)
            .await
    }

    // Micup (shop): the reason reaches the audit log as the X-Audit-Log-Reason header.
    pub async fn grant_user_cosmetic(
        &self,
        user_id: &str,
        item_id: &str,
        reason: &str,
    ) -> ApiResult<AdminUserCosmetic> {
        self.send(
            Method::POST,
            &user_item_path(user_id, item_id),
            None::<&Value>,
            Some(reason),
        )
        .await
    }

    pub async fn revoke_user_cosmetic(
        &self,
        user_id: &str,
        item_id: &str,
        reason: &str,
    ) -> ApiResult<AdminUserCosmetic> {
        self.send(
            Method::DELETE,
            &user_item_path(user_id, item_id),
            None::<&Value>,
            Some(reason),
        )
        .await
    }

    // Micup (shop): null puts the fixed sizes back.
    pub async fn update_ultra_layout(
        &self,
        item_id: &str,
        layout: &Value,
    ) -> ApiResult<CosmeticItem> {
        let body = json!({ "ultra_layout": layout });
        self.send(Method::PATCH, &item_path(item_id), Some(&body), None)
            .await
    }
}
