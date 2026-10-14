// SPDX-License-Identifier: AGPL-3.0-or-later

use crate::{
    api::types::{GuildInfo, GuildThreadItem},
    config::AdminConfig,
    templates::components::{
        badge::{BadgeVariant, badge},
        form::{csrf_input, danger_button, form_actions, submit_button},
        page_container::card_with_header,
        table::{data_table, table_cell, table_row},
    },
};
use maud::{Markup, html};

#[allow(clippy::too_many_arguments)]
pub fn threads_tab(
    config: &AdminConfig,
    guild: &GuildInfo,
    threads: &[GuildThreadItem],
    current_cursor: Option<&str>,
    next_cursor: Option<&str>,
    can_delete: bool,
    csrf_token: &str,
) -> Markup {
    let base = &config.base_path;
    html! {
        (card_with_header("Thread search index", html! {
            form method="post"
                action={(base) "/guilds/" (guild.id) "?tab=threads&action=refresh_search_index"}
                class="w-full" {
                (csrf_input(csrf_token))
                input type="hidden" name="index_type" value="threads";
                (form_actions(html! {
                    (submit_button("Refresh threads"))
                }))
            }
        }))
        (card_with_header(
            &format!("Threads on this page ({})", threads.len()),
            html! {
                p class="mb-3 text-sm text-neutral-500" {
                    "Ordered by parent ID, then thread ID. Each page reads one parent channel; empty pages may have more results."
                }
                @if threads.is_empty() {
                    p class="text-sm text-neutral-500" { "No threads on this page." }
                } @else {
                    (data_table(
                        &["Thread", "Parent", "State", "Members", "Messages", ""],
                        html! {
                            @for thread in threads {
                                (thread_row(base, &guild.id, thread, can_delete, csrf_token))
                            }
                        },
                    ))
                }
                @if current_cursor.is_some() || next_cursor.is_some() {
                    nav aria-label="Thread pages" class="mt-4 flex items-center justify-between border-t pt-4" {
                        @if current_cursor.is_some() {
                            a href={(base) "/guilds/" (guild.id) "?tab=threads"}
                                class="text-sm text-brand-primary hover:underline" { "First page" }
                        }
                        @if let Some(cursor) = next_cursor {
                            a href={(base) "/guilds/" (guild.id) "?tab=threads&thread_cursor=" (urlencoding::encode(cursor))}
                                class="text-sm text-brand-primary hover:underline" { "Next page" }
                        }
                    }
                }
            },
        ))
    }
}

fn thread_kind(channel_type: i32) -> &'static str {
    match channel_type {
        10 => "Announcement",
        12 => "Private",
        _ => "Public",
    }
}

fn thread_state(thread: &GuildThreadItem) -> Markup {
    let metadata = thread.thread_metadata.as_ref();
    let archived = metadata.is_some_and(|metadata| metadata.archived);
    let locked = metadata.is_some_and(|metadata| metadata.locked);
    html! {
        div class="flex flex-wrap gap-1" {
            (badge(thread_kind(thread.channel_type), BadgeVariant::Default))
            @if archived { (badge("Archived", BadgeVariant::Default)) }
            @if locked { (badge("Locked", BadgeVariant::Default)) }
        }
    }
}

fn thread_row(
    base: &str,
    guild_id: &str,
    thread: &GuildThreadItem,
    can_delete: bool,
    csrf_token: &str,
) -> Markup {
    table_row(html! {
        (table_cell(false, html! {
            div class="font-medium" { (thread.name.as_deref().unwrap_or("")) }
            div class="text-xs text-neutral-500" { "ID: " (thread.id) }
        }))
        (table_cell(true, html! { (thread.parent_id.as_deref().unwrap_or("")) }))
        (table_cell(false, thread_state(thread)))
        (table_cell(true, html! { (thread.member_count.unwrap_or(0)) }))
        (table_cell(true, html! { (thread.message_count.unwrap_or(0)) }))
        (table_cell(false, html! {
            @if can_delete {
                form method="post"
                    action={(base) "/guilds/" (guild_id) "?tab=threads&action=delete_thread"} {
                    (csrf_input(csrf_token))
                    input type="hidden" name="thread_id" value=(thread.id);
                    (danger_button("Delete thread"))
                }
            }
        }))
    })
}

#[cfg(test)]
mod tests {
    use super::threads_tab;
    use crate::api::types::GuildInfo;
    use crate::config::{AdminConfig, ProxyConfig};

    fn config() -> AdminConfig {
        AdminConfig {
            host: "127.0.0.1".into(),
            port: 3020,
            secret_key_base: "test".into(),
            base_path: "/admin".into(),
            api_endpoint: "http://api.test".into(),
            media_endpoint: "http://media.test".into(),
            static_cdn_endpoint: String::new(),
            reports_bucket_origin: String::new(),
            admin_endpoint: "http://admin.test".into(),
            web_app_endpoint: "http://app.test".into(),
            oauth_client_id: "123".into(),
            oauth_client_secret: "test".into(),
            oauth_redirect_uri: "http://admin.test/callback".into(),
            build_version: "test".into(),
            self_hosted: true,
            proxy: ProxyConfig {
                trust_client_ip_header: false,
                client_ip_header_name: "x-forwarded-for".into(),
            },
        }
    }

    fn guild() -> GuildInfo {
        serde_json::from_value(serde_json::json!({"id":"123", "name":"Guild", "owner_id":"456"}))
            .unwrap()
    }

    #[test]
    fn next_page_remains_available_on_an_empty_parent_page() {
        let markup = threads_tab(
            &config(),
            &guild(),
            &[],
            None,
            Some("opaque_next"),
            false,
            "csrf",
        )
        .into_string();
        assert!(markup.contains("thread_cursor=opaque_next"));
        assert!(markup.contains("Next page"));
        assert!(!markup.contains("First page"));
    }

    #[test]
    fn last_page_offers_a_return_to_the_first_page() {
        let markup = threads_tab(
            &config(),
            &guild(),
            &[],
            Some("opaque_current"),
            None,
            false,
            "csrf",
        )
        .into_string();
        assert!(markup.contains("/admin/guilds/123?tab=threads"));
        assert!(markup.contains("First page"));
        assert!(!markup.contains("Next page"));
    }
}
