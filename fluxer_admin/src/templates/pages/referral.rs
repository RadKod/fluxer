// SPDX-License-Identifier: AGPL-3.0-or-later

use crate::{
    api::types::{
        AdminReferral, AdminReferralPendingReward, AdminReferralPendingRewards,
        AdminReferralSettings, AdminUserReferrals, CosmeticItem, FlashMessage, ReferralReward,
        ReferralTier,
    },
    config::AdminConfig,
    middleware::auth::AuthContext,
    templates::{
        components::{
            badge::{BadgeVariant, badge},
            error_display::error_alert,
            form::{
                FORM_INPUT_CLASS, FORM_SELECT_CLASS, FORM_TEXTAREA_CLASS, checkbox, csrf_input,
                form_actions, form_field_group, submit_button,
            },
            page_container::{card, detail_row, page_header_with_actions, page_header_with_back},
            table::{
                empty_state, table, table_body, table_cell, table_container, table_head,
                table_header_cell, table_row,
            },
        },
        layout::admin_layout,
        pages::cosmetics::owned_item_options,
    },
    utils::timestamps::format_admin_timestamp,
};
use maud::{Markup, html};

// The text a support notice starts from; the admin edits it before sending.
const NOTICE_TEXT: &str = "Referans ödülün için destek ekibimize yaz.";
const REWARD_TYPES: &[(&str, &str)] = &[
    ("premium_days", "Plus days"),
    ("offsite", "Off-site (handled by an admin)"),
    ("cosmetic", "Decoration (owned-only item)"),
];

pub struct ReferralPageData<'a> {
    pub referral: Option<&'a AdminReferral>,
    pub pending: Option<&'a AdminReferralPendingRewards>,
    pub items: Option<&'a [CosmeticItem]>,
    /// The month the pending list shows, `YYYY-MM`.
    pub month: &'a str,
    /// The last three months, newest first.
    pub months: &'a [MonthCount<'a>],
}

pub struct MonthCount<'a> {
    pub month: &'a str,
    /// Rewards waiting on the month's first page and whether more pages follow; None when the count failed.
    pub count: Option<(usize, bool)>,
}

pub struct ReferralUserPageData<'a> {
    pub user_id: &'a str,
    pub referrals: Option<&'a AdminUserReferrals>,
}

pub fn referral_page(
    config: &AdminConfig,
    auth: &AuthContext,
    csrf_token: &str,
    flash: Option<&FlashMessage>,
    data: &ReferralPageData<'_>,
) -> Markup {
    let base = &config.base_path;
    let content = html! {
        div class="space-y-6" {
            (page_header_with_actions(
                "Referral",
                Some("Members invite others with a personal link. A referral counts once the new account \
                      verified its email and stayed active; tiers reward the number of valid referrals."),
                html! {},
            ))
            @match data.referral {
                None => (error_alert("Failed to load the referral settings.")),
                Some(referral) => {
                    (card(settings_card(base, csrf_token, &referral.settings)))
                    (card(tiers_card(base, csrf_token, referral, data.items)))
                }
            }
            (card(pending_card(base, csrf_token, data)))
        }
    };
    admin_layout(config, auth, "Referral", "referral", flash, content)
}

