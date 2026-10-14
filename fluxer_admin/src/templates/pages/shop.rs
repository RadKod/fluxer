// SPDX-License-Identifier: AGPL-3.0-or-later

use crate::{
    api::types::{
        CosmeticItem, FlashMessage, ShopAdmin, ShopAdminBundle, ShopAdminHealth, ShopAdminOrder,
        ShopAdminPriceRow, ShopAdminVisionary,
    },
    config::AdminConfig,
    middleware::auth::AuthContext,
    routes::shop::{count_of, format_usd, turkey_time_label},
    templates::{
        components::{
            badge::{BadgeVariant, badge},
            error_display::error_alert,
            form::{
                FORM_INPUT_CLASS, checkbox, csrf_input, danger_button, form_actions,
                form_field_group, select_input, submit_button,
            },
            page_container::{card, detail_row, page_header_with_actions},
            table::{table, table_body, table_container, table_head, table_header_cell},
        },
        layout::admin_layout,
        pages::cosmetics::{option_label, owned_item_options, text_field},
    },
    utils::timestamps::format_admin_timestamp,
};
use maud::{Markup, PreEscaped, html};
use time::{OffsetDateTime, UtcOffset, format_description::well_known::Rfc3339};

// Visionary is also a campaign row; it never takes the premium member discount.
const PACKAGES: &[(&str, &str)] = &[
    ("premium:1", "Plus · 1 month"),
    ("premium:3", "Plus · 3 months"),
    ("premium:12", "Plus · 12 months"),
    ("visionary", "Visionary · lifetime Plus, numbered"),
];
const PRODUCT_TYPES: &[(&str, &str)] = &[
    ("", "All"),
    ("premium", "Plus"),
    ("avatar_decoration", "Avatar decoration"),
    ("avatar_ultra", "Ultra decoration"),
    ("profile_effect", "Profile effect"),
    ("nameplate", "Nameplate"),
    ("bundle", "Bundle"),
];
// TEMPORARY: warn when the reconciliation cursor falls more than 15 minutes behind.
const RECONCILE_LAG_WARNING_SECONDS: i32 = 900;
// These two buttons need formaction, which the shared submit_button has no slot for.
const PRIMARY_BUTTON_CLASS: &str = "inline-flex w-fit items-center justify-center gap-2 \
     rounded-lg bg-neutral-900 px-4 py-2 font-medium text-base text-white transition-all \
     duration-150 hover:bg-neutral-800 focus:outline-none focus:ring-2 focus:ring-offset-2 \
     focus:ring-offset-white";
const SECONDARY_BUTTON_CLASS: &str = "inline-flex w-fit items-center justify-center gap-2 \
     rounded-lg border border-neutral-300 bg-neutral-50 px-4 py-2 font-medium text-base \
     text-neutral-700 transition-all duration-150 hover:border-neutral-400 \
     hover:text-neutral-900 focus:outline-none focus:ring-2 focus:ring-offset-2 \
     focus:ring-offset-white";

// "Select all" in the price table ticks every row; without the script rows are picked one by one.
const SELECT_ALL_SCRIPT: &str = r#"
(function () {
	if (window.__micupAdminShop) return;
	window.__micupAdminShop = true;
	document.addEventListener('change', function (event) {
		var box = event.target;
		if (!(box instanceof HTMLInputElement) || !box.hasAttribute('data-shop-select-all')) return;
		var boxes = box.form ? box.form.querySelectorAll('input[name="product_ids"]') : [];
		Array.prototype.forEach.call(boxes, function (input) { input.checked = box.checked; });
	});
})();
"#;

pub struct ShopPageData<'a> {
    pub shop: Option<&'a ShopAdmin>,
    pub items: Option<&'a [CosmeticItem]>,
    pub product_type: &'a str,
    pub order_query: &'a str,
    pub order: Option<&'a ShopAdminOrder>,
    pub visionary: Option<&'a ShopAdminVisionary>,
}

struct ProductRow<'a> {
    sku: String,
    kind: &'a str,
    label: String,
    image: Option<String>,
    price: Option<&'a ShopAdminPriceRow>,
    // A Visionary reward: the API refuses a price on it, so the row takes none.
    reward: bool,
}

