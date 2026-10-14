// SPDX-License-Identifier: AGPL-3.0-or-later

use crate::{
    acl,
    api::types::FlashMessage,
    config::AdminConfig,
    middleware::auth::AuthContext,
    routes::username_migration::{
        MISSING_READINESS, MigrationInspection, MigrationState, MigrationStatus,
        START_CONFIRMATION, UsernamePolicy,
    },
    templates::{
        components::{
            error_display::error_alert,
            form::{
                FORM_INPUT_CLASS, FORM_TEXTAREA_CLASS, checkbox, csrf_input, danger_button,
                select_input, submit_button,
            },
            page_container::{card, detail_row, page_header_with_back},
        },
        layout::admin_layout,
    },
    utils::timestamps::format_admin_timestamp,
};
use maud::{Markup, html};

const MODES: &[(&str, &str)] = &[
    ("locked", "Locked"),
    ("for_sale", "For sale"),
    ("public", "Public"),
];

pub fn page(
    config: &AdminConfig,
    auth: &AuthContext,
    csrf: &str,
    flash: Option<&FlashMessage>,
    policy: Option<&UsernamePolicy>,
    migration: Option<&MigrationStatus>,
    inspection: Option<&MigrationInspection>,
) -> Markup {
    let base = &config.base_path;
    let acls = auth
        .admin_user
        .as_ref()
        .map(|user| user.acls.as_slice())
        .unwrap_or(&[]);
    let can_view = acl::has_permission(acls, acl::INSTANCE_CONFIG_VIEW);
    let can_update = acl::has_permission(acls, acl::INSTANCE_CONFIG_UPDATE);
    let can_migrate = acl::has_permission(acls, acl::USERNAME_MIGRATION_START);
    let content = html! {
        div class="space-y-6" {
            (page_header_with_back("Username policy and migration", Some("Manage short-name tiers and prepare username selection."), &format!("{base}/instance-config"), Some("Instance configuration")))
            @if can_view {
                @match policy {
                    Some(policy) => (card(policy_card(base, csrf, policy, can_update))),
                    None => (error_alert("Username policy unavailable. No default policy has been substituted.")),
                }
            }
            (card(migration_card(base, csrf, migration, inspection, can_migrate)))
        }
    };
    admin_layout(
        config,
        auth,
        "Username migration",
        "username-migration",
        flash,
        content,
    )
}

fn reason_field(id: &str) -> Markup {
    html! {
        div class="flex flex-col gap-2" {
            label for=(id) class="text-sm font-medium" { "Audit reason" }
            textarea id=(id) name="reason" placeholder="Explain this change" rows="2" required maxlength="512" class=(FORM_TEXTAREA_CLASS) {}
        }
    }
}

fn policy_card(base: &str, csrf: &str, policy: &UsernamePolicy, can_update: bool) -> Markup {
    html! {
        div class="space-y-4" {
            h2 class="text-lg font-semibold" { "Username tiers and admission" }
            dl {
                (detail_row("Policy revision", html! { (policy.revision) }))
                (detail_row("Dictionary generation", html! { (policy.dictionary_gen) }))
                (detail_row("Dictionary hash", html! { code class="break-all" { (policy.dictionary_hash.as_deref().unwrap_or("Not published")) } }))
                (detail_row("Next dictionary generation", html! { (policy.next_dictionary_gen) }))
                (detail_row("Required reservation manifest", html! { (policy.held_manifest.as_ref().map(|names| format!("{} names", names.len())).unwrap_or_else(|| "Not loaded".to_owned())) }))
            }
            p class="text-sm text-neutral-500" { "4+ characters are public. For sale does not enable a purchase flow. All three tiers and the admission budget save in one operation." }
            @if can_update {
                form method="post" action={(base) "/username-migration?action=policy"} class="space-y-4" data-admin-result-form="true" {
                    (csrf_input(csrf))
                    div class="grid grid-cols-1 gap-4 sm:grid-cols-3" {
                        (select_input("tier_1", "1 character", MODES, policy.tiers.one.as_str()))
                        (select_input("tier_2", "2 characters", MODES, policy.tiers.two.as_str()))
                        (select_input("tier_3", "3 characters", MODES, policy.tiers.three.as_str()))
                    }
                    div class="flex flex-col gap-2" {
                        label for="global_per_second" class="text-sm font-medium" { "Global selections per second" }
                        input type="number" id="global_per_second" name="global_per_second" min="0" max="9007199254740991" step="1" required value=(policy.admission.global_per_second) class=(FORM_INPUT_CLASS);
                    }
                    (checkbox("paused", "true", "Pause username admission", policy.admission.paused, true))
                    div class="flex flex-col gap-2" {
                        label for="held_manifest" class="text-sm font-medium" { "Required reservation manifest (up to 1,000 unique names)" }
                        textarea id="held_manifest" name="held_manifest" rows="6" class=(FORM_TEXTAREA_CLASS) { (policy.held_manifest.as_ref().map(|names| names.join("\n")).unwrap_or_default()) }
                        p class="text-sm text-neutral-500" {
                            @if policy.held_manifest.is_none() { "No manifest is saved. Paste the approved reservation list, save it, then reserve or assign each name." }
                            @else { "Save the manifest, then reserve or assign each name. An explicitly saved empty list has no required names." }
                        }
                        (checkbox("update_held_manifest", "true", "Replace the required manifest with this list", false, true))
                    }
                    (reason_field("policy_reason"))
                    div class="flex flex-wrap gap-2" {
                        (submit_button("Save tiers and admission"))
                        button type="submit" name="open_all" value="true" class="rounded-lg border border-neutral-300 px-4 py-2 text-base font-medium" { "Open all three tiers to everyone" }
                    }
                }
            } @else {
                dl {
                    (detail_row("1 character", html! { (policy.tiers.one.as_str()) }))
                    (detail_row("2 characters", html! { (policy.tiers.two.as_str()) }))
                    (detail_row("3 characters", html! { (policy.tiers.three.as_str()) }))
                    (detail_row("Selections per second", html! { (policy.admission.global_per_second) }))
                    (detail_row("Admission paused", html! { (policy.admission.paused) }))
                }
            }
        }
    }
}