fn settings_card(base: &str, csrf_token: &str, settings: &AdminReferralSettings) -> Markup {
    html! {
        div class="flex flex-col gap-4" {
            div class="flex flex-wrap items-center gap-2" {
                h2 class="text-base font-semibold text-neutral-900" { "Settings" }
                @if settings.enabled {
                    (badge("On", BadgeVariant::Success))
                } @else {
                    (badge("Off", BadgeVariant::Default))
                }
            }
            form method="post" action={(base) "/referral?action=settings"} data-admin-result-form="true"
                class="flex flex-col gap-4" {
                (csrf_input(csrf_token))
                (checkbox("enabled", "true", "Referral is on", settings.enabled, true))
                p class="text-xs text-neutral-500" {
                    "Off hides the Referral tab for members and stops new referrals from counting; \
                     codes and rewards already earned stay."
                }
                div class="grid grid-cols-1 gap-4 sm:grid-cols-3" {
                    (number_field("Active days needed", "referral-days", "min_active_days",
                        settings.min_active_days, 1, 30,
                        "Days the new account must stay active after joining."))
                    (number_field("Valid referrals per day", "referral-cap", "daily_valid_cap",
                        settings.daily_valid_cap, 1, 10_000,
                        "Above this the rest count the next day."))
                    (number_field("Sign-ups per IP", "referral-ip", "ip_registration_limit",
                        settings.ip_registration_limit, 1, 100,
                        "More from one address in a day are refused as fake."))
                }
                (form_actions(html! { (submit_button("Save settings")) }))
            }
        }
    }
}

fn number_field(
    label: &str,
    id: &str,
    name: &str,
    value: i32,
    min: u32,
    max: u32,
    help: &str,
) -> Markup {
    form_field_group(
        label,
        id,
        true,
        None,
        Some(help),
        html! {
            input type="number" id=(id) name=(name) value=(value) min=(min) max=(max) step="1"
                required class=(FORM_INPUT_CLASS);
        },
    )
}

fn tiers_card(
    base: &str,
    csrf_token: &str,
    referral: &AdminReferral,
    items: Option<&[CosmeticItem]>,
) -> Markup {
    let owned = items.map(owned_item_options);
    html! {
        div class="flex flex-col gap-4" {
            h2 class="text-base font-semibold text-neutral-900" { "Tiers" }
            p class="text-sm text-neutral-500" {
                "A member earns a tier's reward at its number of valid referrals. Turning a tier on, \
                 or lowering its number, also rewards members who already passed it."
            }
            @if referral.tiers.is_empty() {
                (empty_state("No tiers yet."))
            } @else {
                (table_container(table(html! {
                    (table_head(html! {
                        tr {
                            @for header in ["Valid referrals", "Reward", "Status", ""] {
                                (table_header_cell(header))
                            }
                        }
                    }))
                    (table_body(html! {
                        @for tier in &referral.tiers {
                            (tier_row(base, csrf_token, tier, items))
                        }
                    }))
                })))
            }
            div class="flex flex-col gap-4 border-t border-neutral-200 pt-4" {
                h3 class="text-sm font-semibold text-neutral-900" { "Add tier" }
                (tier_form(base, csrf_token, owned.as_deref()))
            }
        }
    }
}

fn tier_row(
    base: &str,
    csrf_token: &str,
    tier: &ReferralTier,
    items: Option<&[CosmeticItem]>,
) -> Markup {
    html! {
        (table_row(html! {
            (table_cell(false, html! { (tier.threshold) }))
            (table_cell(false, html! { (reward_label(&tier.reward, items)) }))
            (table_cell(false, html! {
                @if tier.enabled {
                    (badge("On", BadgeVariant::Success))
                } @else {
                    (badge("Off", BadgeVariant::Default))
                }
            }))
            (table_cell(false, html! {
                div class="flex flex-col gap-2" {
                    form method="post" action={(base) "/referral?action=tier_toggle"}
                        data-admin-result-form="true" {
                        (csrf_input(csrf_token))
                        input type="hidden" name="tier_id" value=(tier.id);
                        input type="hidden" name="enabled" value=(if tier.enabled { "false" } else { "true" });
                        (submit_button(if tier.enabled { "Turn off" } else { "Turn on" }))
                    }
                    details {
                        summary class="cursor-pointer font-medium text-blue-600 text-sm" { "Edit" }
                        div class="pt-4" { (tier_edit_form(base, csrf_token, tier, items)) }
                    }
                }
            }))
        }))
    }
}