pub fn shop_page(
    config: &AdminConfig,
    auth: &AuthContext,
    csrf_token: &str,
    flash: Option<&FlashMessage>,
    data: &ShopPageData<'_>,
) -> Markup {
    let base = &config.base_path;
    let content = html! {
        div class="space-y-6" {
            (page_header_with_actions(
                "Shop",
                Some("Prices, campaigns and whether the shop sells. Payriff charges AZN; users see TL (CBAR daily rate) and the AZN amount"),
                html! {
                    a href={(base) "/gift-codes"} class="font-medium text-blue-600 text-sm hover:underline" {
                        "Generate codes →"
                    }
                },
            ))
            (card(order_lookup(base, data)))
            @match data.shop {
                None => (error_alert("Failed to load the shop.")),
                Some(shop) => {
                    (card(sales_card(base, csrf_token, shop)))
                    (card(visionary_card(base, csrf_token, shop, data)))
                    (card(bundles_card(base, csrf_token, shop, data.items)))
                    (card(prices_card(config, csrf_token, shop, data)))
                }
            }
        }
        script defer { (PreEscaped(SELECT_ALL_SCRIPT)) }
    };
    admin_layout(config, auth, "Shop", "shop", flash, content)
}

fn order_lookup(base: &str, data: &ShopPageData<'_>) -> Markup {
    html! {
        div class="flex flex-col gap-4" {
            h2 class="text-base font-semibold text-neutral-900" { "Find an order" }
            p class="text-sm text-neutral-500" {
                "Payriff shows each payment as \"Micup #<order number> …\"."
            }
            form method="get" action={(base) "/shop"} class="flex flex-wrap items-end gap-2" {
                div class="w-72" {
                    (form_field_group("Order number", "shop-order", false, None, None, html! {
                        input type="text" id="shop-order" name="order" value=(data.order_query)
                            inputmode="numeric" maxlength="20" class=(FORM_INPUT_CLASS);
                    }))
                }
                (submit_button("Find"))
            }
            @if let Some(order) = data.order {
                (order_details(base, order, data.items))
            }
        }
    }
}

fn order_details(base: &str, order: &ShopAdminOrder, items: Option<&[CosmeticItem]>) -> Markup {
    let status = match order.status.as_str() {
        "granted" => BadgeVariant::Success,
        "failed" => BadgeVariant::Danger,
        "expired" => BadgeVariant::Warning,
        _ => BadgeVariant::Default,
    };
    let time = |at: Option<&str>| at.map_or_else(|| "—".to_owned(), format_admin_timestamp);
    html! {
        dl class="divide-y divide-neutral-100" {
            (detail_row("Order", html! { span class="font-mono" { (order.id) } }))
            (detail_row("User", html! {
                a href={(base) "/users/" (order.user_id)} class="font-mono text-blue-600 hover:underline" {
                    (order.user_id)
                }
            }))
            (detail_row("Product", html! { span class="font-mono" { (order.sku) } }))
            @if !order.item_ids.is_empty() {
                (detail_row("Items", html! {
                    (item_names(items, &order.item_ids))
                    // A paid bundle order is refunded whole; an unpaid one gave nothing.
                    @if order.paid_at.is_some() {
                        p class="text-xs text-neutral-500" {
                            "To refund: refund the whole order in Payriff, then take back on the user \
                             page the items this order gave; an item another order gave stays (the API \
                             log names it)."
                        }
                    }
                }))
            }
            (detail_row("Status", html! {
                (badge(&order.status, status))
                @if let Some(reason) = &order.failure_reason {
                    span class="ml-2 text-neutral-500" { (reason) }
                }
            }))
            (detail_row("Price", html! {
                (format_usd(order.final_usd_cents)) " (list " (format_usd(order.base_usd_cents))
                ", campaign " (order.campaign_percent) "%, Plus member " (order.premium_percent) "%)"
            }))
            (detail_row("Charged", html! {
                (format_azn(order.amount_azn_minor)) " at " (order.usd_to_azn_rate) " AZN per USD"
            }))
            (detail_row("Payriff order", html! {
                span class="font-mono" { (order.provider_order_id.as_deref().unwrap_or("—")) }
                " · " (order.provider_status.as_deref().unwrap_or("no status yet"))
            }))
            (detail_row("Reconcile checks", html! { (order.check_count) }))
            (detail_row("Created", html! { (format_admin_timestamp(&order.created_at)) }))
            (detail_row("Paid", html! { (time(order.paid_at.as_deref())) }))
            (detail_row("Delivered", html! { (time(order.granted_at.as_deref())) }))
        }
    }
}

