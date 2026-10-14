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

#[derive(Debug, Deserialize)]
pub struct ShopAdminSettings {
    pub premium_sales_open: bool,
    pub item_sales_open: bool,
    pub premium_discount_percent: i32,
    pub usd_to_azn_rate_micro: i32,
    #[serde(default)]
    pub try_to_azn_rate_micro: Option<i32>,
    #[serde(default)]
    pub try_rate_date: Option<String>,
    #[serde(default)]
    pub try_rate_fetched_at: Option<String>,
    #[serde(default)]
    pub try_to_azn_rate_override_micro: Option<i32>,
    #[serde(default)]
    pub try_rate_override_at: Option<String>,
    pub payriff_configured: bool,
    #[serde(default)]
    pub visionary_on_sale: bool,
    /// Unpriced owned-only items given and worn with every Visionary number.
    #[serde(default)]
    pub visionary_reward_item_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct ShopAdminPriceRow {
    pub sku: String,
    pub base_usd_cents: i32,
    pub campaign_percent: Option<i32>,
    pub campaign_ends_at: Option<String>,
    pub now: ShopPrice,
}

#[derive(Debug, Deserialize)]
pub struct ShopPrice {
    /// None when there is no campaign or it has ended.
    pub campaign_percent: Option<i32>,
    pub sale_usd_cents: i32,
    pub premium_usd_cents: Option<i32>,
}

#[derive(Debug, Deserialize)]
pub struct ShopAdminHealth {
    pub busy_refusals_last_hour: i32,
    pub reconcile_lag_seconds: i32,
    pub payriff_backing_off: bool,
}

#[derive(Debug, Deserialize)]
pub struct ShopAdminOrder {
    pub id: String,
    pub user_id: String,
    pub sku: String,
    pub status: String,
    pub failure_reason: Option<String>,
    pub base_usd_cents: i32,
    pub campaign_percent: i32,
    pub premium_percent: i32,
    pub final_usd_cents: i32,
    pub amount_azn_minor: i32,
    pub usd_to_azn_rate: String,
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

#[cfg(test)]
mod tests {
    use super::ShopAdminSettings;
    use serde_json::json;

    #[test]
    fn try_rate_fields_accept_legacy_responses_and_explicit_nulls() {
        let mut response = json!({
            "premium_sales_open": true,
            "item_sales_open": true,
            "premium_discount_percent": 0,
            "usd_to_azn_rate_micro": 1_700_000,
            "payriff_configured": true
        });
        for explicit_nulls in [false, true] {
            if explicit_nulls {
                for field in [
                    "try_to_azn_rate_micro",
                    "try_rate_date",
                    "try_rate_fetched_at",
                    "try_to_azn_rate_override_micro",
                    "try_rate_override_at",
                ] {
                    response[field] = serde_json::Value::Null;
                }
            }
            let settings: ShopAdminSettings = serde_json::from_value(response.clone()).unwrap();
            assert_eq!(settings.usd_to_azn_rate_micro, 1_700_000);
            assert!(settings.try_to_azn_rate_micro.is_none());
            assert!(settings.try_rate_date.is_none());
            assert!(settings.try_rate_fetched_at.is_none());
            assert!(settings.try_to_azn_rate_override_micro.is_none());
            assert!(settings.try_rate_override_at.is_none());
        }
    }
}
