// SPDX-License-Identifier: AGPL-3.0-or-later

use crate::{
    acl, admin_flags,
    api::types::{AdminUser, LimitConfigResponse, ListUserChangeLogResponse},
    config::AdminConfig,
    templates::{
        components::{
            badge::{BadgeVariant, badge},
            form::{
                FORM_INPUT_CLASS, checkbox, csrf_input, danger_button, form_actions,
                form_field_group, submit_button,
            },
            page_container::{card_with_header, detail_row},
        },
        pages::cosmetics::reason_field,
    },
    templates::pages::enforcement_decision::suspension_label,
    utils::{
        bigint::format_discriminator,
        timestamps::{format_admin_timestamp, snowflake_creation_date},
        user_tag::user_tag,
    },
};
use maud::{Markup, html};

pub fn overview_tab(
    config: &AdminConfig,
    user: &AdminUser,
    admin_acls: &[String],
    csrf_token: &str,
    change_log: Option<&ListUserChangeLogResponse>,
) -> Markup {
    render_overview_tab(
        config, user, admin_acls, csrf_token, change_log, None, false, false,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn overview_tab_with_limit_config(
    config: &AdminConfig,
    user: &AdminUser,
    admin_acls: &[String],
    csrf_token: &str,
    change_log: Option<&ListUserChangeLogResponse>,
    limit_config: Option<&LimitConfigResponse>,
    username_sign_in: bool,
) -> Markup {
    render_overview_tab(
        config,
        user,
        admin_acls,
        csrf_token,
        change_log,
        limit_config,
        true,
        username_sign_in,
    )
}

#[allow(clippy::too_many_arguments)]
fn render_overview_tab(
    config: &AdminConfig,
    user: &AdminUser,
    admin_acls: &[String],
    csrf_token: &str,
    change_log: Option<&ListUserChangeLogResponse>,
    limit_config: Option<&LimitConfigResponse>,
    show_traits: bool,
    username_sign_in: bool,
) -> Markup {
    html! {
        div class="space-y-6" {
            (restriction_banner(config, user))
            @if user.temp_banned_until.is_none() && user.enforcement_decision_id.is_none() {
                @if let Some(pending) = &user.pending_deletion_at {
                    div class="rounded-lg border border-orange-200 bg-orange-50 p-4 text-sm text-orange-900" {
                        div class="font-medium" { "Scheduled for deletion: " (format_admin_timestamp(pending)) }
                        @if let Some(code) = user.deletion_reason_code {
                            div class="mt-1" { "Reason code: " (code) }
                        }
                        @if let Some(reason) = &user.deletion_public_reason {
                            div class="mt-1" { "Public reason: " (reason) }
                        }
                        @if let Some(reason) = &user.deletion_audit_log_reason {
                            div class="mt-1" { "Private reason: " (reason) }
                        }
                        div class="mt-1" {
                            "Scheduled by "
                            @match user.deletion_scheduled_by.as_deref() {
                                Some(id) if id == user.id => { "the user" }
                                Some(id) => {
                                    a href={(config.base_path) "/users/" (id)} class="underline" { (id) }
                                }
                                None => { "an unrecorded source" }
                            }
                            @if let Some(at) = user.deletion_scheduled_at.as_deref() {
                                " on " (format_admin_timestamp(at))
                            }
                        }
                    }
                }
            }
            @if let Some(pending) = &user.pending_bulk_message_deletion_at {
                div class="rounded-lg border border-neutral-200 bg-neutral-50 p-4" {
                    div class="font-medium text-neutral-700 text-sm" {
                        "Bulk message deletion scheduled for " (format_admin_timestamp(pending))
                    }
                    @if acl::has_permission(admin_acls, acl::USER_CANCEL_BULK_MESSAGE_DELETION) {
                        form method="post"
                            action={(config.base_path) "/users/" (user.id) "?action=cancel_bulk_message_deletion&tab=overview"} {
                            (csrf_input(csrf_token))
                            button type="submit"
                                class="mt-3 rounded bg-neutral-900 px-4 py-2 font-medium text-sm text-white transition-colors hover:bg-neutral-800" {
                                "Cancel Bulk Message Deletion"
                            }
                        }
                    }
                }
            }
            (card_with_header("Account Information", html! {
                dl class="divide-y divide-neutral-100" {
                    (detail_row("User ID", html! {
                        span class="font-mono text-xs" { (user.id) }
                    }))
                    (detail_row("Created", html! {
                        (snowflake_creation_date(&user.id))
                    }))
                    (detail_row("Username", html! {
                        (user_tag(&user.username, &format_discriminator(&user.discriminator), user.bot))
                    }))
                    (detail_row("Display Name", html! {
                        @if let Some(ref name) = user.global_name {
                            (name)
                        } @else {
                            span class="text-neutral-400" { "Not set" }
                        }
                    }))
                    @if acl::has_permission(admin_acls, acl::USER_VIEW_EMAIL) && !username_sign_in {
                        (detail_row("Email", html! {
                            @if let Some(ref email) = user.email {
                                (email)
                                @if user.email_verified { span class="ml-1 text-green-600" { "verified" } }
                                @else { span class="ml-1 text-red-600" { "unverified" } }
                                @if user.email_bounced { span class="ml-1 text-orange-600" { "(bounced)" } }
                            } @else {
                                span class="text-neutral-400" { "Not set" }
                            }
                        }))
                    }
                    @if acl::has_permission(admin_acls, acl::USER_VIEW_DOB) {
                        (detail_row("Date of Birth", html! {
                            (user.date_of_birth.as_deref().unwrap_or("Not set"))
                        }))
                    }
                    (detail_row("Locale", html! {
                        (user.locale.as_deref().unwrap_or("Not set"))
                    }))
                    @if let Some(ref bio) = user.bio {
                        (detail_row("Bio", html! { (bio) }))
                    }
                    @if let Some(ref pronouns) = user.pronouns {
                        (detail_row("Pronouns", html! { (pronouns) }))
                    }
                    @if user.bot {
                        (detail_row("Type", html! { (badge("Bot", BadgeVariant::Info)) }))
                    }
                    @if user.system {
                        (detail_row("Type", html! { (badge("System", BadgeVariant::Warning)) }))
                    }
                    (detail_row("Authenticators", html! {
                        @if user.authenticator_types.is_empty() {
                            span class="text-neutral-400" { "None" }
                        } @else {
                            (user.authenticator_types.iter().map(|t| match t {
                                0 => "TOTP",
                                2 => "WebAuthn",
                                _ => "Unknown",
                            }).collect::<Vec<_>>().join(", "))
                        }
                    }))
                    (detail_row("Plus", html! {
                        @match user.premium_type {
                            Some(1) => {
                                "Subscription"
                                @if let Some(ref value) = user.premium_since {
                                    span class="ml-1 text-neutral-500" { " since " (value) }
                                }
                                @if let Some(ref value) = user.premium_until {
                                    span class="ml-1 text-neutral-500" { " until " (value) }
                                }
                            }
                            Some(2) => {
                                "Lifetime"
                                @if let Some(value) = user.premium_lifetime_sequence {
                                    span class="ml-1 text-neutral-500" { " #" (value) }
                                }
                            }
                            _ => { span class="text-neutral-400" { "None" } }
                        }
                    }))
                    @if let Some(ref value) = user.premium_grace_ends_at {
                        (detail_row("Grace Period Ends", html! { (format_admin_timestamp(value)) }))
                    }
                    (detail_row("Last Active", html! {
                        (user.last_active_at.as_deref().map_or_else(|| "Never".to_string(), format_admin_timestamp))
                    }))
                    @if acl::has_permission(admin_acls, acl::USER_VIEW_IP) {
                        (detail_row("Last IP", html! {
                            @if let Some(ip) = &user.last_active_ip {
                                span class="font-mono text-xs" { (ip) }
                                a href={(config.base_path) "/users?ip=" (urlencoding::encode(ip))}
                                    class="ml-2 text-xs text-blue-600 hover:underline" {
                                    "Find related"
                                }
                                @if let Some(reverse) = &user.last_active_ip_reverse {
                                    span class="ml-2 text-neutral-500" { "(" (reverse) ")" }
                                }
                            } @else {
                                span class="text-neutral-400" { "Not recorded" }
                            }
                        }))
                        (detail_row("Location", html! {
                            (user.last_active_location.as_deref().unwrap_or("Unknown"))
                        }))
                    }
                }
            }))
            (flags_card(config, user, admin_acls, csrf_token))
            @if acl::has_permission(admin_acls, acl::USER_UPDATE_FLAGS) {
                (end_premium_card(config, user, csrf_token))
            }
            // The API asks for both permissions on these two routes.
            @if acl::has_permission(admin_acls, acl::SHOP_MANAGE)
                && acl::has_permission(admin_acls, acl::USER_UPDATE_FLAGS) {
                (visionary_card(config, user, csrf_token))
            }
            (acls_card(config, user, admin_acls, csrf_token))
            @if show_traits {
                (traits_card(config, user, admin_acls, csrf_token, limit_config))
            }
            @if acl::has_permission(admin_acls, acl::USER_VIEW_CONTACT_LOG) {
                (card_with_header("Contact Change Log", html! {
                    @if let Some(log) = change_log {
                        @if log.entries.is_empty() {
                            p class="text-sm text-neutral-500" { "No contact changes recorded." }
                        } @else {
                            dl class="divide-y divide-neutral-100" {
                                @for entry in &log.entries {
                                    div class="py-3 text-sm" {
                                        dt class="font-medium text-neutral-900" {
                                            (entry.field)
                                            span class="ml-2 font-normal text-xs text-neutral-500" { (format_admin_timestamp(&entry.event_at)) }
                                        }
                                        dd class="mt-1 font-mono text-xs text-neutral-700" {
                                            (entry.old_value.as_deref().unwrap_or("null"))
                                            " \u{2192} "
                                            (entry.new_value.as_deref().unwrap_or("null"))
                                        }
                                        @if let Some(ref reason) = entry.reason {
                                            dd class="text-xs text-neutral-500" { (reason) }
                                        }
                                    }
                                }
                            }
                        }
                    } @else {
                        p class="text-sm text-red-700" { "Failed to load change log." }
                    }
                }))
            }
        }
    }
}

fn restriction_banner(config: &AdminConfig, user: &AdminUser) -> Markup {
    let base = &config.base_path;
    html! {
        @match (&user.enforcement_decision_id, &user.temp_banned_until) {
            (Some(decision_id), until) => {
                div class="rounded-lg border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-900" data-restriction-banner="" {
                    @match (until, &user.pending_deletion_at) {
                        (Some(until), _) => { (suspension_label(until)) ". " }
                        (None, Some(pending)) => { "Scheduled for deletion on " (format_admin_timestamp(pending)) ". " }
                        (None, None) => { "Restricted by a decision. " }
                    }
                    a href={(base) "/decisions/" (decision_id)} class="underline" { "Decision " (decision_id) }
                }
            }
            (None, Some(until)) => {
                div class="rounded-lg border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-900" data-restriction-banner="" {
                    (suspension_label(until)) ". Recorded before decisions, so it has no decision."
                }
            }
            (None, None) => {}
        }
    }
}

fn flags_card(
    config: &AdminConfig,
    user: &AdminUser,
    admin_acls: &[String],
    csrf_token: &str,
) -> Markup {
    let can_update_flags = acl::has_permission(admin_acls, acl::USER_UPDATE_FLAGS);
    let suspended = user.temp_banned_until.is_some();
    html! {
        div class="space-y-6" {
            (flag_form_shell(
                config,
                &user.id,
                "User flags",
                "update_flags",
                csrf_token,
                can_update_flags,
                html! {
                    @for flag in admin_flags::USER_FLAGS {
                        (checkbox(
                            "flags[]",
                            &flag.value.to_string(),
                            flag.name,
                            user.flags & flag.value != 0,
                            can_update_flags && admin_flags::user_flag_is_editable(flag.value, user.flags, suspended),
                        ))
                    }
                },
            ))
            (flag_form_shell(
                config,
                &user.id,
                "Plus Flags",
                "update_premium_flags",
                csrf_token,
                can_update_flags,
                html! {
                    @for flag in admin_flags::PREMIUM_FLAGS {
                        (checkbox(
                            "flags[]",
                            &flag.value.to_string(),
                            flag.name,
                            user.premium_flags & flag.value != 0,
                            can_update_flags && admin_flags::premium_flag_is_editable(flag.value),
                        ))
                    }
                },
            ))
        }
    }
}

fn flag_form_shell(
    config: &AdminConfig,
    user_id: &str,
    title: &str,
    action: &str,
    csrf_token: &str,
    can_edit: bool,
    checkboxes: Markup,
) -> Markup {
    card_with_header(
        title,
        html! {
            form method="post" action={(config.base_path) "/users/" (user_id) "?action=" (action) "&tab=overview"} class="space-y-4" {
                (csrf_input(csrf_token))
                div class="grid grid-cols-1 gap-2 sm:grid-cols-2" {
                    (checkboxes)
                }
                @if can_edit {
                    p class="text-xs text-neutral-500" {
                        "Restriction flags are read-only. Use the moderation tab."
                    }
                    (form_actions(html! {
                        (submit_button("Save"))
                    }))
                } @else {
                    p class="text-xs text-neutral-500" {
                        "Read-only. Needs the " (acl::USER_UPDATE_FLAGS) " permission."
                    }
                }
            }
        },
    )
}

// Used after refunding a premium payment with the payment provider. Ending premium leaves
// lifetime premium (Visionary, premium_type 2) as it is, so that account gets a pointer instead.
fn end_premium_card(config: &AdminConfig, user: &AdminUser, csrf_token: &str) -> Markup {
    card_with_header(
        "End Plus now",
        html! {
            @if user.premium_type == Some(2) {
                p class="text-neutral-700 text-sm" {
                    "Visionary is lifetime Plus, which ending Plus does not change. \
                     Use Take Visionary back instead."
                }
            } @else {
                form method="post" action={(config.base_path) "/users/" (user.id) "?action=end_premium&tab=overview"} class="space-y-4" {
                    (csrf_input(csrf_token))
                    p class="text-neutral-700 text-sm" {
                        "Ends all Plus time now: bought, from a gift code and from the free trial. \
                         The trial cannot be taken again. Use this after refunding a Plus payment \
                         with the payment provider."
                    }
                    (reason_field("end-premium-reason"))
                    (form_actions(html! {
                        (danger_button("End Plus now"))
                    }))
                }
            }
        },
    )
}

// Assign a Visionary number; a revoked number is never sold again.
fn visionary_card(config: &AdminConfig, user: &AdminUser, csrf_token: &str) -> Markup {
    let action = |name: &str| {
        format!(
            "{}/users/{}?action={name}&tab=overview",
            config.base_path, user.id
        )
    };
    let visionary = user.premium_type == Some(2);
    let status = match user.premium_lifetime_sequence {
        Some(number) if visionary => format!("Visionary #{number}"),
        _ if visionary => "Visionary".to_owned(),
        _ => "Not a Visionary".to_owned(),
    };
    card_with_header(
        "Visionary",
        html! {
            div class="space-y-4" {
                p class="font-medium text-neutral-900 text-sm" { (status) }
                @if visionary {
                    form method="post" action=(action("revoke_visionary")) class="space-y-4" {
                        (csrf_input(csrf_token))
                        p class="text-neutral-700 text-sm" {
                            "The number is retired and never sold again. Reward decorations are taken back."
                        }
                        (reason_field("revoke-visionary-reason"))
                        (form_actions(html! { (danger_button("Take Visionary back")) }))
                    }
                } @else {
                    form method="post" action=(action("grant_visionary")) class="space-y-4" {
                        (csrf_input(csrf_token))
                        (form_field_group("Number", "grant-visionary-slot", false, None,
                            Some("A free number, or blank for the lowest free one."),
                            html! {
                                input type="number" id="grant-visionary-slot" name="slot" step="1"
                                    min="1" max="100000" class=(FORM_INPUT_CLASS);
                            }))
                        (reason_field("grant-visionary-reason"))
                        (form_actions(html! { (submit_button("Give Visionary")) }))
                    }
                }
            }
        },
    )
}

fn flag_checkbox(
    input_name: &str,
    value: String,
    label: &str,
    checked: bool,
    can_edit: bool,
) -> Markup {
    checkbox(input_name, &value, label, checked, can_edit)
}

fn acls_card(
    config: &AdminConfig,
    user: &AdminUser,
    admin_acls: &[String],
    csrf_token: &str,
) -> Markup {
    let can_edit = acl::has_permission(admin_acls, acl::ACL_SET_USER);
    card_with_header(
        "ACLs",
        html! {
            @if can_edit {
                form method="post" action={(config.base_path) "/users/" (user.id) "?action=update_acls&tab=overview"} {
                    (csrf_input(csrf_token))
                    div class="space-y-4" {
                        div class="grid grid-cols-1 gap-2 sm:grid-cols-2" {
                            @for item in acl::ALL_ACLS {
                                @let checked = user.acls.iter().any(|value| value == item);
                                (flag_checkbox("acls[]", item.to_string(), item, checked, true))
                            }
                        }
                        @for item in &user.acls {
                            @if !acl::ALL_ACLS.iter().any(|known| known == &item.as_str()) {
                                input type="hidden" name="acls[]" value=(item);
                            }
                        }
                        (form_actions(html! {
                            (submit_button("Save ACLs"))
                        }))
                    }
                }
            } @else {
                @if user.acls.is_empty() {
                    p class="text-sm text-neutral-500" { "No ACLs assigned." }
                } @else {
                    div class="flex flex-wrap gap-2" {
                        @for item in &user.acls {
                            (badge(item, BadgeVariant::Default))
                        }
                    }
                }
                p class="mt-4 text-xs text-neutral-500" {
                    "Read-only \u{2014} acl:set:user permission required."
                }
            }
        },
    )
}

fn traits_card(
    config: &AdminConfig,
    user: &AdminUser,
    admin_acls: &[String],
    csrf_token: &str,
    limit_config: Option<&LimitConfigResponse>,
) -> Markup {
    let trait_definitions = parse_trait_definitions(limit_config);
    let custom_traits = custom_traits(user, &trait_definitions);
    let can_edit = acl::has_permission(admin_acls, acl::USER_UPDATE_TRAITS);
    card_with_header(
        "Traits",
        html! {
            div class="space-y-4" {
                @if limit_config.is_some() {
                    @if can_edit {
                        (traits_form(config, user, csrf_token, &trait_definitions, &custom_traits))
                    } @else {
                        (assigned_traits(&user.traits))
                        p class="mt-2 text-xs text-neutral-500" { "Read-only \u{2014} trait update permission required." }
                    }
                } @else {
                    (assigned_traits(&user.traits))
                    p class="text-sm text-red-700" { "Failed to load limit configuration." }
                }
                @if trait_definitions.is_empty() {
                    p class="text-neutral-500 text-xs" {
                        "No trait definitions declared. "
                        a href={(config.base_path) "/instance-config"} class="text-blue-600 underline" {
                            "Open Instance Configuration"
                        }
                    }
                }
            }
        },
    )
}

fn assigned_traits(traits: &[String]) -> Markup {
    html! {
        @if traits.is_empty() {
            p class="text-neutral-500 text-sm" { "No traits assigned." }
        } @else {
            div class="flex flex-wrap gap-2" {
                @for trait_name in traits {
                    (badge(trait_name, BadgeVariant::Default))
                }
            }
        }
    }
}

fn traits_form(
    config: &AdminConfig,
    user: &AdminUser,
    csrf_token: &str,
    trait_definitions: &[&str],
    custom_traits: &[&str],
) -> Markup {
    html! {
        form method="post" action={(config.base_path) "/users/" (user.id) "?action=update_traits&tab=overview"} {
            (csrf_input(csrf_token))
            div class="space-y-4" {
                @if !trait_definitions.is_empty() {
                    div class="grid grid-cols-1 gap-2 sm:grid-cols-2" {
                        @for definition in trait_definitions {
                            (flag_checkbox(
                                "traits[]",
                                definition.to_string(),
                                definition,
                                user.traits.iter().any(|t| t == definition),
                                true,
                            ))
                        }
                    }
                }
                div class="flex flex-col gap-1" {
                    label for="custom-traits" class="text-neutral-500 text-xs" {
                        "Custom traits (comma or newline separated)"
                    }
                    textarea id="custom-traits" name="traits" rows="2"
                        placeholder="beta-tester, experimental"
                        class="w-full rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-brand-primary focus:outline-none focus:ring-2 focus:ring-brand-primary/20" {
                        (custom_traits.join("\n"))
                    }
                    p class="text-neutral-500 text-xs" {
                        "The premium trait follows each member's subscription or gift and cannot be \
                         assigned here."
                    }
                }
                (form_actions(html! {
                    (submit_button("Save Traits"))
                }))
            }
        }
    }
}

const DERIVED_TRAITS: [&str; 1] = ["premium"];

fn parse_trait_definitions(limit_config: Option<&LimitConfigResponse>) -> Vec<&str> {
    limit_config
        .map(|response| {
            response
                .limit_config
                .trait_definitions
                .iter()
                .map(|value| value.trim())
                .filter(|value| !value.is_empty())
                .filter(|value| !DERIVED_TRAITS.contains(value))
                .collect()
        })
        .unwrap_or_default()
}

fn custom_traits<'a>(user: &'a AdminUser, trait_definitions: &[&str]) -> Vec<&'a str> {
    user.traits
        .iter()
        .map(String::as_str)
        .filter(|trait_name| !trait_definitions.contains(trait_name))
        .filter(|trait_name| !DERIVED_TRAITS.contains(trait_name))
        .collect()
}
