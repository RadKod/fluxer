// SPDX-License-Identifier: AGPL-3.0-or-later

use super::client::{AdminApiClient, ApiResult};
use super::types::{AdminReferral, AdminReferralPendingRewards, AdminUserReferrals};
use serde::de::IgnoredAny;
use serde_json::Value;

// Micup: the page reloads after every write, so write responses are not read.
impl AdminApiClient {
    pub async fn get_referral(&self) -> ApiResult<AdminReferral> {
        self.get("/admin/referral", None).await
    }

    pub async fn update_referral_settings(&self, body: &Value) -> ApiResult<()> {
        self.patch::<IgnoredAny>("/admin/referral/settings", Some(body))
            .await
            .map(drop)
    }

    pub async fn create_referral_tier(&self, body: &Value) -> ApiResult<()> {
        self.post::<IgnoredAny>("/admin/referral/tiers", Some(body))
            .await
            .map(drop)
    }

    pub async fn update_referral_tier(&self, tier_id: &str, body: &Value) -> ApiResult<()> {
        let path = format!("/admin/referral/tiers/{}", urlencoding::encode(tier_id));
        self.patch::<IgnoredAny>(&path, Some(body)).await.map(drop)
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
        self.post::<IgnoredAny>(&reward_path(user_id, tier_id, "deliver"), Some(body))
            .await
            .map(drop)
    }

    pub async fn notify_referral_reward(
        &self,
        user_id: &str,
        tier_id: &str,
        body: &Value,
    ) -> ApiResult<()> {
        self.post_void(&reward_path(user_id, tier_id, "notify"), Some(body))
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
