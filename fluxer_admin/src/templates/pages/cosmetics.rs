// SPDX-License-Identifier: AGPL-3.0-or-later

use crate::{
    api::types::{CosmeticItem, FlashMessage, UltraLayout},
    config::AdminConfig,
    middleware::auth::AuthContext,
    templates::{
        components::{
            badge::{BadgeVariant, badge},
            error_display::error_alert,
            form::{
                FORM_INPUT_CLASS, FORM_SELECT_CLASS, FORM_TEXTAREA_CLASS, csrf_input,
                danger_button, form_actions, form_field_group, select_chevron, submit_button,
            },
            page_container::{card, page_header},
            table::{data_table, empty_state},
        },
        layout::admin_layout,
    },
};
use maud::{Markup, PreEscaped, html};

const ITEM_TYPES: &[(&str, &str)] = &[
    ("avatar_decoration", "Avatar decoration"),
    ("avatar_ultra", "Ultra decoration"),
    ("profile_effect", "Profile effect"),
    ("nameplate", "Nameplate"),
];
const AVAILABILITIES: &[(&str, &str)] = &[
    ("free", "Free"),
    ("premium", "Plus"),
    ("owned", "Owned only"),
];
// Micup (shop): the fixed sizes the client uses today; a blank surface keeps them.
pub(crate) const ULTRA_SURFACES: &[(&str, &str, &str)] = &[
    ("compact", "Chat and member list", "2.30"),
    ("voice", "Voice tile", "3.20"),
    ("profile", "Profile", "3.40"),
];
pub(crate) const ULTRA_COLUMNS: [(&str, &str); 4] = [
    ("width", "Width \u{d7}"),
    ("height", "Height \u{d7}"),
    ("offset_x", "X offset \u{d7}"),
    ("offset_y", "Y offset \u{d7}"),
];
const ULTRA_HELP: &str = "Multiples of the avatar diameter, on the same scale as today's fixed \
                          sizes. Offsets move the image right and down from the avatar centre; \
                          negative values move it left and up. Blank uses the default, so Yitik \
                          Melek and Kuzgun keep their look.";
const FRONT_HELP: &str = "Left half only: height = 2 \u{d7} width, 96-576 px tall. Closed and \
                          opening frames still; closed \u{2264} 150 KB, each frame \u{2264} 64 KB, \
                          frames \u{2264} 500 KB together, 2-30 frames in file-name order. Loop \
                          animated, \u{2264} 1,500,000 bytes. The main image stays the full \
                          fallback that older apps draw behind.";
const FRONT_SIZES_NOTE: &str = "This item is drawn in front at a fixed 3.468 \u{d7} the avatar; \
                                these sizes apply only when it is drawn behind.";
const REASON_HELP: &str = "1-512 characters on one line, in plain ASCII. Written to the audit log.";
// A submit button that looks like secondary_button, which is type="button".
const SECONDARY_SUBMIT_CLASS: &str = "inline-flex w-fit items-center justify-center gap-2 \
                                      rounded-lg border border-neutral-300 bg-neutral-50 px-4 \
                                      py-2 font-medium text-base text-neutral-700 \
                                      transition-all duration-150 hover:border-neutral-400 \
                                      hover:text-neutral-900 focus:outline-none focus:ring-2 \
                                      focus:ring-offset-2";

