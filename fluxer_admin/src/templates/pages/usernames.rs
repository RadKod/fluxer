// SPDX-License-Identifier: AGPL-3.0-or-later

use crate::{
    acl,
    api::types::FlashMessage,
    config::AdminConfig,
    middleware::auth::AuthContext,
    routes::usernames::{ReservationPage, ReservationQuery},
    templates::{
        components::{
            form::{
                FORM_INPUT_CLASS, FORM_TEXTAREA_CLASS, csrf_input, submit_button, textarea_input,
            },
            page_container::page_header,
        },
        layout::admin_layout,
        pages::blocklist_helpers::blocklist_text_field,
    },
};
use maud::{Markup, html};
use serde::Deserialize;
use std::collections::BTreeMap;

#[derive(Deserialize)]
pub struct UsernameDictionary {
    pub dictionary_gen: u64,
    pub hash: String,
    pub count: usize,
    pub counts: BTreeMap<String, usize>,
    pub entries: BTreeMap<String, Vec<String>>,
}

fn can(auth: &AuthContext, permission: &str) -> bool {
    let acls = auth
        .admin_user
        .as_ref()
        .map(|user| user.acls.as_slice())
        .unwrap_or(&[]);
    acl::has_permission(acls, permission)
}

pub fn reserve_page(
    config: &AdminConfig,
    auth: &AuthContext,
    flash: Option<&FlashMessage>,
    csrf: &str,
    query: &ReservationQuery,
    page: Option<&ReservationPage>,
) -> Markup {
    let base = &config.base_path;
    let content = html! {
        (page_header("Username Reservations", Some("Hold a username for a later assignment, release a reservation, or assign it to a user.")))
        div class="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm sm:p-6 mb-6" {
            h3 class="text-base font-medium text-neutral-900 mb-4" { "Reserved usernames" }
            form method="get" action={(base) "/usernames-reserve"} class="grid gap-4 sm:grid-cols-3" {
                div {
                    label for="reserve-bucket" class="block text-sm font-medium text-neutral-700" { "Bucket (0–1023)" }
                    input id="reserve-bucket" name="bucket" type="number" min="0" max="1023" value=(query.bucket) required class=(FORM_INPUT_CLASS);
                }
                div {
                    label for="reserve-cursor" class="block text-sm font-medium text-neutral-700" { "Page cursor" }
                    input id="reserve-cursor" name="cursor" type="text" maxlength="32" value=(query.cursor.as_deref().unwrap_or("")) class=(FORM_INPUT_CLASS);
                }
                div {
                    label for="reserve-limit" class="block text-sm font-medium text-neutral-700" { "Page size" }
                    input id="reserve-limit" name="limit" type="number" min="1" max="100" value=(query.limit) required class=(FORM_INPUT_CLASS);
                }
                (submit_button("Load page"))
            }
            @if let Some(page) = page {
                h4 class="mt-4 font-medium" { "Bucket " (page.bucket) }
                @if page.items.is_empty() { p class="mt-2 text-sm" { "No reservations on this page." } }
                ul class="divide-y divide-neutral-200 mt-4" {
                    @for item in &page.items {
                        li class="py-3 text-sm space-y-1" {
                            p { code { (item.username) } " — " (item.state) }
                            p class="break-words" { "Note: " (item.note.as_deref().unwrap_or("None")) }
                            p { "Held by: " (item.held_by.as_deref().unwrap_or("None")) "; user: " (item.user_id.as_deref().unwrap_or("None")) }
                            p { "Blocked until: " (item.blocked_until.as_deref().unwrap_or("None")) "; updated: " (item.updated_at) }
                        }
                    }
                }
                @if let Some(cursor) = &page.next_cursor {
                    a href={(base) "/usernames-reserve?bucket=" (query.bucket) "&limit=" (query.limit) "&cursor=" (urlencoding::encode(cursor))} class="text-sm text-brand-primary hover:underline" { "Next page" }
                }
            } @else {
                p class="text-sm text-neutral-600 mt-4" { "Reservations unavailable. Load a page to read server results." }
            }
        }
        @if can(auth, acl::USERNAME_RESERVE) {
            div class="grid gap-6 lg:grid-cols-2" {
                div class="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm sm:p-6" {
                    h3 class="text-base font-medium text-neutral-900 mb-4" { "Hold a username" }
                    form method="post" action={(base) "/usernames-reserve?action=hold"} class="space-y-4" {
                        (csrf_input(csrf))
                        (blocklist_text_field("username", "Username", "reserved_name", true))
                        (textarea_input("note", "Private reservation note (up to 1,000 characters)", "Why is this name held?", "", 3, false))
                        (blocklist_text_field("audit_log_reason", "Audit reason", "Reason for this reservation", true))
                        (submit_button("Hold username"))
                    }
                }
                div class="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm sm:p-6" {
                    h3 class="text-base font-medium text-neutral-900 mb-4" { "Release a reservation" }
                    p class="text-sm text-neutral-600 mb-4" { "Releasing a reservation preserves any existing 14-day release embargo." }
                    form method="post" action={(base) "/usernames-reserve?action=unhold"} class="space-y-4" {
                        (csrf_input(csrf))
                        (blocklist_text_field("username", "Username to release", "reserved_name", true))
                        (blocklist_text_field("audit_log_reason", "Audit reason", "Reason for releasing the reservation", true))
                        (submit_button("Release reservation"))
                    }
                }
            }
            @if can(auth, acl::USER_UPDATE_USERNAME) {
                div class="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm sm:p-6 mt-6" {
                    h3 class="text-base font-medium text-neutral-900 mb-4" { "Assign a username" }
                    p class="text-sm text-neutral-600 mb-4" {
                        "A short-name entitlement is bound to this exact name and ends when the user releases it. "
                        "Trial, Premium, and gifts do not create this entitlement. Assignment counts as selection and does not change the user's rename counter. "
                        "Assignments are only available during the selection phase; active names, bans, and release embargoes remain protected."
                    }
                    @if can(auth, acl::USER_LOOKUP) {
                        a href={(base) "/users"} target="_blank" rel="noopener" class="text-sm text-brand-primary hover:underline" { "Find a user and copy their user ID" }
                    }
                    form method="post" action={(base) "/usernames-reserve?action=assign"} class="space-y-4 mt-4" {
                        (csrf_input(csrf))
                        (blocklist_text_field("username", "Username to assign", "reserved_name", true))
                        (blocklist_text_field("user_id", "Selected user's ID", "User ID from user lookup", true))
                        (blocklist_text_field("audit_log_reason", "Audit reason", "Reason for assigning this name", true))
                        (submit_button("Assign username"))
                    }
                }
            }
        }
    };
    admin_layout(
        config,
        auth,
        "Username Reservations",
        "usernames-reserve",
        flash,
        content,
    )
}