// A tier's reward cannot change, members may already have earned it: editing moves the threshold or
// turns the tier on or off. A different reward is a new tier, with this one turned off.
fn tier_edit_form(
    base: &str,
    csrf_token: &str,
    tier: &ReferralTier,
    items: Option<&[CosmeticItem]>,
) -> Markup {
    let id = format!("tier-{}-threshold", tier.id);
    html! {
        form method="post" action={(base) "/referral?action=tier_update"}
            data-admin-result-form="true" class="flex flex-col gap-4" {
            (csrf_input(csrf_token))
            input type="hidden" name="tier_id" value=(tier.id);
            (form_field_group("Valid referrals", &id, true, None,
                Some("1–1000000. Lowering it also rewards members between the old and the new number."),
                html! {
                    input type="number" id=(id) name="threshold" value=(tier.threshold)
                        min="1" max="1000000" step="1" required class=(FORM_INPUT_CLASS);
                }))
            (checkbox("enabled", "true", "Tier is on", tier.enabled, true))
            p class="text-xs text-neutral-500" {
                "Reward: " (reward_label(&tier.reward, items)) ". It cannot be changed; add a new tier \
                 and turn this one off instead."
            }
            (form_actions(html! { (submit_button("Save tier")) }))
        }
    }
}

// Only the field of the chosen reward type is read; the others stay filled so switching the type
// back loses nothing. A decoration can only be picked from the owned-only items, which needs
// COSMETICS_MANAGE; without it the decoration type is not offered.
fn tier_form(base: &str, csrf_token: &str, owned: Option<&[(String, String)]>) -> Markup {
    let item_options = owned.unwrap_or_default();
    let types: Vec<(&str, &str)> = REWARD_TYPES
        .iter()
        .copied()
        .filter(|(value, _)| *value != "cosmetic" || !item_options.is_empty())
        .collect();
    html! {
        form method="post" action={(base) "/referral?action=tier_create"}
            data-admin-result-form="true" class="flex flex-col gap-4" {
            (csrf_input(csrf_token))
            div class="grid grid-cols-1 gap-4 sm:grid-cols-2" {
                (form_field_group("Valid referrals", "tier-new-threshold", true, None,
                    Some("1–1000000."),
                    html! {
                        input type="number" id="tier-new-threshold" name="threshold"
                            min="1" max="1000000" step="1" required class=(FORM_INPUT_CLASS);
                    }))
                (form_field_group("Reward type", "tier-new-type", true, None, None,
                    html! {
                        select id="tier-new-type" name="reward_type" class=(FORM_SELECT_CLASS) {
                            @for (value, label) in &types {
                                option value=(value) { (label) }
                            }
                        }
                    }))
                (form_field_group("Plus days", "tier-new-days", false, None,
                    Some("Used for the Plus days type: 1–3650."),
                    html! {
                        input type="number" id="tier-new-days" name="days" value="30"
                            min="1" max="3650" step="1" class=(FORM_INPUT_CLASS);
                    }))
                @if !item_options.is_empty() {
                    (form_field_group("Decoration", "tier-new-item", false, None,
                        Some("Used for the Decoration type. Only items sold as owned are offered."),
                        html! {
                            select id="tier-new-item" name="item_id" class=(FORM_SELECT_CLASS) {
                                @for (id, label) in item_options {
                                    option value=(id) { (label) }
                                }
                            }
                        }))
                }
                (form_field_group("Off-site description", "tier-new-description", false, None,
                    Some("Used for the Off-site type: what members earn, 1–200 characters."),
                    html! {
                        input type="text" id="tier-new-description" name="description"
                            maxlength="200" class=(FORM_INPUT_CLASS);
                    }))
            }
            (checkbox("enabled", "true", "Tier is on", true, true))
            (form_actions(html! { (submit_button("Add tier")) }))
        }
    }
}

