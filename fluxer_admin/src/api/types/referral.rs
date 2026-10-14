// SPDX-License-Identifier: AGPL-3.0-or-later

use serde::Deserialize;

// Micup (referral): the reward of a tier, as the API sends and takes it.
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ReferralReward {
    Cosmetic { item_id: String },
    PremiumDays { days: i32 },
    Offsite { description: String },
}

// Micup: GET /admin/referral. Tiers arrive with the disabled ones too.
#[derive(Debug, Deserialize)]
pub struct AdminReferral {
    pub settings: AdminReferralSettings,
    pub tiers: Vec<ReferralTier>,
}

#[derive(Debug, Deserialize)]
pub struct AdminReferralSettings {
    pub enabled: bool,
    pub min_active_days: i32,
    pub daily_valid_cap: i32,
    pub ip_registration_limit: i32,
}

#[derive(Debug, Deserialize)]
pub struct ReferralTier {
    pub id: String,
    pub threshold: i32,
    pub reward: ReferralReward,
    pub enabled: bool,
}

// Micup: one page of the rewards waiting for an admin, within one month.
#[derive(Debug, Deserialize)]
pub struct AdminReferralPendingRewards {
    pub month: String,
    pub items: Vec<AdminReferralPendingReward>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AdminReferralPendingReward {
    pub user_id: String,
    pub tier_id: String,
    pub reward: ReferralReward,
    pub created_at: String,
}

// Micup: GET /admin/users/:id/referrals. There is no IP here, and an off-site code is only `has_code`.
#[derive(Debug, Deserialize)]
pub struct AdminUserReferrals {
    pub user_id: String,
    pub code: Option<String>,
    pub referrer_id: Option<String>,
    pub counts: ReferralCounts,
    pub rewards: Vec<AdminUserReferralReward>,
    pub referees: Vec<AdminUserReferee>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ReferralCounts {
    pub pending: i64,
    pub valid: i64,
    pub rejected: i64,
}

#[derive(Debug, Deserialize)]
pub struct AdminUserReferralReward {
    pub tier_id: String,
    pub reward: ReferralReward,
    pub status: String,
    pub granted_at: String,
    pub delivered_at: Option<String>,
    pub delivered_by: Option<String>,
    pub note: Option<String>,
    pub has_code: bool,
}

#[derive(Debug, Deserialize)]
pub struct AdminUserReferee {
    pub referee_id: String,
    pub state: String,
    pub reason: Option<String>,
    pub referred_at: String,
}
