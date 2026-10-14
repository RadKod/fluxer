// SPDX-License-Identifier: AGPL-3.0-or-later

use super::cosmetics::{owned_item_options, select_field};
use crate::{
    api::types::{CosmeticItem, FlashMessage, PremiumBranding},
    config::AdminConfig,
    middleware::auth::AuthContext,
    templates::{
        components::{
            alert::{alert_error, alert_success},
            form::{
                FORM_INPUT_CLASS, FORM_SELECT_CLASS, FORM_TEXTAREA_CLASS, csrf_input, form_actions,
                form_field_group, submit_button,
            },
            page_container::{card, page_header},
        },
        layout::admin_layout,
    },
};
use maud::{Markup, PreEscaped, html};

// Gift code generation: the admin panel asks the API for 100 codes at a time, in sequence. The API's admin:code:generation
// bucket takes 30 calls a minute, so one request stays at 25 calls; larger batches go through kod-uret.py, which waits
// out the limit and writes each chunk to disk.
pub const MAX_GIFT_CODES: u32 = 2_500;
const DEFAULT_GIFT_COUNT: u32 = 10;
// Item codes: shows only the fields of the chosen kind of code. Without the script both groups
// show and the server reads the chosen kind.
const GIVES_SCRIPT: &str = r#"
(function () {
	function sync() {
		var item = document.getElementById('gift-gives-cosmetic');
		var premium = document.getElementById('gift-premium-fields');
		var cosmetic = document.getElementById('gift-cosmetic-fields');
		if (!item || !premium || !cosmetic) return;
		premium.hidden = item.checked;
		cosmetic.hidden = !item.checked;
	}
	if (!window.__micupAdminGiftGives) {
		window.__micupAdminGiftGives = true;
		document.addEventListener('change', function (event) {
			var target = event.target;
			if (target instanceof HTMLInputElement && target.name === 'gives') sync();
		});
	}
	sync();
})();
"#;

pub struct GeneratedGiftCodes<'a> {
    pub urls: &'a [String],
    pub requested: u32,
    pub error: Option<&'a str>,
}

// Item codes: `items` are the owned-only items this admin may put on a code; None hides the
// choice and leaves the premium form as it was.
pub struct GiftCodesPremium {
    pub name: String,
    pub needs_mirror_mode: bool,
}

impl GiftCodesPremium {
    pub fn from_branding(self_hosted: bool, branding: Option<&PremiumBranding>) -> Self {
        let default_name = if self_hosted { "Premium" } else { "Plutonium" };
        Self {
            name: branding
                .and_then(|branding| branding.name.as_deref())
                .unwrap_or(default_name)
                .to_owned(),
            needs_mirror_mode: self_hosted
                && branding.is_some_and(|branding| !branding.premium_enabled),
        }
    }
}