fn pending_card(base: &str, csrf_token: &str, data: &ReferralPageData<'_>) -> Markup {
    let month = data.month;
    html! {
        div class="flex flex-col gap-4" {
            div class="flex flex-wrap items-end justify-between gap-4" {
                h2 class="text-base font-semibold text-neutral-900" { "Rewards waiting for an admin" }
                form method="get" action={(base) "/referral"} class="flex items-end gap-2" {
                    div class="w-48" {
                        (form_field_group("Month", "referral-month", false, None, None, html! {
                            input type="month" id="referral-month" name="month" value=(month)
                                class=(FORM_INPUT_CLASS);
                        }))
                    }
                    (submit_button("Show"))
                }
            }
            p class="text-sm text-neutral-500" {
                "Off-site rewards are handled by hand. Paste the code the member should get, if there is \
                 one, and mark the reward delivered; the code is shown to the member only and never again here."
            }
            div class="flex flex-wrap gap-2" {
                @for entry in data.months {
                    a href={(base) "/referral?month=" (entry.month)} class="no-underline" {
                        @let label = match entry.count {
                            Some((count, true)) => format!("{} · {count}+", entry.month),
                            Some((count, false)) => format!("{} · {count}", entry.month),
                            None => format!("{} · ?", entry.month),
                        };
                        @let variant = if entry.month == month { BadgeVariant::Info } else { BadgeVariant::Default };
                        (badge(&label, variant))
                    }
                }
            }
            @match data.pending {
                None => (error_alert("Failed to load the waiting rewards.")),
                Some(page) if page.items.is_empty() => (empty_state("Nothing is waiting this month.")),
                Some(page) => {
                    (table_container(table(html! {
                        (table_head(html! {
                            tr {
                                @for header in ["Member", "Tier", "Reward", "Earned", ""] {
                                    (table_header_cell(header))
                                }
                            }
                        }))
                        (table_body(html! {
                            @for item in &page.items {
                                (pending_row(base, csrf_token, item, data, month))
                            }
                        }))
                    })))
                    @if let Some(cursor) = &page.next_cursor {
                        a href={(base) "/referral?month=" (month) "&cursor=" (urlencoding::encode(cursor))}
                            class="font-medium text-blue-600 text-sm hover:underline" { "Next page →" }
                    }
                }
            }
        }
    }
}

fn pending_row(
    base: &str,
    csrf_token: &str,
    item: &AdminReferralPendingReward,
    data: &ReferralPageData<'_>,
    month: &str,
) -> Markup {
    let threshold = data
        .referral
        .and_then(|referral| referral.tiers.iter().find(|tier| tier.id == item.tier_id))
        .map(|tier| tier.threshold.to_string());
    html! {
        (table_row(html! {
            (table_cell(false, html! {
                a href={(base) "/referral/users/" (item.user_id)}
                    class="font-mono text-blue-600 hover:underline" { (item.user_id) }
            }))
            (table_cell(false, html! { (threshold.as_deref().unwrap_or(&item.tier_id)) }))
            (table_cell(false, html! { (reward_label(&item.reward, data.items)) }))
            (table_cell(true, html! { (format_admin_timestamp(&item.created_at)) }))
            (table_cell(false, html! {
                div class="flex flex-col gap-2" {
                    details {
                        summary class="cursor-pointer font-medium text-blue-600 text-sm" { "Deliver" }
                        (deliver_form(base, csrf_token, item, month))
                    }
                    details {
                        summary class="cursor-pointer font-medium text-blue-600 text-sm" { "Send a notice" }
                        (notify_form(base, csrf_token, item, month))
                    }
                }
            }))
        }))
    }
}

// The code box is a password field that never gets a value: whatever is pasted goes to the API
// and is not shown again anywhere in the panel.
fn deliver_form(
    base: &str,
    csrf_token: &str,
    item: &AdminReferralPendingReward,
    month: &str,
) -> Markup {
    let key = format!("{}-{}", item.user_id, item.tier_id);
    html! {
        form method="post" action={(base) "/referral?action=deliver"}
            data-admin-result-form="true" class="flex flex-col gap-3 pt-3" {
            (csrf_input(csrf_token))
            (reward_hidden(item, month))
            (form_field_group("Code", &format!("deliver-{key}-code"), false, None,
                Some("Optional, up to 256 characters. The member sees it in their settings."),
                html! {
                    input type="password" id={"deliver-" (key) "-code"} name="code" autocomplete="off"
                        maxlength="256" class=(FORM_INPUT_CLASS);
                }))
            (form_field_group("Note", &format!("deliver-{key}-note"), false, None,
                Some("Optional, up to 500 characters. Only admins see it."),
                html! {
                    input type="text" id={"deliver-" (key) "-note"} name="note" maxlength="500"
                        class=(FORM_INPUT_CLASS);
                }))
            (form_actions(html! { (submit_button("Mark delivered")) }))
        }
    }
}