// Reads the picked image into the hidden field as a data URL; the admin API takes base64 JSON.
pub(crate) const IMAGE_UPLOAD_SCRIPT: &str = r#"
(function () {
	if (window.__micupAdminImageUpload) return;
	window.__micupAdminImageUpload = true;
	document.addEventListener('change', function (event) {
		var input = event.target;
		if (!(input instanceof HTMLInputElement) || input.type !== 'file') return;
		// Micup (angel-wings): one hidden field per picked file, in file-name order.
		if (input.multiple) {
			var box = document.getElementById(input.dataset.base64Target || '');
			if (!box) return;
			box.textContent = '';
			var files = Array.prototype.slice.call(input.files || []).sort(function (a, b) {
				return a.name.localeCompare(b.name, undefined, {numeric: true});
			});
			files.forEach(function (file) {
				var field = document.createElement('input');
				field.type = 'hidden';
				field.name = input.dataset.base64Name || '';
				box.appendChild(field);
				var reader = new FileReader();
				reader.onload = function () { field.value = String(reader.result || ''); };
				reader.readAsDataURL(file);
			});
			return;
		}
		var target = document.getElementById(input.dataset.base64Target || '');
		if (!target) return;
		target.value = '';
		var file = input.files && input.files[0];
		if (!file) return;
		var reader = new FileReader();
		reader.onload = function () { target.value = String(reader.result || ''); };
		reader.readAsDataURL(file);
	});
})();
"#;

pub(crate) fn option_label<'a>(options: &'a [(&'a str, &'a str)], value: &'a str) -> &'a str {
    options
        .iter()
        .find_map(|(key, label)| (*key == value).then_some(*label))
        .unwrap_or(value)
}

pub(crate) fn select_field(
    id: &str,
    name: &str,
    options: &[(&str, &str)],
    placeholder: Option<&str>,
) -> Markup {
    html! {
        div class="relative" {
            select id=(id) name=(name) required[placeholder.is_none()] class=(FORM_SELECT_CLASS) {
                @if let Some(placeholder) = placeholder {
                    option value="" { (placeholder) }
                }
                @for (value, label) in options {
                    option value=(value) { (label) }
                }
            }
            (select_chevron())
        }
    }
}

pub(crate) fn image_field(
    id: &str,
    name: &str,
    label: &str,
    required: bool,
    helper: &str,
) -> Markup {
    let target = format!("{id}-data");
    form_field_group(
        label,
        id,
        required,
        None,
        Some(helper),
        html! {
            input type="file" id=(id) accept="image/png,image/apng,image/webp"
                data-base64-target=(target) required[required] class=(FORM_INPUT_CLASS);
            input type="hidden" id=(target) name=(name);
        },
    )
}

// Micup (angel-wings): IMAGE_UPLOAD_SCRIPT fills the hidden box with one field per picked file.
fn multi_image_field(id: &str, name: &str, label: &str, helper: &str) -> Markup {
    let target = format!("{id}-data");
    form_field_group(
        label,
        id,
        true,
        None,
        Some(helper),
        html! {
            input type="file" id=(id) multiple accept="image/png,image/apng,image/webp"
                data-base64-target=(target) data-base64-name=(name) required
                class=(FORM_INPUT_CLASS);
            div id=(target) hidden {}
        },
    )
}

pub(crate) fn text_field(
    id: &str,
    name: &str,
    value: &str,
    max_length: u32,
    required: bool,
) -> Markup {
    html! {
        input type="text" id=(id) name=(name) value=(value) maxlength=(max_length)
            required[required] class=(FORM_INPUT_CLASS);
    }
}

// Micup (shop): "Name (Type)" for items sold as owned only, the ones an account is given or a code
// carries.
pub(crate) fn owned_item_options(items: &[CosmeticItem]) -> Vec<(String, String)> {
    items
        .iter()
        .filter(|item| item.availability == "owned")
        .map(|item| {
            let item_type = option_label(ITEM_TYPES, &item.item_type);
            (item.id.clone(), format!("{} ({item_type})", item.name))
        })
        .collect()
}

// Micup (shop): read by routes::cosmetics::audit_reason.
pub(crate) fn reason_field(id: &str) -> Markup {
    form_field_group(
        "Reason",
        id,
        true,
        None,
        Some(REASON_HELP),
        html! {
            textarea id=(id) name="audit_log_reason" rows="2" maxlength="512" required
                class=(FORM_TEXTAREA_CLASS) {}
        },
    )
}

