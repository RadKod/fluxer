// SPDX-License-Identifier: AGPL-3.0-or-later

use serde::Deserialize;

// Micup: GET /admin/shop. Every price arrives computed by the API; the panel never prices anything.
#[derive(Debug, Deserialize)]
pub struct ShopAdmin {
    pub settings: ShopAdminSettings,
    pub prices: Vec<ShopAdminPriceRow>,
    pub health: ShopAdminHealth,
    #[serde(default)]
    pub bundles: Vec<ShopAdminBundle>,
}

// Micup (bundles): priced like any product, by its sku in `prices`; no price row means not in the shop.
#[derive(Debug, Deserialize)]
pub struct ShopAdminBundle {
    pub id: String,
    pub sku: String,
    pub name: String,
    pub description: Option<String>,
    /// In bundle order.
    pub item_ids: Vec<String>,
}

// sanalyer: sales are in Turkish lira only, so the USD → AZN rate and the CBAR TRY rate are gone.
#[derive(Debug, Deserialize)]
pub struct ShopAdminSettings {
    pub premium_sales_open: bool,
    pub item_sales_open: bool,
    pub premium_discount_percent: i32,
    /// false keeps every sale closed whatever the switches say.
    pub payment_provider_configured: bool,
    #[serde(default)]
    pub visionary_on_sale: bool,
    /// Unpriced owned-only items given and worn with every Visionary number.
    #[serde(default)]
    pub visionary_reward_item_ids: Vec<String>,
    /// Micup (Early Plus): the catalog badge paid Plus and Visionary orders give while open.
    #[serde(default)]
    pub early_plus_badge_id: Option<String>,
    #[serde(default)]
    pub early_plus_open: bool,
    /// Set by the first opening; the badge can no longer change.
    #[serde(default)]
    pub early_plus_opened_once: bool,
}

#[derive(Debug, Deserialize)]
pub struct ShopAdminPriceRow {
    pub sku: String,
    /// List price in kuruş (1 TL = 100 kuruş).
    pub base_try_minor: i32,
    pub campaign_percent: Option<i32>,
    pub campaign_ends_at: Option<String>,
    pub now: ShopPrice,
}

#[derive(Debug, Deserialize)]
pub struct ShopPrice {
    /// None when there is no campaign or it has ended.
    pub campaign_percent: Option<i32>,
    /// Kuruş, like every amount below.
    pub sale_try_minor: i32,
    pub premium_try_minor: Option<i32>,
}

#[derive(Debug, Deserialize)]
pub struct ShopAdminHealth {
    pub busy_refusals_last_hour: i32,
    pub reconcile_lag_seconds: i32,
    pub provider_backing_off: bool,
}

#[derive(Debug, Deserialize)]
pub struct ShopAdminOrder {
    pub id: String,
    pub user_id: String,
    pub sku: String,
    pub status: String,
    pub failure_reason: Option<String>,
    /// Kuruş.
    pub base_try_minor: i32,
    pub campaign_percent: i32,
    pub premium_percent: i32,
    /// What the order charges, in kuruş.
    pub final_try_minor: i32,
    pub provider_order_id: Option<String>,
    pub provider_status: Option<String>,
    pub check_count: i32,
    pub created_at: String,
    pub paid_at: Option<String>,
    pub granted_at: Option<String>,
    /// A bundle order's items, frozen when the order opened; empty for every other order.
    #[serde(default)]
    pub item_ids: Vec<String>,
}

// Micup: GET /admin/shop/visionary. Sold counts taken-back numbers too: a number is never sold twice.
#[derive(Debug, Deserialize)]
pub struct ShopAdminVisionary {
    pub total: i32,
    pub sold: i32,
    pub held: i32,
    pub remaining: i32,
    pub over_cap_grants: i32,
}

// Micup: POST /admin/users/{id}/premium/end. Null, or a time already past, means nothing was paid.
#[derive(Debug, Deserialize)]
pub struct AdminEndPremium {
    pub previous_paid_until: Option<String>,
}

// Micup: POST and DELETE /admin/users/{id}/visionary.
#[derive(Debug, Deserialize)]
pub struct AdminVisionary {
    pub slot: Option<i32>,
    pub changed: bool,
}