fn sales_card(base: &str, csrf_token: &str, shop: &ShopAdmin) -> Markup {
    let settings = &shop.settings;
    let now = OffsetDateTime::now_utc();
    let rate_age = rate_age_days(settings.try_rate_date.as_deref(), now);
    let override_age = rate_age_days(settings.try_rate_override_at.as_deref(), now);
    html! {
        div class="flex flex-col gap-4" {
            h2 class="text-base font-semibold text-neutral-900" { "Sales" }
            @if !settings.payriff_configured {
                div {
                    (badge("Payriff is not configured: nothing sells until it is", BadgeVariant::Warning))
                }
            }
            form method="post" action={(base) "/shop?action=settings"} data-admin-result-form="true" {
                (csrf_input(csrf_token))
                div class="flex flex-col gap-4" {
                    div class="flex flex-col gap-2 sm:flex-row sm:gap-6" {
                        (checkbox("premium_sales_open", "true", "Plus sales open", settings.premium_sales_open, true))
                        (checkbox("item_sales_open", "true", "Item sales open (items and bundles)", settings.item_sales_open, true))
                    }
                    p class="text-xs text-neutral-500" {
                        "Off hides the buy buttons and the API refuses new orders. Paid orders still deliver."
                    }
                    div class="grid grid-cols-1 gap-4 sm:grid-cols-2" {
                        (form_field_group("USD → AZN rate", "shop-rate", true, None,
                            Some("Payriff charges USD × rate in AZN, rounded half up to 2 decimals."),
                            html! {
                                input type="number" id="shop-rate" name="usd_to_azn_rate"
                                    value=(rate_input_value(settings.usd_to_azn_rate_micro))
                                    step="0.0001" min="1" max="3" required[true] class=(FORM_INPUT_CLASS);
                            }))
                        (form_field_group("Plus member discount (%)", "shop-premium-discount", true, None,
                            Some("Items only, applied after any campaign."),
                            html! {
                                input type="number" id="shop-premium-discount" name="premium_discount_percent"
                                    value=(settings.premium_discount_percent)
                                    step="1" min="0" max="95" required[true] class=(FORM_INPUT_CLASS);
                            }))
                    }
                    div class="grid grid-cols-1 gap-4 sm:grid-cols-2" {
                        div class="space-y-2 text-sm text-neutral-600" {
                            h3 class="font-semibold text-neutral-900" { "Automatic CBAR rate (AZN per TRY)" }
                            p { (settings.try_to_azn_rate_micro.map(rate_input_value).unwrap_or_else(|| "Not available".to_owned())) }
                            p { "Bulletin date: " (settings.try_rate_date.as_deref().unwrap_or("Not available")) }
                            p { "Last successful fetch: " (settings.try_rate_fetched_at.as_deref().unwrap_or("Never")) }
                            @if let Some(days) = rate_age {
                                p { (days) " days old" }
                                @if days > 10 {
                                    (badge("Automatic rate is older than 10 days; TL is hidden unless an override is set.", BadgeVariant::Warning))
                                }
                            }
                        }
                        div class="space-y-2 text-sm text-neutral-600" {
                            (form_field_group("TRY → AZN override", "shop-try-override", false, None,
                                Some("Blank uses the automatic rate. This only changes the TL estimate; AZN charges stay the same."),
                                html! {
                                    input type="number" id="shop-try-override" name="try_to_azn_rate_override"
                                        value=(settings.try_to_azn_rate_override_micro.map(rate_input_value).unwrap_or_default())
                                        step="0.000001" min="0.001" max="1" class=(FORM_INPUT_CLASS);
                                }))
                            @if settings.try_to_azn_rate_override_micro.is_some() {
                                p { "Override set: " (settings.try_rate_override_at.as_deref().unwrap_or("Unknown")) }
                                @if let Some(days) = override_age {
                                    p { (days) " days old" }
                                }
                            }
                            (badge("TRY loses ~1.3% of its value per month; review overrides regularly.", BadgeVariant::Warning))
                        }
                    }
                    (form_actions(html! { (submit_button("Save settings")) }))
                }
            }
            form method="post" action={(base) "/shop?action=refresh_try_rate"} data-admin-result-form="true" {
                (csrf_input(csrf_token))
                (submit_button("Fetch now"))
            }
            (health_line(&shop.health))
        }
    }
}

// Match the API's bulletin age: calendar days in Asia/Baku, independently of the fetch time.
fn rate_age_days(value: Option<&str>, now: OffsetDateTime) -> Option<i64> {
    let value = value?;
    let at = if value.len() == 10 {
        OffsetDateTime::parse(&format!("{value}T00:00:00+04:00"), &Rfc3339)
    } else {
        OffsetDateTime::parse(value, &Rfc3339)
    }
    .ok()?;
    let baku = UtcOffset::from_hms(4, 0, 0).expect("UTC+4 is a valid offset");
    Some(
        (now.to_offset(baku).date() - at.to_offset(baku).date())
            .whole_days()
            .max(0),
    )
}