pub fn cosmetics_page(
    config: &AdminConfig,
    auth: &AuthContext,
    csrf_token: &str,
    flash: Option<&FlashMessage>,
    items: Option<&[CosmeticItem]>,
    edit_id: Option<&str>,
    ultra_id: Option<&str>,
    search: Option<&str>,
) -> Markup {
    let base = &config.base_path;
    let owned_labels = owned_item_options(items.unwrap_or_default());
    let owned_options: Vec<(&str, &str)> = owned_labels
        .iter()
        .map(|(id, label)| (id.as_str(), label.as_str()))
        .collect();
    let content = html! {
        div class="space-y-6" {
            (page_header(
                "Cosmetics",
                Some("Avatar decorations, ultra decorations, profile effects and nameplates. Taking an item off \
                      sale never deletes it: accounts that own or wear it keep it."),
            ))
            (card(html! {
                div class="flex flex-col gap-4" {
                    div class="flex flex-wrap items-center justify-between gap-3" {
                        h2 class="text-base font-semibold text-neutral-900" {
                            "Catalog"
                            @if let Some(items) = items {
                                span class="ml-2 font-normal text-neutral-500 text-sm" { (items.len()) " items" }
                            }
                        }
                        (catalog_search_form(base, search))
                    }
                    @match items {
                        None => (error_alert("Failed to load the catalog.")),
                        Some([]) => (empty_state("No cosmetic items yet.")),
                        Some(items) => (catalog_by_series(config, csrf_token, items, search)),
                    }
                }
            }))
            (card(user_item_form(base, csrf_token, &owned_options)))
            (card(relist_form(base, csrf_token, items.unwrap_or_default())))
            div id="ultra" {
                (card(ultra_form(base, csrf_token, items.unwrap_or_default(), ultra_id)))
            }
            (card(create_form(base, csrf_token)))
            div id="edit" {
                (card(edit_form(base, csrf_token, edit_id.unwrap_or(""))))
            }
        }
        script defer { (PreEscaped(IMAGE_UPLOAD_SCRIPT)) }
    };
    admin_layout(config, auth, "Cosmetics", "cosmetics", flash, content)
}

fn image_url(config: &AdminConfig, item: &CosmeticItem) -> String {
    format!(
        "{}/branding/cosmetic-{}-{}/{}.webp?size=128",
        config.media_endpoint.trim_end_matches('/'),
        item.item_type,
        item.id,
        item.asset
    )
}

// sanalyer: the catalog holds ~1650 items, so the page lists them one series at a time: a collapsed block per
// series (name, count, how many are on sale), items without a series last as "No series". A search over name, series
// and ID opens only the matching blocks.
fn catalog_search_form(base: &str, search: Option<&str>) -> Markup {
    html! {
        form method="get" action={(base) "/cosmetics"} class="flex items-center gap-2" {
            input type="search" name="q" value=(search.unwrap_or("")) placeholder="Search name, series or ID"
                class=(FORM_INPUT_CLASS) style="min-width: 18rem";
            button type="submit" class=(SECONDARY_SUBMIT_CLASS) { "Search" }
            @if search.is_some() {
                a href={(base) "/cosmetics"} class="text-neutral-500 text-sm hover:underline" { "Clear" }
            }
        }
    }
}

fn item_matches(item: &CosmeticItem, needle: &str) -> bool {
    let needle = needle.to_lowercase();
    item.name.to_lowercase().contains(&needle)
        || item.id.contains(&needle)
        || item
            .series
            .as_deref()
            .is_some_and(|series| series.to_lowercase().contains(&needle))
}