fn notify_form(
    base: &str,
    csrf_token: &str,
    item: &AdminReferralPendingReward,
    month: &str,
) -> Markup {
    let key = format!("{}-{}", item.user_id, item.tier_id);
    html! {
        form method="post" action={(base) "/referral?action=notify"}
            data-admin-result-form="true" class="flex flex-col gap-3 pt-3" {
            (csrf_input(csrf_token))
            (reward_hidden(item, month))
            (form_field_group("Message", &format!("notify-{key}-content"), true, None,
                Some("Sent as a direct message from the system account. It must not contain the code. \
                      The reward stays waiting."),
                html! {
                    textarea id={"notify-" (key) "-content"} name="content" rows="3" maxlength="2000"
                        required class=(FORM_TEXTAREA_CLASS) { (NOTICE_TEXT) }
                }))
            (form_actions(html! { (submit_button("Send notice")) }))
        }
    }
}

fn reward_hidden(item: &AdminReferralPendingReward, month: &str) -> Markup {
    html! {
        input type="hidden" name="user_id" value=(item.user_id);
        input type="hidden" name="tier_id" value=(item.tier_id);
        input type="hidden" name="month" value=(month);
    }
}

fn reward_label(reward: &ReferralReward, items: Option<&[CosmeticItem]>) -> String {
    match reward {
        ReferralReward::Cosmetic { item_id } => {
            let name = items
                .unwrap_or_default()
                .iter()
                .find(|item| &item.id == item_id)
                .map_or_else(|| format!("#{item_id}"), |item| item.name.clone());
            format!("Decoration {name}")
        }
        ReferralReward::PremiumDays { days } => format!("{days} days of Plus"),
        ReferralReward::Offsite { description } => format!("Off-site: {description}"),
    }
}

fn status_badge(status: &str) -> Markup {
    let variant = match status {
        "delivered" | "auto_delivered" => BadgeVariant::Success,
        "pending_admin" => BadgeVariant::Warning,
        _ => BadgeVariant::Default,
    };
    badge(status, variant)
}

pub fn referral_user_page(
    config: &AdminConfig,
    auth: &AuthContext,
    flash: Option<&FlashMessage>,
    data: &ReferralUserPageData<'_>,
) -> Markup {
    let base = &config.base_path;
    let user_id = data.user_id;
    let content = html! {
        div class="space-y-6" {
            (page_header_with_back(
                "Referrals",
                Some(&format!("Account {user_id}")),
                &format!("{base}/referral"),
                Some("Referral"),
            ))
            @match data.referrals {
                None => (error_alert("Failed to load this account's referrals.")),
                Some(referrals) => {
                    (card(user_summary(base, user_id, referrals)))
                    (card(user_rewards(referrals)))
                    (card(user_referees(base, user_id, referrals)))
                }
            }
        }
    };
    admin_layout(config, auth, "Referrals", "referral", flash, content)
}

fn user_summary(base: &str, user_id: &str, referrals: &AdminUserReferrals) -> Markup {
    let counts = &referrals.counts;
    html! {
        dl class="divide-y divide-neutral-100" {
            (detail_row("Account", html! {
                a href={(base) "/users/" (user_id)} class="font-mono text-blue-600 hover:underline" {
                    (user_id)
                }
            }))
            (detail_row("Own link code", html! {
                @match &referrals.code {
                    Some(code) => span class="font-mono" { (code) },
                    None => "none yet",
                }
            }))
            (detail_row("Invited by", html! {
                @match &referrals.referrer_id {
                    Some(referrer) => a href={(base) "/users/" (referrer)}
                        class="font-mono text-blue-600 hover:underline" { (referrer) },
                    None => "nobody",
                }
            }))
            (detail_row("Referrals", html! {
                (counts.valid) " valid · " (counts.pending) " pending · " (counts.rejected) " rejected"
            }))
        }
    }
}