fn migration_card(
    base: &str,
    csrf: &str,
    migration: Option<&MigrationStatus>,
    inspection: Option<&MigrationInspection>,
    can_migrate: bool,
) -> Markup {
    let start_ready = inspection.is_some_and(MigrationInspection::start_ready);
    html! {
        div class="space-y-4" {
            h2 class="text-lg font-semibold" { "Username migration" }
            @match migration {
                None => (error_alert("Migration state unavailable. Preparation and rollback are disabled until server state can be read.")),
                Some(migration) => {
                    dl {
                        (detail_row("State", html! { (migration.state.as_str()) }))
                        (detail_row("Epoch", html! { (migration.epoch) }))
                        @for (label, value) in [("Prepared at", migration.preparing_at.as_deref()), ("Started at", migration.started_at.as_deref()), ("Forced selection at", migration.forced_at.as_deref())] {
                            (detail_row(label, html! { (value.map(format_admin_timestamp).unwrap_or_else(|| "Not set".to_owned())) }))
                        }
                    }
                    p class="text-sm text-neutral-500" { "Prerequisites require authenticated migration inspection. Every mutation is checked again by the server against its current state and epoch." }
                    @if can_migrate && migration.state == MigrationState::Legacy {
                        form method="post" action={(base) "/username-migration?action=prepare"} class="space-y-4" data-admin-result-form="true" {
                            (csrf_input(csrf))
                            p class="text-sm text-neutral-500" { "Process versions are unavailable. Manually verify every API and worker process runs the migration version before confirming. Preparation closes allocation and starts a read-only validation scan after at least 60 seconds." }
                            (checkbox("processes_ready", "true", "I verified all API and worker processes run the migration version", false, true))
                            (reason_field("prepare_reason"))
                            (submit_button("Prepare migration"))
                        }
                    }
                    @if matches!(migration.state, MigrationState::Preparing | MigrationState::Selecting) {
                        @if let Some(inspection) = inspection {
                            dl {
                                (detail_row("Validation scan", html! {
                                    @if let Some(scan) = &inspection.scan { "Epoch: " (scan.epoch) "; scanned: " (scan.scanned) "; conflicts: " (scan.found) "; completed: " (scan.done_at.as_deref().unwrap_or("Not completed")) }
                                    @else { "unavailable" }
                                }))
                                (detail_row("Held claims", html! {
                                    "Required: " (inspection.holds.required.map(|count| count.to_string()).unwrap_or_else(|| "Not loaded".to_owned())) "; ready: " (inspection.holds.ready)
                                    @if let Some(proof) = &inspection.holds.proof { "; Held: " (proof.held) "; Assigned: " (proof.assigned) "; checked: " (proof.checked_at) "; policy revision: " (proof.policy_revision) "; missing: " (proof.missing.join(", ")) }
                                }))
                                (detail_row("T6 capacity", html! { "Evidence available: " (inspection.capacity.available) "; ready: " (inspection.capacity.ready) }))
                                @if let Some(proof) = &inspection.capacity.proof {
                                    (detail_row("Total accounts", html! { (proof.total_accounts.map(|count| count.to_string()).unwrap_or_else(|| "unavailable".to_owned())) " (scan epoch " (proof.epoch) "); policy revision: " (proof.policy_revision) }))
                                    @if let Some(guild) = &proof.guild_capacity {
                                        (detail_row("Guild declaration", html! { "Members: " (guild.max_guild_members) "; online: " (guild.max_guild_online) "; source: " (guild.source) "; observed: " (guild.observed_at) "; epoch: " (guild.epoch) "; admin: " (guild.admin_id) }))
                                    } @else { (detail_row("Guild declaration", html! { "Required when starting; valid for 60 minutes." })) }
                                } @else { (detail_row("Capacity proof", html! { "unavailable" })) }
                            }
                        }
                        p class="text-sm text-neutral-500" { "T6 triggers: 50,000 guild members, 5,000 online, or 100,000 accounts; without T6, admission pauses at 80% of those thresholds. These are initial thresholds requiring load measurement." }
                        @if migration.state == MigrationState::Preparing && !start_ready { (error_alert(MISSING_READINESS)) }
                        @if can_migrate && migration.state == MigrationState::Preparing {
                            form method="post" action={(base) "/username-migration?action=start"} class="space-y-4" {
                                (csrf_input(csrf))
                                input type="hidden" name="epoch" value=(migration.epoch);
                                fieldset disabled[!start_ready] class="space-y-4" {
                                    legend class="text-sm font-medium" { "Start migration prerequisites" }
                                    p class="text-sm text-neutral-500" { "Requires a completed scan for this epoch with zero conflicts, a published dictionary generation ≥ 1, all required held claims, positive unpaused admission, and a declared guild size below the T6 pause thresholds." }
                                    @for (name, label) in [("max_guild_members", "Largest guild member count"), ("max_guild_online", "Largest guild online count")] {
                                        div class="flex flex-col gap-2" {
                                            label for=(name) class="text-sm font-medium" { (label) }
                                            input type="number" id=(name) name=(name) min="0" max="9007199254740991" step="1" required class=(FORM_INPUT_CLASS);
                                        }
                                    }
                                    div class="flex flex-col gap-2" {
                                        label for="source" class="text-sm font-medium" { "Capacity declaration source" }
                                        input type="text" id="source" name="source" required maxlength="1000" placeholder="Activity report and time" class=(FORM_INPUT_CLASS);
                                    }
                                    div class="flex flex-col gap-2" {
                                        label for="observed_at" class="text-sm font-medium" { "Observed at (UTC)" }
                                        input type="text" id="observed_at" name="observed_at" required placeholder="2026-10-09T09:12:00Z" class=(FORM_INPUT_CLASS);
                                        p class="text-sm text-neutral-500" { "The source observation expires after 60 minutes. The server records this declaration and checks the capacity thresholds." }
                                    }
                                    (checkbox("mobile_published", "true", "I confirm the username-selection mobile version is published in both Play and App Store", false, true))
                                    div class="flex flex-col gap-2" {
                                        label for="mobile_version" class="text-sm font-medium" { "Published mobile version" }
                                        input type="text" id="mobile_version" name="mobile_version" required maxlength="100" class=(FORM_INPUT_CLASS);
                                    }
                                    div class="flex flex-col gap-2" {
                                        label for="confirmation" class="text-sm font-medium" { "Type " (START_CONFIRMATION) }
                                        input type="text" id="confirmation" name="confirmation" required autocomplete="off" class=(FORM_INPUT_CLASS);
                                    }
                                    (reason_field("start_reason"))
                                    (danger_button("Start migration"))
                                }
                            }
                            form method="post" action={(base) "/username-migration?action=rollback"} class="space-y-4" data-admin-result-form="true" {
                                (csrf_input(csrf))
                                input type="hidden" name="epoch" value=(migration.epoch);
                                p class="text-sm text-neutral-500" { "Only preparation can be rolled back. The epoch remains monotonic." }
                                (reason_field("rollback_reason"))
                                (danger_button("Roll back preparation"))
                            }
                        }
                    }
                    @if migration.state == MigrationState::Selecting {
                        p class="text-sm text-neutral-500" { "Username selection has started. Identity migration cannot be rolled back; further corrections move forward." }
                    }
                }
            }
        }
    }
}