fn catalog_by_series(
    config: &AdminConfig,
    csrf_token: &str,
    items: &[CosmeticItem],
    search: Option<&str>,
) -> Markup {
    let shown: Vec<&CosmeticItem> = match search {
        Some(needle) => items.iter().filter(|item| item_matches(item, needle)).collect(),
        None => items.iter().collect(),
    };
    if shown.is_empty() {
        return empty_state("No items match the search.");
    }
    // Series in name order (case-insensitive); items without one last.
    let mut groups: Vec<(Option<String>, Vec<&CosmeticItem>)> = Vec::new();
    for item in shown {
        let key = item
            .series
            .as_deref()
            .map(|series| series.trim().to_lowercase())
            .filter(|series| !series.is_empty());
        match groups.iter_mut().find(|(group_key, _)| *group_key == key) {
            Some((_, group)) => group.push(item),
            None => groups.push((key, vec![item])),
        }
    }
    groups.sort_by(|(a, _), (b, _)| match (a, b) {
        (None, None) => std::cmp::Ordering::Equal,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (Some(_), None) => std::cmp::Ordering::Less,
        (Some(a), Some(b)) => a.cmp(b),
    });
    let open_all = search.is_some() || groups.len() == 1;
    html! {
        div class="flex flex-col gap-3" {
            @for (key, group) in &groups {
                @let label = match key {
                    Some(_) => group[0].series.as_deref().unwrap_or("").trim().to_owned(),
                    None => "No series".to_owned(),
                };
                @let on_sale = group.iter().filter(|item| item.availability != "owned").count();
                details class="rounded-lg border border-neutral-200 bg-white" open[open_all] {
                    summary class="flex cursor-pointer flex-wrap items-center gap-3 px-4 py-3" {
                        img src=(image_url(config, group[0])) alt="" loading="lazy" class="h-8 w-8 object-contain";
                        span class="font-medium text-neutral-900" { (label) }
                        span class="text-neutral-500 text-sm" {
                            (group.len()) " items, " (on_sale) " on sale"
                        }
                    }
                    div class="border-neutral-200 border-t" {
                        (catalog_table(config, csrf_token, group))
                    }
                }
            }
        }
    }
}

fn catalog_table(config: &AdminConfig, csrf_token: &str, items: &[&CosmeticItem]) -> Markup {
    let base = &config.base_path;
    let rows = html! {
        @for item in items {
            tr class="hover:bg-neutral-50 transition-colors" {
                td class="px-4 py-3" {
                    img src=(image_url(config, item)) alt="" loading="lazy"
                        class="h-12 w-12 object-contain";
                }
                td class="px-4 py-3 text-sm" {
                    div class="font-medium text-neutral-900" { (item.name) }
                    @if let Some(description) = &item.description {
                        div class="text-neutral-500 text-xs" { (description) }
                    }
                    @if let Some(series) = &item.series {
                        div class="text-neutral-500 text-xs" { "Series: " (series) }
                    }
                    div class="font-mono text-neutral-400 text-xs" { (item.id) }
                }
                td class="px-4 py-3 text-neutral-700 text-sm" {
                    (option_label(ITEM_TYPES, &item.item_type))
                }
                td class="px-4 py-3 text-sm" {
                    (badge(option_label(AVAILABILITIES, &item.availability), BadgeVariant::Default))
                }
                td class="px-4 py-3 text-sm" {
                    div class="flex flex-wrap items-center gap-3" {
                        a href={(base) "/cosmetics?edit=" (item.id) "#edit"}
                            class="font-medium text-blue-600 text-sm hover:underline" { "Edit" }
                        @if item.item_type == "avatar_ultra" {
                            a href={(base) "/cosmetics?ultra=" (item.id) "#ultra"}
                                class="font-medium text-blue-600 text-sm hover:underline" { "Size" }
                        }
                        form method="post" action={(base) "/cosmetics?action=retire"}
                            data-admin-result-form="true" {
                            (csrf_input(csrf_token))
                            input type="hidden" name="item_id" value=(item.id);
                            (danger_button("Take off sale"))
                        }
                    }
                }
            }
        }
    };
    data_table(&["Image", "Item", "Type", "Availability", "Actions"], rows)
}