fn user_rewards(referrals: &AdminUserReferrals) -> Markup {
    html! {
        div class="flex flex-col gap-4" {
            h2 class="text-base font-semibold text-neutral-900" { "Rewards" }
            @if referrals.rewards.is_empty() {
                (empty_state("No rewards yet."))
            } @else {
                (table_container(table(html! {
                    (table_head(html! {
                        tr {
                            @for header in ["Reward", "Status", "Earned", "Delivered", "Note"] {
                                (table_header_cell(header))
                            }
                        }
                    }))
                    (table_body(html! {
                        @for reward in &referrals.rewards {
                            (table_row(html! {
                                (table_cell(false, html! { (reward_label(&reward.reward, None)) }))
                                (table_cell(false, html! {
                                    (status_badge(&reward.status))
                                    @if reward.has_code {
                                        " " (badge("code on file", BadgeVariant::Info))
                                    }
                                }))
                                (table_cell(true, html! { (format_admin_timestamp(&reward.granted_at)) }))
                                (table_cell(true, html! {
                                    @if let Some(at) = &reward.delivered_at {
                                        (format_admin_timestamp(at))
                                        @if let Some(by) = &reward.delivered_by { " by " (by) }
                                    } @else { "—" }
                                }))
                                (table_cell(true, html! { (reward.note.as_deref().unwrap_or("—")) }))
                            }))
                        }
                    }))
                })))
            }
        }
    }
}

fn user_referees(base: &str, user_id: &str, referrals: &AdminUserReferrals) -> Markup {
    html! {
        div class="flex flex-col gap-4" {
            h2 class="text-base font-semibold text-neutral-900" { "Accounts they brought" }
            @if referrals.referees.is_empty() {
                (empty_state("No accounts on this page."))
            } @else {
                (table_container(table(html! {
                    (table_head(html! {
                        tr {
                            @for header in ["Account", "State", "Reason", "Joined"] {
                                (table_header_cell(header))
                            }
                        }
                    }))
                    (table_body(html! {
                        @for referee in &referrals.referees {
                            (table_row(html! {
                                (table_cell(false, html! {
                                    a href={(base) "/users/" (referee.referee_id)}
                                        class="font-mono text-blue-600 hover:underline" {
                                        (referee.referee_id)
                                    }
                                }))
                                (table_cell(false, html! { (referee_state(&referee.state)) }))
                                (table_cell(true, html! { (referee.reason.as_deref().map_or("—", reject_reason_label)) }))
                                (table_cell(true, html! { (format_admin_timestamp(&referee.referred_at)) }))
                            }))
                        }
                    }))
                })))
            }
            @if let Some(cursor) = &referrals.next_cursor {
                a href={(base) "/referral/users/" (user_id) "?cursor=" (urlencoding::encode(cursor))}
                    class="font-medium text-blue-600 text-sm hover:underline" { "Next page →" }
            }
        }
    }
}

fn referee_state(state: &str) -> Markup {
    let variant = match state {
        "valid" => BadgeVariant::Success,
        "rejected" => BadgeVariant::Danger,
        _ => BadgeVariant::Default,
    };
    badge(state, variant)
}

fn reject_reason_label(reason: &str) -> &str {
    match reason {
        "same_ip" => "Same IP as referrer",
        "ip_velocity" => "Too many sign-ups from this IP",
        "same_email" => "Same email as referrer",
        "risk" => "Risky sign-up",
        "unverified" => "Email not verified",
        "inactive" => "Not active",
        "account_gone" => "Account gone",
        other => other,
    }
}