pub fn gift_codes_page(
    config: &AdminConfig,
    auth: &AuthContext,
    csrf_token: &str,
    flash: Option<&FlashMessage>,
    generated: Option<&GeneratedGiftCodes<'_>>,
    items: Option<&[CosmeticItem]>,
    premium: &GiftCodesPremium,
) -> Markup {
    let base = &config.base_path;
    let codes_value = generated
        .map(|generated| generated.urls.join("\n"))
        .unwrap_or_default();
    let item_labels = owned_item_options(items.unwrap_or_default());
    let item_options: Vec<(&str, &str)> = item_labels
        .iter()
        .map(|(id, label)| (id.as_str(), label.as_str()))
        .collect();

    let content = html! {
        (page_header(
            "Gift Codes",
            Some("Create one-use Plus or item gift URLs. Plus codes carry a fixed positive \
                  duration; lifetime gifts cannot be generated here."),
        ))
        @if premium.needs_mirror_mode {
            (card(html! {
                p class="text-sm text-amber-700" {
                    "The premium model is Everyone, so every member already has " (premium.name)
                    " and gift codes cannot be generated or redeemed. Switch the premium model to \
                     Mirror in Instance Config to use gift codes."
                }
            }))
        }

        @if let Some(generated) = generated {
            @if let Some(error) = generated.error {
                (alert_error("Generation stopped", html! {
                    "Generated " (generated.urls.len()) " of " (generated.requested)
                    " codes before stopping (" (error) "). The codes below are valid and \
                     are not stored by the admin panel: copy them before leaving this page."
                }))
            } @else {
                (alert_success("Codes generated", html! {
                    (generated.urls.len()) " gift codes. They are not stored by the admin \
                     panel: copy them before leaving this page."
                }))
            }
        }

        (card(html! {
            div class="flex flex-col gap-4" {
                h2 class="text-xl font-semibold text-neutral-900" {
                    "Generate Gift Codes"
                }
                form id="gift-form" method="post" action={(base) "/gift-codes"} hx-boost="false" {
                    (csrf_input(csrf_token))
                    div class="flex flex-col gap-4" {
                        (form_field_group(
                            "Number of codes", "gift-count-slider", true, None,
                            Some(&format!(
                                "Range: 1-{MAX_GIFT_CODES} per request. For a larger batch run                                  robot/fluxer/kod-uret.py, which waits out the API rate limit."
                            )),
                            html! {
                                input type="number" id="gift-count-slider" name="count"
                                    value=(DEFAULT_GIFT_COUNT) min="1"
                                    max=(MAX_GIFT_CODES) required
                                    class=(FORM_INPUT_CLASS);
                            },
                        ))

                        @if items.is_some() {
                            (form_field_group(
                                "What the code gives", "gift-gives-premium", true, None, None,
                                html! {
                                    div class="flex flex-wrap gap-6 text-neutral-900 text-sm" {
                                        label class="flex items-center gap-2" {
                                            input type="radio" id="gift-gives-premium" name="gives"
                                                value="premium" checked;
                                            "Plus time"
                                        }
                                        label class="flex items-center gap-2" {
                                            input type="radio" id="gift-gives-cosmetic" name="gives"
                                                value="cosmetic";
                                            "Cosmetic item"
                                        }
                                    }
                                },
                            ))
                        }

                        div id="gift-premium-fields" class="grid grid-cols-1 gap-4 sm:grid-cols-2" {
                            (form_field_group(
                                "Duration quantity", "gift-duration-quantity",
                                true, None,
                                Some("Use a positive whole number."),
                                html! {
                                    input type="number" id="gift-duration-quantity"
                                        name="duration_quantity" value="1" min="1"
                                        max="3650" required
                                        class=(FORM_INPUT_CLASS);
                                },
                            ))
                            (form_field_group(
                                "Duration unit", "gift-duration-type",
                                true, None,
                                Some("Days, weeks, months, or years. \
                                      No lifetime option is available."),
                                html! {
                                    select id="gift-duration-type" name="duration_type"
                                        required class=(FORM_SELECT_CLASS) {
                                        option value="days" { "Days" }
                                        option value="weeks" { "Weeks" }
                                        option value="months" selected { "Months" }
                                        option value="years" { "Years" }
                                    }
                                },
                            ))
                        }

                        @if items.is_some() {
                            div id="gift-cosmetic-fields" {
                                (form_field_group(
                                    "Item", "gift-item", false, None,
                                    Some("Items sold as owned only. The CSV names the item on \
                                          every row."),
                                    select_field("gift-item", "item_id", &item_options,
                                        Some("Choose an item")),
                                ))
                            }
                        }

                        (form_actions(html! {
                            (submit_button("Generate Codes"))
                            button type="submit" name="format" value="csv"
                                class="inline-flex w-fit items-center justify-center gap-2 \
                                       rounded-lg border border-neutral-300 bg-neutral-50 px-4 \
                                       py-2 font-medium text-base text-neutral-700 \
                                       transition-all duration-150 hover:border-neutral-400 \
                                       hover:text-neutral-900 focus:outline-none focus:ring-2 \
                                       focus:ring-offset-2" {
                                span { "Generate and download CSV" }
                            }
                        }))

                        (form_field_group(
                            "Generated URLs", "gift-generated-urls", false, None,
                            Some("Copy one URL per line. Codes are shown only \
                                  after generation."),
                            html! {
                                textarea id="gift-generated-urls"
                                    readonly rows="10"
                                    placeholder="Generated gift URLs will appear here."
                                    class=(FORM_TEXTAREA_CLASS) {
                                    (codes_value)
                                }
                            },
                        ))
                    }
                }
            }
        }))
        @if items.is_some() {
            script { (PreEscaped(GIVES_SCRIPT)) }
        }
    };
    admin_layout(config, auth, "Gift Codes", "gift-codes", flash, content)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn branding(name: &str, premium_enabled: bool) -> PremiumBranding {
        PremiumBranding {
            name: Some(name.to_owned()),
            premium_enabled,
        }
    }

    #[test]
    fn premium_name_comes_from_branding_with_per_deployment_fallbacks() {
        let hosted = GiftCodesPremium::from_branding(false, None);
        assert_eq!(hosted.name, "Plutonium");
        assert!(!hosted.needs_mirror_mode);
        let self_hosted = GiftCodesPremium::from_branding(true, None);
        assert_eq!(self_hosted.name, "Premium");
        assert!(!self_hosted.needs_mirror_mode);
        let gold = GiftCodesPremium::from_branding(true, Some(&branding("Gold", true)));
        assert_eq!(gold.name, "Gold");
        assert!(!gold.needs_mirror_mode);
    }

    #[test]
    fn everyone_mode_is_only_flagged_on_self_hosted_instances() {
        assert!(
            GiftCodesPremium::from_branding(true, Some(&branding("Gold", false))).needs_mirror_mode
        );
        assert!(
            !GiftCodesPremium::from_branding(false, Some(&branding("Plutonium", false)))
                .needs_mirror_mode
        );
    }
}