fn create_form(base: &str, csrf_token: &str) -> Markup {
    html! {
        div class="flex flex-col gap-4" {
            h2 class="text-base font-semibold text-neutral-900" { "Add item" }
            form method="post" action={(base) "/cosmetics?action=create"}
                data-admin-result-form="true" {
                (csrf_input(csrf_token))
                div class="flex flex-col gap-4" {
                    div class="grid grid-cols-1 gap-4 sm:grid-cols-2" {
                        (form_field_group("Type", "cosmetic-create-type", true, None, None,
                            select_field("cosmetic-create-type", "type", ITEM_TYPES, None)))
                        (form_field_group("Availability", "cosmetic-create-availability", true,
                            None, None,
                            select_field("cosmetic-create-availability", "availability",
                                AVAILABILITIES, None)))
                    }
                    (form_field_group("Name", "cosmetic-create-name", true, None,
                        Some("1-64 characters."),
                        text_field("cosmetic-create-name", "name", "", 64, true)))
                    (form_field_group("Description", "cosmetic-create-description", false, None,
                        Some("Optional, up to 256 characters."),
                        text_field("cosmetic-create-description", "description", "", 256, false)))
                    (form_field_group("Series", "cosmetic-create-series", false, None,
                        Some("Optional, up to 64 characters; items with the same series are shown together (\"Arcade\")."),
                        text_field("cosmetic-create-series", "series", "", 64, false)))
                    (image_field("cosmetic-create-image", "asset", "Image", true,
                        "PNG, APNG or WebP, 32-2048 px on each side, at most 8 MiB."))
                    (form_actions(html! { (submit_button("Add item")) }))
                }
            }
        }
    }
}

fn edit_form(base: &str, csrf_token: &str, item_id: &str) -> Markup {
    html! {
        div class="flex flex-col gap-4" {
            h2 class="text-base font-semibold text-neutral-900" { "Change item" }
            p class="text-sm text-neutral-500" {
                "Blank fields stay as they are. Accounts that already wear the item keep \
                 the image they put on."
            }
            form method="post" action={(base) "/cosmetics?action=update"}
                data-admin-result-form="true" {
                (csrf_input(csrf_token))
                div class="flex flex-col gap-4" {
                    (form_field_group("Item ID", "cosmetic-edit-id", true, None, None,
                        text_field("cosmetic-edit-id", "item_id", item_id, 20, true)))
                    div class="grid grid-cols-1 gap-4 sm:grid-cols-2" {
                        (form_field_group("Name", "cosmetic-edit-name", false, None, None,
                            text_field("cosmetic-edit-name", "name", "", 64, false)))
                        (form_field_group("Availability", "cosmetic-edit-availability", false,
                            None, None,
                            select_field("cosmetic-edit-availability", "availability",
                                AVAILABILITIES, Some("Unchanged"))))
                    }
                    (form_field_group("Description", "cosmetic-edit-description", false, None, None,
                        text_field("cosmetic-edit-description", "description", "", 256, false)))
                    (form_field_group("Series", "cosmetic-edit-series", false, None, None,
                        text_field("cosmetic-edit-series", "series", "", 64, false)))
                    (image_field("cosmetic-edit-image", "asset", "New image", false,
                        "PNG, APNG or WebP, 32-2048 px on each side, at most 8 MiB."))
                    (form_actions(html! { (submit_button("Save changes")) }))
                }
            }
        }
    }
}

fn user_item_form(base: &str, csrf_token: &str, options: &[(&str, &str)]) -> Markup {
    html! {
        div class="flex flex-col gap-4" {
            h2 class="text-base font-semibold text-neutral-900" { "Give or take back an item" }
            p class="text-sm text-neutral-500" {
                "Items sold as owned only. Taking back an item the account wears also takes it off."
            }
            div class="grid grid-cols-1 gap-6 sm:grid-cols-2" {
                (user_item_action(base, csrf_token, options, "grant", submit_button("Give item")))
                (user_item_action(base, csrf_token, options, "revoke", danger_button("Take item back")))
            }
        }
    }
}

