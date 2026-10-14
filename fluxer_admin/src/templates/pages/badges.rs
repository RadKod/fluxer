// SPDX-License-Identifier: AGPL-3.0-or-later

use super::cosmetics::{IMAGE_UPLOAD_SCRIPT, image_field, select_field, text_field};
use crate::{
    api::types::{Badge, FlashMessage},
    config::AdminConfig,
    middleware::auth::AuthContext,
    templates::{
        components::{
            error_display::error_alert,
            form::{csrf_input, danger_button, form_actions, form_field_group, submit_button},
            page_container::{card, page_header},
            table::{data_table, empty_state},
        },
        layout::admin_layout,
    },
};
use maud::{Markup, PreEscaped, html};

const ICON_HELP: &str = "PNG, APNG or WebP, at most 256 KB.";

pub fn badges_page(
    config: &AdminConfig,
    auth: &AuthContext,
    csrf_token: &str,
    flash: Option<&FlashMessage>,
    badges: Option<&[Badge]>,
    edit_id: Option<&str>,
) -> Markup {
    let base = &config.base_path;
    let badge_options: Vec<(&str, &str)> = badges
        .unwrap_or_default()
        .iter()
        .map(|badge| (badge.id.as_str(), badge.description.as_str()))
        .collect();
    let content = html! {
        div class="space-y-6" {
            (page_header(
                "Badges",
                Some("Profile badges. A badge is never deleted from the catalog; take it back \
                      from an account instead."),
            ))
            (card(html! {
                div class="flex flex-col gap-4" {
                    h2 class="text-base font-semibold text-neutral-900" { "Catalog" }
                    @match badges {
                        None => (error_alert("Failed to load badges.")),
                        Some([]) => (empty_state("No badges yet.")),
                        Some(badges) => (catalog_table(config, badges)),
                    }
                }
            }))
            (card(user_badge_form(base, csrf_token, &badge_options)))
            (card(create_form(base, csrf_token)))
            div id="edit" {
                (card(edit_form(base, csrf_token, edit_id.unwrap_or(""))))
            }
        }
        script defer { (PreEscaped(IMAGE_UPLOAD_SCRIPT)) }
    };
    admin_layout(config, auth, "Badges", "badges", flash, content)
}

fn icon_url(config: &AdminConfig, badge: &Badge) -> String {
    format!(
        "{}/branding/badge-{}/{}.webp?size=64",
        config.media_endpoint.trim_end_matches('/'),
        badge.id,
        badge.icon
    )
}

fn catalog_table(config: &AdminConfig, badges: &[Badge]) -> Markup {
    let base = &config.base_path;
    let rows = html! {
        @for badge in badges {
            tr class="hover:bg-neutral-50 transition-colors" {
                td class="px-4 py-3" {
                    img src=(icon_url(config, badge)) alt="" loading="lazy" class="h-8 w-8 object-contain";
                }
                td class="px-4 py-3 text-neutral-900 text-sm" { (badge.description) }
                td class="px-4 py-3 font-mono text-neutral-500 text-xs" { (badge.id) }
                td class="px-4 py-3 text-sm" {
                    a href={(base) "/badges?edit=" (badge.id) "#edit"}
                        class="font-medium text-blue-600 text-sm hover:underline" { "Edit" }
                }
            }
        }
    };
    data_table(&["Icon", "Text", "ID", "Actions"], rows)
}

fn user_badge_form(base: &str, csrf_token: &str, badge_options: &[(&str, &str)]) -> Markup {
    html! {
        div class="flex flex-col gap-4" {
            h2 class="text-base font-semibold text-neutral-900" { "Give or take back" }
            div class="grid grid-cols-1 gap-6 lg:grid-cols-2" {
                (user_badge_action(base, csrf_token, badge_options, "grant", submit_button("Give badge")))
                (user_badge_action(base, csrf_token, badge_options, "revoke", danger_button("Take badge back")))
            }
        }
    }
}

fn user_badge_action(
    base: &str,
    csrf_token: &str,
    badge_options: &[(&str, &str)],
    action: &str,
    button: Markup,
) -> Markup {
    let user_field = format!("badge-{action}-user");
    let badge_field = format!("badge-{action}-badge");
    html! {
        form method="post" action={(base) "/badges?action=" (action)} data-admin-result-form="true" {
            (csrf_input(csrf_token))
            div class="flex flex-col gap-4" {
                (form_field_group("User ID", &user_field, true, None, None,
                    text_field(&user_field, "user_id", "", 20, true)))
                (form_field_group("Badge", &badge_field, true, None, None,
                    select_field(&badge_field, "badge_id", badge_options, None)))
                (form_actions(button))
            }
        }
    }
}

fn create_form(base: &str, csrf_token: &str) -> Markup {
    html! {
        div class="flex flex-col gap-4" {
            h2 class="text-base font-semibold text-neutral-900" { "Add badge" }
            form method="post" action={(base) "/badges?action=create"} data-admin-result-form="true" {
                (csrf_input(csrf_token))
                div class="flex flex-col gap-4" {
                    (form_field_group("Text", "badge-create-description", true, None,
                        Some("1-128 characters."),
                        text_field("badge-create-description", "description", "", 128, true)))
                    (image_field("badge-create-icon", "icon", "Icon", true, ICON_HELP))
                    (form_actions(html! { (submit_button("Add badge")) }))
                }
            }
        }
    }
}

fn edit_form(base: &str, csrf_token: &str, badge_id: &str) -> Markup {
    html! {
        div class="flex flex-col gap-4" {
            h2 class="text-base font-semibold text-neutral-900" { "Change badge" }
            p class="text-sm text-neutral-500" {
                "Blank fields stay as they are. Every account holding the badge shows the change."
            }
            form method="post" action={(base) "/badges?action=update"} data-admin-result-form="true" {
                (csrf_input(csrf_token))
                div class="flex flex-col gap-4" {
                    (form_field_group("Badge ID", "badge-edit-id", true, None, None,
                        text_field("badge-edit-id", "badge_id", badge_id, 20, true)))
                    (form_field_group("Text", "badge-edit-description", false, None, None,
                        text_field("badge-edit-description", "description", "", 128, false)))
                    (image_field("badge-edit-icon", "icon", "New icon", false, ICON_HELP))
                    (form_actions(html! { (submit_button("Save changes")) }))
                }
            }
        }
    }
}