fn health_line(health: &ShopAdminHealth) -> Markup {
    let busy = health.busy_refusals_last_hour;
    let lag_minutes = health.reconcile_lag_seconds / 60;
    html! {
        div class="flex flex-col gap-2 border-t border-neutral-200 pt-4" {
            div class="flex flex-wrap items-center gap-2 text-sm text-neutral-600" {
                span class="font-medium text-neutral-900" { "Payriff health" }
                @if busy > 0 {
                    (badge(&format!("Orders refused as busy in the last hour: {busy}"), BadgeVariant::Warning))
                } @else {
                    span { "No busy refusals in the last hour." }
                }
                @if health.reconcile_lag_seconds > RECONCILE_LAG_WARNING_SECONDS {
                    (badge(&format!("Reconcile {lag_minutes} min behind"), BadgeVariant::Warning))
                } @else {
                    span { "Reconcile on time." }
                }
                @if health.payriff_backing_off {
                    (badge("Payriff answered 429; every order waits while we are backing off", BadgeVariant::Warning))
                }
            }
            p class="text-xs text-neutral-500" {
                "A warning here means today's Payriff rate limit is too small: ask Payriff for a higher one."
            }
        }
    }
}

// Visionary price, sale switch, numbered stock, and rewards.
fn visionary_card(
    base: &str,
    csrf_token: &str,
    shop: &ShopAdmin,
    data: &ShopPageData<'_>,
) -> Markup {
    let on_sale = shop.settings.visionary_on_sale;
    let price = price_row(shop, "visionary")
        .map(|row| format_usd(row.base_usd_cents)[1..].to_owned())
        .unwrap_or_default();
    let total = data
        .visionary
        .map(|stock| stock.total.to_string())
        .unwrap_or_default();
    html! {
        div class="flex flex-col gap-4" {
            div class="flex flex-wrap items-center gap-2" {
                h2 class="text-base font-semibold text-neutral-900" { "Visionary" }
                @if on_sale {
                    (badge("On sale", BadgeVariant::Success))
                } @else {
                    (badge("Hidden", BadgeVariant::Default))
                }
            }
            p class="text-sm text-neutral-500" {
                "Lifetime Plus with a numbered badge, #0000 and the reward decorations below. \
                 A number is never sold twice."
            }
            (visionary_stock(data.visionary))
            div class="grid grid-cols-1 gap-4 sm:grid-cols-2" {
                form method="post" action={(base) "/shop?action=visionary_price"}
                    data-admin-result-form="true" class="flex flex-col gap-4" {
                    (csrf_input(csrf_token))
                    (form_field_group("Price (USD)", "visionary-price", false, None,
                        Some("Blank takes Visionary out of the shop. A campaign from the table below \
                              applies; the Plus member discount never does."),
                        html! {
                            input type="number" id="visionary-price" name="visionary_price" value=(price)
                                step="0.01" min="0.01" class=(FORM_INPUT_CLASS);
                        }))
                    (form_actions(html! { (submit_button("Save price")) }))
                }
                form method="post" action={(base) "/shop?action=visionary_slots"}
                    data-admin-result-form="true" class="flex flex-col gap-4" {
                    (csrf_input(csrf_token))
                    (form_field_group("Numbers", "visionary-total", true, None,
                        Some("How many numbers exist. Sold and held numbers cannot be removed."),
                        html! {
                            input type="number" id="visionary-total" name="total" value=(total)
                                step="1" min="0" max="100000" required[true] class=(FORM_INPUT_CLASS);
                        }))
                    (form_actions(html! { (submit_button("Set total")) }))
                }
            }
            form method="post" action={(base) "/shop?action=visionary_sale"}
                data-admin-result-form="true" class="flex flex-col gap-2" {
                (csrf_input(csrf_token))
                input type="hidden" name="visionary_on_sale" value=(if on_sale { "false" } else { "true" });
                (form_actions(html! { (submit_button(if on_sale { "Hide" } else { "Put on sale" })) }))
                p class="text-xs text-neutral-500" {
                    "Hidden takes the card off the Plus page and refuses new orders; paid orders \
                     still deliver. Visionary also needs Plus sales open."
                }
            }
            (visionary_rewards(base, csrf_token, shop, data.items))
        }
    }
}