fn user_item_action(
    base: &str,
    csrf_token: &str,
    options: &[(&str, &str)],
    action: &str,
    button: Markup,
) -> Markup {
    let user_field = format!("cosmetic-{action}-user");
    let item_field = format!("cosmetic-{action}-item");
    html! {
        form method="post" action={(base) "/cosmetics?action=" (action)} data-admin-result-form="true" {
            (csrf_input(csrf_token))
            div class="flex flex-col gap-4" {
                (form_field_group("User ID", &user_field, true, None, None,
                    text_field(&user_field, "user_id", "", 20, true)))
                (form_field_group("Item", &item_field, true, None, None,
                    select_field(&item_field, "item_id", options, None)))
                (reason_field(&format!("cosmetic-{action}-reason")))
                (form_actions(button))
            }
        }
    }
}

// Micup (angel-wings): the catalog does not say which items are off sale, so every item is offered.
fn relist_form(base: &str, csrf_token: &str, items: &[CosmeticItem]) -> Markup {
    let labels: Vec<(String, String)> = items
        .iter()
        .map(|item| (item.id.clone(), format!("{} ({})", item.name, item.id)))
        .collect();
    let options: Vec<(&str, &str)> = labels
        .iter()
        .map(|(id, label)| (id.as_str(), label.as_str()))
        .collect();
    html! {
        div class="flex flex-col gap-4" {
            h2 class="text-base font-semibold text-neutral-900" { "Put an item back on sale" }
            p class="text-sm text-neutral-500" {
                "Returns an item taken off sale to the catalog."
            }
            @if options.is_empty() {
                (empty_state("No cosmetic items yet."))
            } @else {
                form method="post" action={(base) "/cosmetics?action=relist"}
                    data-admin-result-form="true" {
                    (csrf_input(csrf_token))
                    div class="flex flex-col gap-4" {
                        (form_field_group("Item", "cosmetic-relist-item", true, None, None,
                            select_field("cosmetic-relist-item", "item_id", &options, None)))
                        (form_actions(html! { (submit_button("Put back on sale")) }))
                    }
                }
            }
        }
    }
}

fn ultra_form(
    base: &str,
    csrf_token: &str,
    items: &[CosmeticItem],
    ultra_id: Option<&str>,
) -> Markup {
    let ultra_items: Vec<&CosmeticItem> = items
        .iter()
        .filter(|item| item.item_type == "avatar_ultra")
        .collect();
    let chosen = ultra_id.and_then(|id| ultra_items.iter().find(|item| item.id == id));
    let options: Vec<(&str, &str)> = ultra_items
        .iter()
        .map(|item| (item.id.as_str(), item.name.as_str()))
        .collect();
    html! {
        div class="flex flex-col gap-4" {
            h2 class="text-base font-semibold text-neutral-900" { "Ultra decoration size" }
            p class="text-sm text-neutral-500" { (ULTRA_HELP) }
            @if let Some(item) = chosen {
                (ultra_size_forms(base, csrf_token, item))
            } @else if options.is_empty() {
                (empty_state("No ultra decorations yet."))
            } @else {
                form method="get" action={(base) "/cosmetics"} {
                    div class="flex flex-col gap-4" {
                        (form_field_group("Item", "cosmetic-ultra-item", true, None, None,
                            select_field("cosmetic-ultra-item", "ultra", &options, None)))
                        (form_actions(html! { (submit_button("Choose")) }))
                    }
                }
            }
        }
    }
}

