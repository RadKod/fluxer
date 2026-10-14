// SPDX-License-Identifier: AGPL-3.0-or-later

use crate::api::generated::types as generated_types;
use reqwest::Method;

use super::client::{AdminApiClient, ApiError, ApiResult};
use super::types::CodesResponse;

impl AdminApiClient {
    pub async fn generate_gift_codes(
        &self,
        count: u32,
        duration_type: generated_types::GiftCodeDurationTypeSchema,
        duration_quantity: u32,
    ) -> ApiResult<CodesResponse> {
        let body = generated_types::GenerateGiftCodesRequest {
            count: crate::api::generated::nonzero_u32(count, "count")
                .map_err(ApiError::Parse)?
                .into(),
            duration_quantity: crate::api::generated::nonzero_u32(
                duration_quantity,
                "duration_quantity",
            )
            .map_err(ApiError::Parse)?
            .into(),
            duration_type,
        };
        let response = self
            .generated()
            .create_admin_gift_codes(&body)
            .await
            .map_err(|e| self.generated_error(e))?;
        self.generated_value(response.into_inner())
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
