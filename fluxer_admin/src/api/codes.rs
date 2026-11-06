// SPDX-License-Identifier: AGPL-3.0-or-later

use reqwest::Method;

use super::client::{AdminApiClient, ApiResult};
use super::types::CodesResponse;

pub const GIFT_DURATION_TYPES: [&str; 5] = ["days", "weeks", "months", "years", "lifetime"];

impl AdminApiClient {
    pub async fn generate_gift_codes(
        &self,
        count: u32,
        duration_type: &str,
        duration_quantity: u32,
    ) -> ApiResult<CodesResponse> {
        let body = serde_json::json!({
            "count": count,
            "duration_type": duration_type,
            "duration_quantity": duration_quantity,
        });
        self.send(Method::POST, "/admin/gift-codes", Some(&body), None)
            .await
    }

    // Item codes give one owned-availability cosmetic item instead of premium time.
    pub async fn create_cosmetic_gift_codes(
        &self,
        count: u32,
        item_id: &str,
    ) -> ApiResult<CodesResponse> {
        let body = serde_json::json!({ "count": count, "item_id": item_id });
        self.send(
            Method::POST,
            "/admin/gift-codes/cosmetic",
            Some(&body),
            None,
        )
        .await
    }
}
