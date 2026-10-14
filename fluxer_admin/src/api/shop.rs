// SPDX-License-Identifier: AGPL-3.0-or-later

use reqwest::Method;

use super::client::{AdminApiClient, ApiResult};
use super::types::{ShopAdmin, ShopAdminOrder, ShopAdminVisionary};
use serde_json::Value;

// Micup: the page reloads the shop after every write, so write responses are not read.
impl AdminApiClient {
    pub async fn get_shop(&self) -> ApiResult<ShopAdmin> {
        self.get("/admin/shop", None).await
    }

    pub async fn update_shop_settings(&self, body: &Value) -> ApiResult<()> {
        self.send_void(Method::PATCH, "/admin/shop/settings", Some(body), None)
            .await
    }

    pub async fn refresh_shop_try_rate(&self) -> ApiResult<()> {
        self.send_void(
            Method::POST,
            "/admin/shop/settings/refresh-try-rate",
            None::<&Value>,
            None,
        )
        .await
    }

    pub async fn set_shop_prices(&self, body: &Value) -> ApiResult<()> {
        self.send_void(Method::PUT, "/admin/shop/prices", Some(body), None)
            .await
    }

    pub async fn apply_shop_campaign(&self, body: &Value) -> ApiResult<()> {
        self.send_void(Method::POST, "/admin/shop/campaigns", Some(body), None)
            .await
    }

    pub async fn remove_shop_campaign(&self, body: &Value) -> ApiResult<()> {
        self.send_void(
            Method::POST,
            "/admin/shop/campaigns/remove",
            Some(body),
            None,
        )
        .await
    }

    pub async fn get_shop_order(&self, order_id: &str) -> ApiResult<ShopAdminOrder> {
        let path = format!("/admin/shop/orders/{}", urlencoding::encode(order_id));
        self.get(&path, None).await
    }

    pub async fn get_shop_visionary(&self) -> ApiResult<ShopAdminVisionary> {
        self.get("/admin/shop/visionary", None).await
    }

    pub async fn set_visionary_slots(&self, body: &Value) -> ApiResult<()> {
        self.send_void(Method::PUT, "/admin/shop/visionary/slots", Some(body), None)
            .await
    }

    pub async fn create_shop_bundle(&self, body: &Value) -> ApiResult<()> {
        self.send_void(Method::POST, "/admin/shop/bundles", Some(body), None)
            .await
    }

    pub async fn update_shop_bundle(&self, bundle_id: &str, body: &Value) -> ApiResult<()> {
        self.send_void(Method::PATCH, &bundle_path(bundle_id), Some(body), None)
            .await
    }

    /// The API deletes the bundle's price with it.
    pub async fn delete_shop_bundle(&self, bundle_id: &str) -> ApiResult<()> {
        self.send_void(
            Method::DELETE,
            &bundle_path(bundle_id),
            None::<&Value>,
            None,
        )
        .await
    }
}

fn bundle_path(bundle_id: &str) -> String {
    format!("/admin/shop/bundles/{}", urlencoding::encode(bundle_id))
}