fn visionary_stock(stock: Option<&ShopAdminVisionary>) -> Markup {
    let Some(stock) = stock else {
        return error_alert("Failed to load the Visionary numbers.");
    };
    let over_cap = stock.over_cap_grants > 0;
    // TEMPORARY: warn when unpaid orders hold more than half of the remaining numbers.
    let many_held = stock.held > stock.remaining / 2;
    html! {
        div class="flex flex-col gap-2" {
            div class="flex flex-wrap items-center gap-2 text-sm" {
                span class="font-medium text-neutral-900" {
                    (format!(
                        "Total {} · Sold {} · Held {} · Left {}",
                        stock.total, stock.sold, stock.held, stock.remaining
                    ))
                }
                @if over_cap {
                    (badge(&format!("Over the total: {}", stock.over_cap_grants), BadgeVariant::Warning))
                }
                @if many_held {
                    (badge("Many numbers held", BadgeVariant::Warning))
                }
            }
            @if over_cap || many_held {
                p class="text-xs text-neutral-500" {
                    "Over the total: payments that arrived after their 15-minute hold still got a \
                     number, above the total. Many numbers held: unpaid orders hold more than half of \
                     the numbers left."
                }
            }
        }
    }
}

// Only owned-only items without a price can be rewards; the API refuses the rest.
fn visionary_rewards(
    base: &str,
    csrf_token: &str,
    shop: &ShopAdmin,
    items: Option<&[CosmeticItem]>,
) -> Markup {
    let chosen = &shop.settings.visionary_reward_item_ids;
    html! {
        div class="flex flex-col gap-2 border-t border-neutral-200 pt-4" {
            h3 class="text-sm font-semibold text-neutral-900" { "Reward decorations" }
            p class="text-xs text-neutral-500" {
                "Given and worn with every Visionary number, at most 10. Only owned-only items \
                 without a price and in no bundle are offered. A decoration added later does not \
                 reach earlier \
                 Visionaries."
            }
            @match items {
                None => p class="text-sm text-neutral-500" {
                    "Picking rewards needs the cosmetics:manage permission. Rewards now: "
                    @if chosen.is_empty() { "none" } @else { (chosen.join(", ")) }
                },
                Some(items) => {
                    @let options: Vec<(String, String)> = owned_item_options(items)
                        .into_iter()
                        .filter(|(id, _)| price_row(shop, &format!("cosmetic:{id}")).is_none())
                        // The API also refuses an item that is in a bundle.
                        .filter(|(id, _)| !shop.bundles.iter().any(|bundle| bundle.item_ids.contains(id)))
                        .collect();
                    form method="post" action={(base) "/shop?action=visionary_rewards"}
                        data-admin-result-form="true" class="flex flex-col gap-4" {
                        (csrf_input(csrf_token))
                        @if options.is_empty() {
                            p class="text-sm text-neutral-500" { "No owned-only item without a price." }
                        }
                        div class="grid grid-cols-1 gap-2 sm:grid-cols-2" {
                            @for (id, label) in &options {
                                (checkbox("reward_item_ids", id, label, chosen.contains(id), true))
                            }
                        }
                        (form_actions(html! { (submit_button("Save rewards")) }))
                    }
                }
            }
        }
    }
}

// Bundles contain 2–10 owned-only items sold as one product, `bundle:<id>`,
// priced in the table below. The create and edit forms pick items by name, so they need
// COSMETICS_MANAGE; deleting needs no names.
fn bundles_card(
    base: &str,
    csrf_token: &str,
    shop: &ShopAdmin,
    items: Option<&[CosmeticItem]>,
) -> Markup {
    let rewards = &shop.settings.visionary_reward_item_ids;
    let options: Option<Vec<(String, String)>> = items.map(|items| {
        owned_item_options(items)
            .into_iter()
            .filter(|(id, _)| !rewards.contains(id))
            .collect()
    });
    html! {
        div class="flex flex-col gap-4" {
            h2 class="text-base font-semibold text-neutral-900" { "Bundles" }
            p class="text-sm text-neutral-500" {
                "2–10 owned-only items sold together. A bundle sells once it has a price in the table \
                 below; deleting it deletes its price too. Paid orders keep the items they were sold with."
            }
            @if shop.bundles.is_empty() {
                p class="text-sm text-neutral-500" { "No bundles yet." }
            }
            @for bundle in &shop.bundles {
                div class="flex flex-col gap-2 border-t border-neutral-200 pt-4" {
                    div class="flex flex-wrap items-center gap-2" {
                        span class="font-medium text-neutral-900 text-sm" { (bundle.name) }
                        span class="font-mono text-neutral-400 text-xs" { (bundle.sku) }
                        @if price_row(shop, &bundle.sku).is_none() {
                            (badge("not in the shop", BadgeVariant::Default))
                        }
                    }
                    @if let Some(description) = &bundle.description {
                        p class="text-xs text-neutral-500" { (description) }
                    }
                    p class="text-sm text-neutral-700" { (item_names(items, &bundle.item_ids)) }
                    @if let Some(options) = &options {
                        details {
                            summary class="cursor-pointer font-medium text-blue-600 text-sm" { "Edit" }
                            div class="pt-4" {
                                (bundle_form(base, csrf_token, Some(bundle), options, items))
                            }
                        }
                    }
                    form method="post" action={(base) "/shop?action=bundle_delete"}
                        data-admin-result-form="true"
                        hx-confirm={"Delete the bundle " (bundle.name) " and its price?"} {
                        (csrf_input(csrf_token))
                        input type="hidden" name="bundle_id" value=(bundle.id);
                        (danger_button("Delete"))
                    }
                }
            }
            @match &options {
                None => p class="text-sm text-neutral-500" {
                    "Creating and changing bundles needs the cosmetics:manage permission."
                },
                Some(options) => div class="flex flex-col gap-4 border-t border-neutral-200 pt-4" {
                    h3 class="text-sm font-semibold text-neutral-900" { "Create bundle" }
                    (bundle_form(base, csrf_token, None, options, items))
                },
            }
        }
    }
}