fn ultra_size_forms(base: &str, csrf_token: &str, item: &CosmeticItem) -> Markup {
    let headers = ["Surface"]
        .into_iter()
        .chain(ULTRA_COLUMNS.map(|(_, title)| title))
        .collect::<Vec<_>>();
    let rows = html! {
        @for (surface, label, size) in ULTRA_SURFACES {
            @let current = ultra_values(item.ultra_layout.as_ref(), surface);
            tr {
                td class="px-4 py-3 text-neutral-900 text-sm" { (label) }
                @for (index, (number, title)) in ULTRA_COLUMNS.iter().enumerate() {
                    td class="px-4 py-2" {
                        input type="number" step="0.01" name={(surface) "_" (number)}
                            min=(if index < 2 { "0.5" } else { "-3" })
                            max=(if index < 2 { "6" } else { "3" })
                            value=[current.map(|values| format!("{:.2}", values[index]))]
                            placeholder=(if index < 2 { *size } else { "0" })
                            aria-label={(label) " " (title)} class=(FORM_INPUT_CLASS);
                    }
                }
            }
        }
    };
    html! {
        p class="text-neutral-900 text-sm" {
            "Item: " span class="font-medium" { (item.name) }
        }
        @if item.ultra_front.is_some() {
            p class="text-sm text-neutral-500" { (FRONT_SIZES_NOTE) }
        }
        form method="post" action={(base) "/cosmetics?action=ultra"} data-admin-result-form="true" {
            (csrf_input(csrf_token))
            input type="hidden" name="item_id" value=(item.id);
            div class="flex flex-col gap-4" {
                (data_table(&headers, rows))
                (form_actions(html! { (submit_button("Save size")) }))
            }
        }
        form method="post" action={(base) "/cosmetics?action=ultra_reset"}
            data-admin-result-form="true" {
            (csrf_input(csrf_token))
            input type="hidden" name="item_id" value=(item.id);
            button type="submit" class=(SECONDARY_SUBMIT_CLASS) { span { "Reset to defaults" } }
        }
        (front_form(base, csrf_token, item))
    }
}

// Micup (angel-wings): the in-front images are sent and replaced as one set.
fn front_form(base: &str, csrf_token: &str, item: &CosmeticItem) -> Markup {
    let state = match &item.ultra_front {
        Some(front) => format!("Front: {} opening frames, drawn in front", front.open.len()),
        None => "Front: none (drawn behind)".to_owned(),
    };
    html! {
        h3 class="text-sm font-semibold text-neutral-900" { "Front (opens on hover)" }
        p class="text-neutral-900 text-sm" { (state) }
        p class="text-sm text-neutral-500" { (FRONT_HELP) }
        form method="post" action={(base) "/cosmetics?action=ultra_front"}
            data-admin-result-form="true" {
            (csrf_input(csrf_token))
            input type="hidden" name="item_id" value=(item.id);
            div class="flex flex-col gap-4" {
                (image_field("cosmetic-front-closed", "closed", "Closed frame", true, "Still image."))
                (multi_image_field("cosmetic-front-open", "open", "Opening frames",
                    "Still images; pick every frame at once."))
                (image_field("cosmetic-front-idle", "idle", "Loop", true, "Animated image."))
                (form_actions(html! { (submit_button("Save front")) }))
            }
        }
        @if item.ultra_front.is_some() {
            form method="post" action={(base) "/cosmetics?action=ultra_front_reset"}
                data-admin-result-form="true" {
                (csrf_input(csrf_token))
                input type="hidden" name="item_id" value=(item.id);
                button type="submit" class=(SECONDARY_SUBMIT_CLASS) { span { "Draw behind again" } }
            }
        }
    }
}

fn ultra_values(layout: Option<&UltraLayout>, surface: &str) -> Option<[f64; 4]> {
    let layout = layout?;
    let values = match surface {
        "compact" => layout.compact,
        "voice" => layout.voice,
        _ => layout.profile,
    }?;
    Some([
        values.width,
        values.height,
        values.offset_x,
        values.offset_y,
    ])
}
