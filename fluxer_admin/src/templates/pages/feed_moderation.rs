// SPDX-License-Identifier: AGPL-3.0-or-later

use super::cosmetics::text_field;
use crate::{
    api::types::FlashMessage,
    config::AdminConfig,
    middleware::auth::AuthContext,
    templates::{
        components::{
            form::{csrf_input, danger_button, form_actions, form_field_group},
            page_container::{card, page_header},
        },
        layout::admin_layout,
    },
};
use maud::{Markup, html};

pub fn feed_moderation_page(
    config: &AdminConfig,
    auth: &AuthContext,
    csrf_token: &str,
    flash: Option<&FlashMessage>,
    post_id: &str,
    comment_id: &str,
) -> Markup {
    let base = &config.base_path;
    let content = html! {
        div class="space-y-6" {
            (page_header(
                "Feed Moderation",
                Some("Delete a feed post or comment. The author is told through a system DM, \
                      and the deletion is recorded in the audit log."),
            ))
            div class="grid grid-cols-1 gap-6 lg:grid-cols-2" {
                (card(html! {
                    div class="flex flex-col gap-4" {
                        h2 class="text-base font-semibold text-neutral-900" { "Delete post" }
                        form method="post" action={(base) "/feed-moderation?action=delete-post"}
                            data-admin-result-form="true" {
                            (csrf_input(csrf_token))
                            div class="flex flex-col gap-4" {
                                (form_field_group("Post ID", "feed-post-id", true, None, None,
                                    text_field("feed-post-id", "post_id", post_id, 20, true)))
                                (form_actions(danger_button("Delete post")))
                            }
                        }
                    }
                }))
                (card(html! {
                    div class="flex flex-col gap-4" {
                        h2 class="text-base font-semibold text-neutral-900" { "Delete comment" }
                        form method="post" action={(base) "/feed-moderation?action=delete-comment"}
                            data-admin-result-form="true" {
                            (csrf_input(csrf_token))
                            div class="flex flex-col gap-4" {
                                (form_field_group("Post ID", "feed-comment-post-id", true, None, None,
                                    text_field("feed-comment-post-id", "post_id", post_id, 20, true)))
                                (form_field_group("Comment ID", "feed-comment-id", true, None, None,
                                    text_field("feed-comment-id", "comment_id", comment_id, 20, true)))
                                (form_actions(danger_button("Delete comment")))
                            }
                        }
                    }
                }))
            }
        }
    };
    admin_layout(
        config,
        auth,
        "Feed Moderation",
        "feed-moderation",
        flash,
        content,
    )
}