// TEMPORARY: every edit form carries the whole picker; trigger: (bundles+1) × owned items > ~20 000 boxes; path: open one edit form with ?bundle=<id> (cosmetics ?edit= pattern).
// The bundle's own items come first, in bundle order, so saving an unchanged list never reorders it.
// One that left the picker stays ticked, so saving never drops it unseen (the API refuses it instead).
fn bundle_form(
    base: &str,
    csrf_token: &str,
    bundle: Option<&ShopAdminBundle>,
    options: &[(String, String)],
    items: Option<&[CosmeticItem]>,
) -> Markup {
    let (action, key, button) = match bundle {
        Some(bundle) => ("bundle_update", bundle.id.as_str(), "Save bundle"),
        None => ("bundle_create", "new", "Create bundle"),
    };
    let chosen = bundle
        .map(|bundle| bundle.item_ids.as_slice())
        .unwrap_or_default();
    let chosen_label = |id: &String| match options.iter().find(|(option, _)| option == id) {
        Some((_, label)) => label.clone(),
        None => item_names(items, std::slice::from_ref(id)) + " (no longer offered)",
    };
    let name_id = format!("bundle-{key}-name");
    let description_id = format!("bundle-{key}-description");
    let name = bundle.map_or("", |bundle| bundle.name.as_str());
    let description = bundle
        .and_then(|bundle| bundle.description.as_deref())
        .unwrap_or("");
    html! {
        form method="post" action={(base) "/shop?action=" (action)}
            data-admin-result-form="true" class="flex flex-col gap-4" {
            (csrf_input(csrf_token))
            @if let Some(bundle) = bundle {
                input type="hidden" name="bundle_id" value=(bundle.id);
            }
            div class="grid grid-cols-1 gap-4 sm:grid-cols-2" {
                (form_field_group("Name", &name_id, true, None, Some("1–64 characters."),
                    text_field(&name_id, "name", name, 64, true)))
                (form_field_group("Description", &description_id, false, None,
                    Some("Optional, up to 256 characters."),
                    text_field(&description_id, "description", description, 256, false)))
            }
            div class="grid grid-cols-1 gap-2 sm:grid-cols-2" {
                @for id in chosen {
                    (checkbox("item_ids", id, &chosen_label(id), true, true))
                }
                @for (id, label) in options.iter().filter(|(id, _)| !chosen.contains(id)) {
                    (checkbox("item_ids", id, label, false, true))
                }
            }
            p class="text-xs text-neutral-500" {
                "2–10 items, kept in this order; delivery wears the first item of each type."
            }
            (form_actions(html! { (submit_button(button)) }))
        }
    }
}

// Names in the given order; an ID when the item list is missing (no COSMETICS_MANAGE) or lacks the item.
fn item_names(items: Option<&[CosmeticItem]>, ids: &[String]) -> String {
    let items = items.unwrap_or_default();
    ids.iter()
        .map(|id| {
            items
                .iter()
                .find(|item| &item.id == id)
                .map_or(id.as_str(), |item| item.name.as_str())
        })
        .collect::<Vec<_>>()
        .join(", ")
}

