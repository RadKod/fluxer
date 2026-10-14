// SPDX-License-Identifier: AGPL-3.0-or-later

use reqwest::Method;

use super::client::{AdminApiClient, ApiResult};
use super::types::{AdminReferral, AdminReferralPendingRewards, AdminUserReferrals};
use serde_json::Value;

// Micup: the page reloads after every write, so write responses are not read.
impl AdminApiClient {
    pub async fn get_referral(&self) -> ApiResult<AdminReferral> {
        self.get("/admin/referral", None).await
    }

    pub async fn update_referral_settings(&self, body: &Value) -> ApiResult<()> {
        self.send_void(Method::PATCH, "/admin/referral/settings", Some(body), None)
            .await
    }

    pub async fn create_referral_tier(&self, body: &Value) -> ApiResult<()> {
        self.send_void(Method::POST, "/admin/referral/tiers", Some(body), None)
            .await
    }

    pub async fn update_referral_tier(&self, tier_id: &str, body: &Value) -> ApiResult<()> {
        let path = format!("/admin/referral/tiers/{}", urlencoding::encode(tier_id));
        self.send_void(Method::PATCH, &path, Some(body), None).await
    }

    pub async fn list_referral_pending_rewards(
        &self,
        month: Option<&str>,
        cursor: Option<&str>,
    ) -> ApiResult<AdminReferralPendingRewards> {
        let query: Vec<(&str, &str)> = [("month", month), ("cursor", cursor)]
            .into_iter()
            .filter_map(|(key, value)| Some((key, value?)))
            .collect();
        self.get("/admin/referral/pending-rewards", Some(&query))
            .await
    }

    pub async fn get_user_referrals(
        &self,
        user_id: &str,
        cursor: Option<&str>,
    ) -> ApiResult<AdminUserReferrals> {
        let path = format!("/admin/users/{}/referrals", urlencoding::encode(user_id));
        let query: Vec<(&str, &str)> = cursor
            .map(|cursor| ("cursor", cursor))
            .into_iter()
            .collect();
        self.get(&path, Some(&query)).await
    }

    pub async fn deliver_referral_reward(
        &self,
        user_id: &str,
        tier_id: &str,
        body: &Value,
    ) -> ApiResult<()> {
        self.send_void(
            Method::POST,
            &reward_path(user_id, tier_id, "deliver"),
            Some(body),
            None,
        )
        .await
    }

    pub async fn notify_referral_reward(
        &self,
        user_id: &str,
        tier_id: &str,
        body: &Value,
    ) -> ApiResult<()> {
        self.send_void(
            Method::POST,
            &reward_path(user_id, tier_id, "notify"),
            Some(body),
            None,
        )
        .await
    }
}

fn reward_path(user_id: &str, tier_id: &str, action: &str) -> String {
    format!(
        "/admin/users/{}/referral-rewards/{}/{action}",
        urlencoding::encode(user_id),
        urlencoding::encode(tier_id)
    )
}