pub fn dictionary_page(
    config: &AdminConfig,
    auth: &AuthContext,
    flash: Option<&FlashMessage>,
    csrf: &str,
    dictionary: Option<&UsernameDictionary>,
    selected_scope: Option<&str>,
    page: usize,
) -> Markup {
    let base = &config.base_path;
    let content = html! {
        (page_header("Username Dictionary", Some("Stage entries in a list, then publish a new immutable dictionary generation.")))
        p class="text-sm text-neutral-600 mb-4" { "The combined dictionary is limited to 20,000 entries. Published generations are immutable; changes publish a new generation with its content hash." }
        a href={(base) "/profile-substring-bans"} class="text-sm text-brand-primary hover:underline" { "Manage the separate legacy profile substring lists" }
        @if let Some(dictionary) = dictionary {
            div class="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm sm:p-6 mt-6" {
                h3 class="text-base font-medium text-neutral-900" { "Generation " (dictionary.dictionary_gen) }
                p class="text-sm text-neutral-600 mt-2" { (dictionary.count) " / 20,000 entries" }
                p class="text-sm text-neutral-600 mt-2 break-all" { "Hash: " code { (dictionary.hash) } }
            }
        } @else {
            p class="text-sm text-neutral-600 mt-4" { "Published dictionary entries are unavailable." }
        }
        div class="grid gap-6 mt-6" {
            @for (scope, title, description) in [
                ("uname_exact", "Exact username blocks", "Blocks an entire normalized username, without blocking names that contain it."),
                ("uname_contains", "Username substring blocks", "Blocks usernames containing a matching normalized term."),
                ("uname_allow", "Exact username exceptions", "Allows only an exact raw username match. Adding an exception requires remove-block permission; removing it requires add-block permission."),
            ] {
                (dictionary_card(base, auth, csrf, dictionary, scope, title, description, if selected_scope == Some(scope) { page } else { 0 }))
            }
        }
    };
    admin_layout(
        config,
        auth,
        "Username Dictionary",
        "username-dictionary",
        flash,
        content,
    )
}