fn prices_card(
    config: &AdminConfig,
    csrf_token: &str,
    shop: &ShopAdmin,
    data: &ShopPageData<'_>,
) -> Markup {
    let base = &config.base_path;
    let rows = product_rows(config, shop, data.items);
    let visible: Vec<&ProductRow<'_>> = rows
        .iter()
        .filter(|row| data.product_type.is_empty() || row.kind == data.product_type)
        .collect();
    html! {
        div class="flex flex-col gap-4" {
            div class="flex flex-wrap items-end justify-between gap-4" {
                h2 class="text-base font-semibold text-neutral-900" { "Prices and campaigns" }
                form method="get" action={(base) "/shop"} class="flex items-end gap-2" {
                    div class="w-48" { (select_input("type", "Type", PRODUCT_TYPES, data.product_type)) }
                    (submit_button("Filter"))
                }
            }
            form id="shop-prices-form" method="post" action={(base) "/shop?action=save_prices"}
                data-admin-result-form="true" {
                (csrf_input(csrf_token))
                div class="flex flex-col gap-4" {
                    (table_container(table(html! {
                        (table_head(html! {
                            tr {
                                th class="px-3 py-3 sm:px-6" {
                                    input type="checkbox" data-shop-select-all="true"
                                        aria-label="Select every product";
                                }
                                @for header in ["Image", "Product", "Price (USD)", "Campaign", "Now"] {
                                    (table_header_cell(header))
                                }
                            }
                        }))
                        (table_body(html! {
                            @for row in &visible {
                                (product_row(row))
                            }
                        }))
                    })))
                    p class="text-xs text-neutral-500" {
                        "A blank price takes the product out of the shop. Only changed prices are saved."
                    }
                    (form_actions(html! { (submit_button("Save prices")) }))
                }
            }
            // Its own form, so Enter in a campaign field never submits "Save prices"; the row
            // checkboxes join it through their form attribute.
            form id="shop-campaign-form" method="post" action={(base) "/shop?action=apply_campaign"}
                data-admin-result-form="true" class="flex flex-col gap-4 border-t border-neutral-200 pt-4" {
                (csrf_input(csrf_token))
                h3 class="text-sm font-semibold text-neutral-900" { "Campaign for selected" }
                div class="grid grid-cols-1 gap-4 sm:grid-cols-2" {
                    (form_field_group("Discount (%)", "shop-campaign-percent", false, None, Some("1–95."),
                        html! {
                            input type="number" id="shop-campaign-percent" name="discount_percent"
                                step="1" min="1" max="95" class=(FORM_INPUT_CLASS);
                        }))
                    (form_field_group("Ends at", "shop-campaign-ends", false, None,
                        Some("Turkey time (UTC+3). Blank = no end."),
                        html! {
                            input type="datetime-local" id="shop-campaign-ends" name="ends_at"
                                class=(FORM_INPUT_CLASS);
                        }))
                }
                div class="flex flex-wrap gap-2" {
                    button type="submit" formaction={(base) "/shop?action=apply_campaign"}
                        class=(PRIMARY_BUTTON_CLASS) {
                        span { "Apply campaign to selected" }
                    }
                    button type="submit" formaction={(base) "/shop?action=remove_campaign"}
                        class=(SECONDARY_BUTTON_CLASS) {
                        span { "Remove campaign from selected" }
                    }
                }
            }
        }
    }
}

// The three premium packages and Visionary, every bundle, every owned-only item, then any priced item or
// bundle the lists did not return (no COSMETICS_MANAGE, the item is no longer owned-only, or the bundle
// was deleted while someone priced it).
fn product_rows<'a>(
    config: &AdminConfig,
    shop: &'a ShopAdmin,
    items: Option<&'a [CosmeticItem]>,
) -> Vec<ProductRow<'a>> {
    let mut rows: Vec<ProductRow<'a>> = PACKAGES
        .iter()
        .map(|(sku, label)| ProductRow {
            sku: (*sku).to_owned(),
            kind: "premium",
            label: (*label).to_owned(),
            image: None,
            price: price_row(shop, sku),
            reward: false,
        })
        .collect();
    rows.extend(shop.bundles.iter().map(|bundle| ProductRow {
        sku: bundle.sku.clone(),
        kind: "bundle",
        label: format!(
            "Bundle · {} ({})",
            bundle.name,
            count_of(bundle.item_ids.len(), "item")
        ),
        image: None,
        price: price_row(shop, &bundle.sku),
        reward: false,
    }));
    for item in items.unwrap_or_default() {
        if item.availability != "owned" {
            continue;
        }
        let sku = format!("cosmetic:{}", item.id);
        rows.push(ProductRow {
            price: price_row(shop, &sku),
            sku,
            kind: &item.item_type,
            label: format!(
                "{} ({})",
                item.name,
                option_label(PRODUCT_TYPES, &item.item_type)
            ),
            image: Some(item_image_url(config, item)),
            reward: shop.settings.visionary_reward_item_ids.contains(&item.id),
        });
    }
    for price in &shop.prices {
        let kind = match price.sku.split(':').next() {
            Some("cosmetic") => "",
            Some("bundle") => "bundle",
            _ => continue,
        };
        if !rows.iter().any(|row| row.sku == price.sku) {
            rows.push(ProductRow {
                sku: price.sku.clone(),
                kind,
                label: price.sku.clone(),
                image: None,
                price: Some(price),
                reward: false,
            });
        }
    }
    rows
}

fn price_row<'a>(shop: &'a ShopAdmin, sku: &str) -> Option<&'a ShopAdminPriceRow> {
    shop.prices.iter().find(|row| row.sku == sku)
}

// Same media path as the cosmetics catalog, whose helper is private to that page.
fn item_image_url(config: &AdminConfig, item: &CosmeticItem) -> String {
    format!(
        "{}/branding/cosmetic-{}-{}/{}.webp?size=128",
        config.media_endpoint.trim_end_matches('/'),
        item.item_type,
        item.id,
        item.asset
    )
}

fn product_row(row: &ProductRow<'_>) -> Markup {
    let price_value = row
        .price
        .map(|price| format_usd(price.base_usd_cents)[1..].to_owned())
        .unwrap_or_default();
    html! {
        tr class="hover:bg-neutral-50 transition-colors" {
            td class="px-3 py-3 sm:px-6" {
                @if !row.reward {
                    input type="checkbox" name="product_ids" value=(row.sku) form="shop-campaign-form"
                        aria-label={"Select " (row.label)};
                    input type="hidden" name="rows" value=(row.sku);
                    input type="hidden" name={"was_" (row.sku)} value=(price_value);
                }
            }
            td class="px-3 py-3 sm:px-6" {
                @if let Some(image) = &row.image {
                    img src=(image) alt="" loading="lazy" class="h-10 w-10 object-contain";
                }
            }
            td class="px-3 py-3 text-sm sm:px-6" {
                div class="font-medium text-neutral-900" { (row.label) }
                div class="font-mono text-neutral-400 text-xs" { (row.sku) }
            }
            td class="px-3 py-3 sm:px-6" {
                @if row.reward {
                    span class="text-neutral-500 text-sm" { "Visionary reward: cannot be sold" }
                } @else {
                    div class="w-28" {
                        input type="number" name={"price_" (row.sku)} value=(price_value) step="0.01" min="0.01"
                            aria-label={"Price of " (row.label) " in USD"} class=(FORM_INPUT_CLASS);
                    }
                }
            }
            td class="px-3 py-3 text-sm sm:px-6" { (campaign_label(row.price)) }
            td class="px-3 py-3 text-sm sm:px-6" { (now_label(row.price)) }
        }
    }
}

fn campaign_label(price: Option<&ShopAdminPriceRow>) -> Markup {
    let Some((price, percent)) = price.and_then(|price| Some((price, price.campaign_percent?)))
    else {
        return html! { span class="text-neutral-400" { "—" } };
    };
    let until = price
        .campaign_ends_at
        .as_deref()
        .map(|at| format!(" until {}", turkey_time_label(at)))
        .unwrap_or_default();
    let label = format!("−{percent}%{until}");
    html! {
        @if price.now.campaign_percent.is_some() {
            (badge(&label, BadgeVariant::Info))
        } @else {
            span class="text-neutral-400" { (label) " · ended" }
        }
    }
}

// What the shop shows right now, as the API computed it.
fn now_label(price: Option<&ShopAdminPriceRow>) -> Markup {
    html! {
        @match price {
            None => span class="text-neutral-400" { "not in shop" },
            Some(price) => {
                span class="font-medium text-neutral-900" { (format_usd(price.now.sale_usd_cents)) }
                @if let Some(premium) = price.now.premium_usd_cents {
                    span class="text-neutral-500" { " · Plus " (format_usd(premium)) }
                }
            }
        }
    }
}

// 1_700_000 shows as "1.7000"; a rate set with more decimals keeps them, so saving never rounds it.
fn rate_input_value(micro: i32) -> String {
    let (whole, fraction) = (micro / 1_000_000, micro % 1_000_000);
    if fraction % 100 == 0 {
        format!("{whole}.{:04}", fraction / 100)
    } else {
        format!("{whole}.{fraction:06}")
    }
}

fn format_azn(minor: i32) -> String {
    format!("{}.{:02} AZN", minor / 100, minor % 100)
}