#[allow(clippy::too_many_arguments)]
fn dictionary_card(
    base: &str,
    auth: &AuthContext,
    csrf: &str,
    dictionary: Option<&UsernameDictionary>,
    scope: &str,
    title: &str,
    description: &str,
    page: usize,
) -> Markup {
    let add_acl = if scope == "uname_allow" {
        acl::BAN_PROFILE_SUBSTRING_REMOVE
    } else {
        acl::BAN_PROFILE_SUBSTRING_ADD
    };
    let remove_acl = if scope == "uname_allow" {
        acl::BAN_PROFILE_SUBSTRING_ADD
    } else {
        acl::BAN_PROFILE_SUBSTRING_REMOVE
    };
    let can_add = can(auth, add_acl);
    let can_remove = can(auth, remove_acl);
    let entries = dictionary.and_then(|dictionary| dictionary.entries.get(scope));
    let page = entries
        .map(|entries| page.min(entries.len().saturating_sub(1) / 100))
        .unwrap_or(0);
    html! {
        div class="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm sm:p-6" {
            h3 class="text-base font-medium text-neutral-900 mb-2" { (title) " (" (scope) ")" }
            p class="text-sm text-neutral-600 mb-4" { (description) }
            @if let Some(dictionary) = dictionary {
                p class="text-sm text-neutral-600 mb-2" { (dictionary.counts.get(scope).copied().unwrap_or(0)) " entries" }
            }
            @if let Some(entries) = entries {
                @if entries.is_empty() { p class="text-sm text-neutral-500" { "No entries" } }
                ul class="grid gap-1 sm:grid-cols-3 text-sm mb-4" {
                    @for entry in entries.iter().skip(page * 100).take(100) {
                        li { code class="break-all" { (entry) } }
                    }
                }
                div class="flex gap-4 mb-4 text-sm" {
                    @if page > 0 {
                        a href={(base) "/username-dictionary?scope=" (scope) "&page=" (page - 1)} class="text-brand-primary hover:underline" { "Previous page" }
                    }
                    @if (page + 1) * 100 < entries.len() {
                        a href={(base) "/username-dictionary?scope=" (scope) "&page=" (page + 1)} class="text-brand-primary hover:underline" { "Next page" }
                    }
                }
            }
            @if can_add || can_remove {
                form method="post" action={(base) "/username-dictionary"} class="space-y-4" {
                    (csrf_input(csrf))
                    input type="hidden" name="scope" value=(scope);
                    @if can_add {
                        (dictionary_entries_input(scope, "add", "Add entries (one per line)"))
                    }
                    @if can_remove {
                        (dictionary_entries_input(scope, "remove", "Remove entries (one per line)"))
                    }
                    (blocklist_text_field("audit_log_reason", "Audit reason", "Why publish this change?", true))
                    (submit_button("Publish generation"))
                }
            }
        }
    }
}

fn dictionary_entries_input(scope: &str, name: &str, label: &str) -> Markup {
    let id = format!("{name}-{scope}");
    html! {
        div class="space-y-1" {
            label for=(id) class="block text-sm font-medium text-neutral-700" { (label) }
            textarea id=(id) name=(name) rows="3" placeholder="Letters and digits, 1–32 characters" class=(FORM_TEXTAREA_CLASS) {}
        }
    }
}
