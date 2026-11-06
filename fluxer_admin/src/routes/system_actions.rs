// SPDX-License-Identifier: AGPL-3.0-or-later

use crate::{
    api::{
        client::AdminApiClient,
        types::{
            CAPTCHA_COST_RANGE, CAPTCHA_MAX_COUNTER_RANGE, CaptchaConfigUpdateRequest,
            GatewayRolloutConfigUpdateRequest, GatewayRolloutMode,
            InstanceAttachmentDecayUpdateRequest, InstanceConfigUpdateRequest,
            InstanceMediaUpdateRequest, InstanceRegistrationConfigUpdateRequest,
            PushRelayConfigUpdateRequest, RegistrationMode, VoiceE2eeScope,
            // sanalyer (Micup): voice noise suppression and 3D voice rooms.
            EXPERIMENT_MAX_TARGETED_USERS, NoiseSuppressionBackend, VOICE_NS_MAX_GUILD_OVERRIDES,
            VoiceNoiseSuppressionConfigUpdateRequest, VoiceNoiseSuppressionGuildOverride,
            VoiceRoomConfigUpdateRequest,
        },
    },
    config::AdminConfig,
    middleware::{
        csrf::CsrfToken,
        flash::{self, FlashData},
        htmx,
    },
    state::AppState,
    templates::pages::{
        instance_branding::CUSTOM_CSS_FIELD,
        instance_config::{
            LOADED_CONFIG_FIELD, REGISTRATION_ALLOWED_EMAIL_DOMAINS_FIELD,
            SSO_ALLOWED_DOMAINS_FIELD,
        },
    },
    utils::forms::MultiValueForm,
};
use axum::{
    extract::{Query, Request, State},
    http::HeaderMap,
    response::{Html, IntoResponse, Response},
};
use maud::Markup;
use serde::Deserialize;

mod accounts;
mod app_public;
mod branding_assets;
mod experiments;
mod integrations;
mod notices;
mod policy;
mod registration_urls;
mod sso;

#[derive(Deserialize)]
pub(super) struct ActionQuery {
    pub(super) action: Option<String>,
    pub(super) rule: Option<String>,
}

pub(super) fn redirect_back_with_flash(
    base: &str,
    path: &str,
    fd: FlashData,
    secure: bool,
) -> Response {
    flash::redirect_with_flash(&format!("{base}{path}"), fd, secure)
}

pub async fn gateway_post(
    State(state): State<AppState>,
    auth: axum::Extension<crate::middleware::auth::AuthContext>,
    Query(aq): Query<ActionQuery>,
    request: Request,
) -> Response {
    let config = state.config();
    let base = &config.base_path;
    let form = match MultiValueForm::from_request(request).await {
        Some(form) => form,
        None => {
            return redirect_back_with_flash(
                base,
                "/gateway",
                FlashData::error("Invalid form data"),
                config.secure_cookies(),
            );
        }
    };
    let client = AdminApiClient::new(state.http_client(), config, &auth.0.session);
    let flash = if aq.action.as_deref() == Some("reload_all") {
        let ids = form.list_values_any(&["guild_ids[]", "guild_ids"]);
        match client.reload_all_guilds(&ids).await {
            Ok(_) => FlashData::success("Gateway action completed"),
            Err(error) => {
                tracing::warn!(%error, "admin API request failed: reload all guilds");
                FlashData::error("Failed to reload gateway guilds")
            }
        }
    } else {
        FlashData::error("Unknown gateway action")
    };
    redirect_back_with_flash(base, "/gateway", flash, config.secure_cookies())
}

pub async fn search_index_post(
    State(state): State<AppState>,
    auth: axum::Extension<crate::middleware::auth::AuthContext>,
    request: Request,
) -> Response {
    let config = state.config();
    let base = &config.base_path;
    let form = match MultiValueForm::from_request(request).await {
        Some(form) => form,
        None => {
            return redirect_back_with_flash(
                base,
                "/search-index",
                FlashData::error("Invalid form data"),
                config.secure_cookies(),
            );
        }
    };
    let client = AdminApiClient::new(state.http_client(), config, &auth.0.session);
    let index_type = form.clean("index_type");
    let guild_id = form.clean("guild_id");
    if let Some(idx_type) = index_type {
        return match client
            .refresh_search_index(&idx_type, guild_id.as_deref())
            .await
        {
            Ok(result) => {
                let job_id = &result.job_id;
                flash::redirect_with_flash(
                    &format!("{base}/search-index?job_id={job_id}"),
                    FlashData::success("Search index refresh started"),
                    config.secure_cookies(),
                )
            }
            Err(error) => {
                tracing::warn!(%error, "admin API request failed: refresh search index");
                redirect_back_with_flash(
                    base,
                    "/search-index",
                    FlashData::error("Failed to start search index refresh"),
                    config.secure_cookies(),
                )
            }
        };
    }
    redirect_back_with_flash(
        base,
        "/search-index",
        FlashData::error("Index type is required"),
        config.secure_cookies(),
    )
}

enum UpdateFeedback {
    Standard,
    Field(&'static str, &'static str),
    Premium,
    Billing,
}

pub async fn instance_config_post(
    State(state): State<AppState>,
    headers: HeaderMap,
    auth: axum::Extension<crate::middleware::auth::AuthContext>,
    csrf: axum::Extension<CsrfToken>,
    Query(aq): Query<ActionQuery>,
    request: Request,
) -> Response {
    let branding_action = match aq.action.as_deref() {
        Some("upload_branding_asset") => Some(branding_assets::Action::Upload),
        Some("remove_branding_asset") => Some(branding_assets::Action::Remove),
        _ => None,
    };
    if let Some(action) = branding_action {
        return branding_assets::post(&state, &headers, &auth.0, action, request).await;
    }
    let config = state.config();
    let form = match MultiValueForm::from_request(request).await {
        Some(form) => form,
        None => {
            let flash = FlashData::error("Invalid form data");
            return instance_config_response(config, &headers, flash);
        }
    };
    let client = AdminApiClient::new(state.http_client(), config, &auth.0.session);
    let action = aq.action.as_deref().unwrap_or("");
    let flash = 'action: {
        match action {
            "update_integrations" => {
                break 'action integrations::run(&client, &form, integrations::Action::Update)
                    .await;
            }
            "test_smtp" => {
                break 'action integrations::run(&client, &form, integrations::Action::Test).await;
            }
            _ => {}
        }
        let registration_action = match action {
            "create_registration_url" => Some(registration_urls::Action::Create),
            "rename_registration_url" => Some(registration_urls::Action::Rename),
            "revoke_registration_url" => Some(registration_urls::Action::Revoke),
            "remove_registration_url" => Some(registration_urls::Action::Remove),
            _ => None,
        };
        if let Some(action) = registration_action {
            match registration_urls::run(&client, &form, &headers, config, &csrf.0.0, action).await
            {
                registration_urls::Outcome::Flash(flash) => break 'action flash,
                registration_urls::Outcome::Response(response) => return response,
            }
        }
        let update = match action {
            "update_sso" => sso::build_sso_update(&form).map_err(FlashData::error),
            "update_gateway_rollout" => {
                build_gateway_rollout_update(&form).map_err(FlashData::error)
            }
            // sanalyer (Micup): voice noise suppression and 3D voice rooms.
            "update_voice_noise_suppression" => {
                build_voice_noise_suppression_update(&form).map_err(FlashData::error)
            }
            "disable_voice_pipeline_v2" => Ok(InstanceConfigUpdateRequest {
                voice_noise_suppression: Some(VoiceNoiseSuppressionConfigUpdateRequest {
                    pipeline_v2_enabled: Some(false),
                    ..Default::default()
                }),
                ..Default::default()
            }),
            "update_voice_room" => build_voice_room_update(&form).map_err(FlashData::error),
            "update_registration" => Ok(build_registration_update(&form)),
            "update_app_public" => app_public::build_app_public_update(&form),
            "update_app_legal" => Ok(app_public::build_app_legal_update(&form)),
            "update_policy" => Ok(policy::build_policy_update(&form)),
            "update_media" => Ok(build_media_update(&form)),
            "update_billing" => {
                super::billing_actions::build_billing_update(&form).map_err(FlashData::error)
            }
            "update_push_relay" => Ok(build_push_relay_update(&form)),
            "update_domain_migration" => {
                experiments::build_domain_migration_update(&form).map_err(FlashData::error)
            }
            "update_voice_p2p" => {
                experiments::build_voice_p2p_update(&form).map_err(FlashData::error)
            }
            "update_captcha" => build_captcha_update(&form).map_err(FlashData::error),
            "update_accounts" => accounts::build_accounts_update(&form).map_err(FlashData::error),
            "update_guild_visits" => {
                experiments::build_guild_visits_update(&form).map_err(FlashData::error)
            }
            "update_experiment_delivery" => {
                experiments::build_experiment_delivery_update(&form).map_err(FlashData::error)
            }
            "disable_single_community" => Ok(policy::build_single_community_update(
                &form,
                policy::CommunityAction::Disable,
            )),
            "enable_single_community" => Ok(policy::build_single_community_update(
                &form,
                policy::CommunityAction::Enable,
            )),
            "update_single_community" => Ok(policy::build_single_community_update(
                &form,
                policy::CommunityAction::Update,
            )),
            "update_notice" => notices::build_notice_update(&form).map_err(FlashData::error),
            _ => Err(FlashData::error("Unknown instance config action")),
        };
        let update = match update {
            Ok(update) => update,
            Err(flash) => break 'action flash,
        };
        if let Some(loaded) = form
            .first(LOADED_CONFIG_FIELD)
            .filter(|loaded| !loaded.is_empty())
            && let Ok(current) = client.get_instance_config().await
            && current.changed_since(loaded, &update)
        {
            break 'action FlashData::error(
                "Someone else changed these settings after you opened this page. Reload the page to see their change, then make yours again.",
            );
        }
        let feedback = match action {
            "update_sso" => UpdateFeedback::Field("allowed_domains", SSO_ALLOWED_DOMAINS_FIELD),
            "update_registration" => UpdateFeedback::Field(
                "allowed_email_domains",
                REGISTRATION_ALLOWED_EMAIL_DOMAINS_FIELD,
            ),
            "update_app_public" => {
                UpdateFeedback::Field("app_public.branding.custom_css", CUSTOM_CSS_FIELD)
            }
            "update_policy" => UpdateFeedback::Premium,
            "update_billing" => UpdateFeedback::Billing,
            _ => UpdateFeedback::Standard,
        };
        let result = client.update_instance_config(&update).await;
        if matches!(feedback, UpdateFeedback::Premium | UpdateFeedback::Billing) {
            remember_premium_branding(&state, &result);
        }
        let warnings = result
            .as_ref()
            .map(|saved| saved.warnings.clone())
            .unwrap_or_default();
        let flash = match feedback {
            UpdateFeedback::Field(api_path, field) => field_result(result, api_path, field),
            UpdateFeedback::Billing => super::billing_actions::billing_result(result),
            UpdateFeedback::Standard | UpdateFeedback::Premium => instance_config_result(result),
        };
        with_save_warnings(flash, &warnings)
    };
    state.forget_instance_settings();
    instance_config_response(config, &headers, flash)
}

fn instance_config_response(
    config: &AdminConfig,
    headers: &HeaderMap,
    flash: FlashData,
) -> Response {
    if htmx::is_htmx_request(headers) {
        return htmx::toast_response(&flash);
    }
    redirect_back_with_flash(
        &config.base_path,
        "/instance-config",
        flash,
        config.secure_cookies(),
    )
}

fn remember_premium_branding(
    state: &AppState,
    result: &Result<crate::api::types::InstanceConfigResponse, crate::api::client::ApiError>,
) {
    if let Ok(instance_config) = result {
        state.remember_instance_config_branding(instance_config);
    }
}

fn render_fragment_with_toast(markup: Markup, flash: &FlashData) -> Response {
    let mut response = Html(markup.into_string()).into_response();
    htmx::add_toast_header(&mut response, flash);
    response
}

fn with_api_reason(summary: &str, error: &crate::api::client::ApiError) -> String {
    match error.detail_message() {
        Some(reason) => format!("{summary}: {reason}"),
        None => summary.to_owned(),
    }
}

fn with_save_warnings(flash: FlashData, warnings: &[String]) -> FlashData {
    if warnings.is_empty() {
        return flash;
    }
    FlashData::info(format!("Instance config updated. {}", warnings.join(" ")))
}

fn instance_config_result<T>(result: Result<T, crate::api::client::ApiError>) -> FlashData {
    match result {
        Ok(_) => FlashData::success("Instance config updated"),
        Err(error) => {
            tracing::warn!(%error, "admin API request failed: update instance config");
            match error.validation_message() {
                Some(message) => {
                    FlashData::error(format!("Failed to update instance config: {message}"))
                }
                None => FlashData::error("Failed to update instance config"),
            }
        }
    }
}

fn field_result<T>(
    result: Result<T, crate::api::client::ApiError>,
    api_path: &str,
    field: &str,
) -> FlashData {
    let errors = result
        .as_ref()
        .err()
        .map(crate::api::client::ApiError::field_errors)
        .unwrap_or_default();
    let field_error = errors
        .iter()
        .find(|(path, _)| path == api_path)
        .map(|(_, message)| message.clone());
    let flash = instance_config_result(result);
    match field_error {
        Some(message) if errors.len() == 1 => {
            FlashData::error(message.clone()).with_field_error(field, message)
        }
        Some(message) => flash.with_field_error(field, message),
        None => flash,
    }
}

fn build_gateway_rollout_update(
    form: &MultiValueForm,
) -> Result<InstanceConfigUpdateRequest, String> {
    let get_f64 = |key: &str| {
        form.first(key)
            .and_then(|value| value.trim().parse::<f64>().ok())
    };
    let session_rollout_mode = match form.first("gateway_rollout_session_rollout_mode") {
        Some("random") => Some(GatewayRolloutMode::Random),
        Some("modulo") => Some(GatewayRolloutMode::Modulo),
        _ => None,
    };
    let voice_e2ee_scope = match form.first("gateway_rollout_voice_e2ee_scope") {
        Some("platform_wide") => Some(VoiceE2eeScope::PlatformWide),
        Some("guild_feature_only") => Some(VoiceE2eeScope::GuildFeatureOnly),
        _ => None,
    };
    Ok(InstanceConfigUpdateRequest {
        gateway_rollout: Some(GatewayRolloutConfigUpdateRequest {
            session_rollout_percentage: get_f64("gateway_rollout_session_rollout_percentage"),
            session_rollout_mode,
            guild_rollout_percentage: get_f64("gateway_rollout_guild_rollout_percentage"),
            rpc_request_timeout_ms: form.parse_u64("gateway_rollout_rpc_request_timeout_ms"),
            max_concurrent_session_starts: form
                .parse_u64("gateway_rollout_max_concurrent_session_starts"),
            max_concurrent_guild_starts: form
                .parse_u64("gateway_rollout_max_concurrent_guild_starts"),
            voice_e2ee_scope,
            // sanalyer: game activity ("now playing") had no admin control; the checkbox lives in this form.
            game_activity_enabled: Some(form.bool_value("gateway_rollout_game_activity_enabled")),
            max_connections: parse_form_number(
                form,
                "gateway_rollout_max_connections",
                "Max connections",
                0,
                200000,
            )?,
        }),
        ..Default::default()
    })
}

fn parse_form_number<T>(
    form: &MultiValueForm,
    key: &str,
    label: &str,
    min: T,
    max: T,
) -> Result<Option<T>, String>
where
    T: std::str::FromStr + Ord + std::fmt::Display,
{
    let Some(raw) = form.first(key) else {
        return Ok(None);
    };
    let invalid = || format!("{label} must be a whole number between {min} and {max}");
    let value = raw.trim().parse::<T>().map_err(|_| invalid())?;
    if value < min || value > max {
        return Err(invalid());
    }
    Ok(Some(value))
}

fn build_push_relay_update(form: &MultiValueForm) -> InstanceConfigUpdateRequest {
    InstanceConfigUpdateRequest {
        push_relay: Some(PushRelayConfigUpdateRequest {
            relay_consent_accepted: Some(form.bool_value("push_relay_consent_accepted")),
        }),
        ..Default::default()
    }
}

fn build_captcha_update(form: &MultiValueForm) -> Result<InstanceConfigUpdateRequest, String> {
    Ok(InstanceConfigUpdateRequest {
        captcha: Some(CaptchaConfigUpdateRequest {
            provider: parse_choice(form, "captcha_provider", "Check")?,
            cost: parse_form_number(
                form,
                "captcha_cost",
                "Cost",
                *CAPTCHA_COST_RANGE.start(),
                *CAPTCHA_COST_RANGE.end(),
            )?,
            max_counter: parse_form_number(
                form,
                "captcha_max_counter",
                "Maximum counter",
                *CAPTCHA_MAX_COUNTER_RANGE.start(),
                *CAPTCHA_MAX_COUNTER_RANGE.end(),
            )?,
        }),
        ..Default::default()
    })
}

fn parse_choice<T: std::str::FromStr>(
    form: &MultiValueForm,
    key: &str,
    label: &str,
) -> Result<Option<T>, String> {
    match form.first(key) {
        None => Ok(None),
        Some(raw) => raw
            .trim()
            .parse()
            .map(Some)
            .map_err(|_| format!("{label} has an unknown value")),
    }
}

fn build_registration_update(form: &MultiValueForm) -> InstanceConfigUpdateRequest {
    let mode = match form.first("registration_mode") {
        Some("approval") => Some(RegistrationMode::Approval),
        Some("closed") => Some(RegistrationMode::Closed),
        Some("open") => Some(RegistrationMode::Open),
        _ => None,
    };
    InstanceConfigUpdateRequest {
        registration: Some(InstanceRegistrationConfigUpdateRequest {
            mode,
            admin_registration_urls_enabled: Some(
                form.bool_value("admin_registration_urls_enabled"),
            ),
            allowed_email_domains: form
                .contains_key(REGISTRATION_ALLOWED_EMAIL_DOMAINS_FIELD)
                .then(|| form.list_values(REGISTRATION_ALLOWED_EMAIL_DOMAINS_FIELD)),
        }),
        ..Default::default()
    }
}

fn parse_tristate(form: &MultiValueForm, key: &str) -> Option<Option<bool>> {
    match form.first(key) {
        Some("inherit") => Some(None),
        Some("on") => Some(Some(true)),
        Some("off") => Some(Some(false)),
        _ => None,
    }
}

fn parse_inheritable<T: std::str::FromStr>(form: &MultiValueForm, key: &str) -> Option<Option<T>> {
    let value = form.first(key)?.trim();
    if value.is_empty() {
        return Some(None);
    }
    value.parse().ok().map(Some)
}

fn build_media_update(form: &MultiValueForm) -> InstanceConfigUpdateRequest {
    InstanceConfigUpdateRequest {
        media: Some(InstanceMediaUpdateRequest {
            attachment_decay: Some(InstanceAttachmentDecayUpdateRequest {
                enabled: parse_tristate(form, "media_attachment_decay_enabled"),
                min_size_mb: parse_inheritable(form, "media_attachment_decay_min_size_mb"),
                max_size_mb: parse_inheritable(form, "media_attachment_decay_max_size_mb"),
                max_eligible_size_mb: parse_inheritable(
                    form,
                    "media_attachment_decay_max_eligible_size_mb",
                ),
                min_lifetime_days: parse_inheritable(
                    form,
                    "media_attachment_decay_min_lifetime_days",
                ),
                max_lifetime_days: parse_inheritable(
                    form,
                    "media_attachment_decay_max_lifetime_days",
                ),
                curve: parse_inheritable(form, "media_attachment_decay_curve"),
                renew_threshold_days: parse_inheritable(
                    form,
                    "media_attachment_decay_renew_threshold_days",
                ),
                renew_window_days: parse_inheritable(
                    form,
                    "media_attachment_decay_renew_window_days",
                ),
            }),
        }),
        ..Default::default()
    }
}

// sanalyer (Micup): voice noise suppression and 3D voice room settings.
const VOICE_NS_SUPPRESSION_STRENGTH_MAX: u32 = 100;
const EXPERIMENT_ROLLOUT_BASIS_POINTS_MAX: u32 = 10_000;
const EXPERIMENT_MAX_ROLLOUT_SALT_CHARS: usize = 64;
const EXPERIMENT_MAX_SNOWFLAKE_LENGTH: usize = 20;

fn parse_form_decimal(
    form: &MultiValueForm,
    key: &str,
    label: &str,
    min: f64,
    max: f64,
) -> Result<Option<f64>, String> {
    let Some(raw) = form.first(key) else {
        return Ok(None);
    };
    match raw.trim().parse::<f64>() {
        Ok(value) if (min..=max).contains(&value) => Ok(Some(value)),
        _ => Err(format!("{label} must be a number between {min} and {max}")),
    }
}

// Voice noise suppression salts follow VoiceNoiseSuppressionSchemas: any text of 1 to 64 UTF-16
// units. The experiment schemas below additionally restrict their salts to printable ASCII.
fn parse_rollout_salt(form: &MultiValueForm, key: &str) -> Result<Option<String>, String> {
    let Some(raw) = form.first(key) else {
        return Ok(None);
    };
    let salt = raw.trim();
    if salt.is_empty() || salt.encode_utf16().count() > EXPERIMENT_MAX_ROLLOUT_SALT_CHARS {
        return Err(format!(
            "Rollout salt must be between 1 and {EXPERIMENT_MAX_ROLLOUT_SALT_CHARS} characters"
        ));
    }
    Ok(Some(salt.to_owned()))
}

fn is_experiment_snowflake(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= EXPERIMENT_MAX_SNOWFLAKE_LENGTH
        && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn parse_experiment_user_ids(value: &str, label: &str) -> Result<Vec<String>, String> {
    let mut ids: Vec<String> = Vec::new();
    for (index, candidate) in value.split([',', '\n', '\r']).enumerate() {
        let candidate = candidate.trim();
        if candidate.is_empty() {
            continue;
        }
        if !is_experiment_snowflake(candidate) {
            return Err(format!(
                "{label} entry {} must contain 1 to 20 decimal digits",
                index + 1
            ));
        }
        if ids.iter().any(|existing| existing == candidate) {
            continue;
        }
        if ids.len() == EXPERIMENT_MAX_TARGETED_USERS {
            return Err(format!(
                "{label} must contain at most {EXPERIMENT_MAX_TARGETED_USERS} unique IDs"
            ));
        }
        ids.push(candidate.to_owned());
    }
    Ok(ids)
}

fn parse_voice_noise_suppression_guild_overrides(
    value: &str,
) -> Result<Vec<VoiceNoiseSuppressionGuildOverride>, String> {
    let mut overrides: Vec<VoiceNoiseSuppressionGuildOverride> = Vec::new();
    for (index, line) in value.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let line_number = index + 1;
        let (guild_id, backend) = line.split_once('=').ok_or_else(|| {
            format!("Guild overrides line {line_number} must use guild_id=backend")
        })?;
        let guild_id = guild_id.trim();
        if !is_experiment_snowflake(guild_id) {
            return Err(format!(
                "Guild overrides line {line_number} must use a guild ID with 1 to 20 decimal digits"
            ));
        }
        let backend = backend.trim().parse().map_err(|_| {
            format!("Guild overrides line {line_number} must name a supported backend")
        })?;
        if let Some(existing) = overrides
            .iter()
            .find(|existing| existing.guild_id == guild_id)
        {
            if existing.backend != backend {
                return Err(format!(
                    "Guild overrides line {line_number} conflicts with an earlier rule for guild {guild_id}"
                ));
            }
            continue;
        }
        if overrides.len() == VOICE_NS_MAX_GUILD_OVERRIDES {
            return Err(format!(
                "Guild overrides must contain at most {VOICE_NS_MAX_GUILD_OVERRIDES} unique guilds"
            ));
        }
        overrides.push(VoiceNoiseSuppressionGuildOverride {
            guild_id: guild_id.to_owned(),
            backend,
            pipeline_v2: false,
        });
    }
    Ok(overrides)
}

fn build_voice_noise_suppression_update(
    form: &MultiValueForm,
) -> Result<InstanceConfigUpdateRequest, String> {
    let mut guild_overrides = parse_voice_noise_suppression_guild_overrides(
        form.first("voice_ns_guild_overrides").unwrap_or_default(),
    )?;
    let pipeline_v2_guild_ids = form.list_values_any(&[
        "voice_ns_pipeline_v2_guild_ids[]",
        "voice_ns_pipeline_v2_guild_ids",
    ]);
    for entry in &mut guild_overrides {
        entry.pipeline_v2 = pipeline_v2_guild_ids.contains(&entry.guild_id);
    }
    let selected: Vec<NoiseSuppressionBackend> = form
        .list_values_any(&["voice_ns_enabled_backends[]", "voice_ns_enabled_backends"])
        .into_iter()
        .map(|value| {
            value.parse().map_err(|_| {
                "Enabled backends must name supported noise suppression backends".to_owned()
            })
        })
        .collect::<Result<_, _>>()?;
    let enabled_backends = NoiseSuppressionBackend::ALL
        .into_iter()
        .filter(|backend| selected.contains(backend))
        .collect();
    Ok(InstanceConfigUpdateRequest {
        voice_noise_suppression: Some(VoiceNoiseSuppressionConfigUpdateRequest {
            enabled: Some(form.bool_value("voice_ns_enabled")),
            pipeline_v2_enabled: Some(form.bool_value("voice_ns_pipeline_v2_enabled")),
            pipeline_v2_all: Some(form.bool_value("voice_ns_pipeline_v2_all")),
            pipeline_v2_gate_open_probability: parse_form_decimal(
                form,
                "voice_ns_pipeline_v2_gate_open_probability",
                "Gate open probability",
                0.3,
                0.95,
            )?,
            pipeline_v2_gate_refresh_probability: parse_form_decimal(
                form,
                "voice_ns_pipeline_v2_gate_refresh_probability",
                "Gate refresh probability",
                0.1,
                0.9,
            )?,
            pipeline_v2_gate_hangover_ms: parse_form_number(
                form,
                "voice_ns_pipeline_v2_gate_hangover_ms",
                "Gate hangover",
                100,
                1500,
            )?,
            pipeline_v2_gain_target_dbfs: parse_form_number(
                form,
                "voice_ns_pipeline_v2_gain_target_dbfs",
                "Gain target",
                -40,
                -14,
            )?,
            pipeline_v2_gain_max_db: parse_form_number(
                form,
                "voice_ns_pipeline_v2_gain_max_db",
                "Maximum gain",
                0,
                30,
            )?,
            default_backend: form
                .first("voice_ns_default_backend")
                .map(|value| {
                    value.parse().map_err(|_| {
                        "Default backend must name a supported noise suppression backend".to_owned()
                    })
                })
                .transpose()?,
            enabled_backends: Some(enabled_backends),
            allow_user_override: Some(form.bool_value("voice_ns_allow_user_override")),
            rollout_basis_points: parse_form_number(
                form,
                "voice_ns_rollout_basis_points",
                "Rollout basis points",
                0,
                EXPERIMENT_ROLLOUT_BASIS_POINTS_MAX,
            )?,
            rollout_salt: parse_rollout_salt(form, "voice_ns_rollout_salt")?,
            included_user_ids: Some(parse_experiment_user_ids(
                form.first("voice_ns_included_user_ids").unwrap_or_default(),
                "Included user IDs",
            )?),
            excluded_user_ids: Some(parse_experiment_user_ids(
                form.first("voice_ns_excluded_user_ids").unwrap_or_default(),
                "Excluded user IDs",
            )?),
            guild_overrides: Some(guild_overrides),
            suppression_strength: parse_form_number(
                form,
                "voice_ns_suppression_strength",
                "Suppression strength",
                0,
                VOICE_NS_SUPPRESSION_STRENGTH_MAX,
            )?,
        }),
        ..Default::default()
    })
}

fn build_voice_room_update(form: &MultiValueForm) -> Result<InstanceConfigUpdateRequest, String> {
    let rooms_enabled = form.bool_value("voice_room_rooms_enabled");
    let default_room_theme = form
        .contains_key("voice_room_default_room_theme")
        .then(|| form.clean("voice_room_default_room_theme"));
    if let Some(Some(theme)) = &default_room_theme
        && !crate::api::types::VOICE_ROOM_THEME_OPTIONS
            .iter()
            .any(|(id, _)| *id == theme)
    {
        return Err("Choose a valid default room theme".to_owned());
    }
    Ok(InstanceConfigUpdateRequest {
        voice_room: Some(VoiceRoomConfigUpdateRequest {
            rooms_enabled: Some(rooms_enabled),
            // Table games and room cameras only run inside 3D rooms, so switching rooms off
            // switches them off.
            games_enabled: Some(rooms_enabled && form.bool_value("voice_room_games_enabled")),
            room_cameras_enabled: Some(
                rooms_enabled && form.bool_value("voice_room_room_cameras_enabled"),
            ),
            default_room_theme,
        }),
        ..Default::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gateway_rollout_form_includes_connection_cap() {
        let form = MultiValueForm::parse(b"gateway_rollout_max_connections=18000");
        let update = build_gateway_rollout_update(&form).unwrap();
        let json = serde_json::to_value(update).unwrap();
        assert_eq!(json["gateway_rollout"]["max_connections"], 18000);
    }

    #[test]
    fn gateway_rollout_connection_cap_accepts_env_and_bounds() {
        for value in [0, 1, 200000] {
            let form = MultiValueForm::parse(
                format!("gateway_rollout_max_connections={value}").as_bytes(),
            );
            let update = build_gateway_rollout_update(&form).unwrap();
            let json = serde_json::to_value(update).unwrap();
            assert_eq!(json["gateway_rollout"]["max_connections"], value);
        }
    }

    #[test]
    fn gateway_rollout_connection_cap_rejects_invalid_values() {
        for value in ["-1", "200001", "1.5", "invalid", "", "18446744073709551616"] {
            let form = MultiValueForm::parse(
                format!("gateway_rollout_max_connections={value}").as_bytes(),
            );
            assert!(build_gateway_rollout_update(&form).is_err(), "{value:?}");
        }
    }

    #[test]
    fn gateway_rollout_connection_cap_omits_missing_field() {
        let form = MultiValueForm::parse(b"gateway_rollout_rpc_request_timeout_ms=15000");
        let json = serde_json::to_value(build_gateway_rollout_update(&form).unwrap()).unwrap();
        assert!(json["gateway_rollout"].get("max_connections").is_none());
        assert_eq!(json["gateway_rollout"]["rpc_request_timeout_ms"], 15000);
    }

    #[test]
    fn voice_room_form_sends_default_theme_null_to_clear_and_omits_missing_field() {
        for (body, expected) in [
            (
                b"voice_room_default_room_theme=kahvehane".as_slice(),
                serde_json::json!("kahvehane"),
            ),
            (
                b"voice_room_default_room_theme=".as_slice(),
                serde_json::Value::Null,
            ),
        ] {
            let update =
                build_voice_room_update(&MultiValueForm::parse(body)).expect("valid theme");
            let json = serde_json::to_value(update).expect("serializable voice room form update");
            assert!(
                json["voice_room"]
                    .as_object()
                    .unwrap()
                    .contains_key("default_room_theme")
            );
            assert_eq!(json["voice_room"]["default_room_theme"], expected);
        }
        let update =
            build_voice_room_update(&MultiValueForm::parse(b"voice_room_rooms_enabled=true"))
                .unwrap();
        let json = serde_json::to_value(update).unwrap();
        assert!(
            !json["voice_room"]
                .as_object()
                .unwrap()
                .contains_key("default_room_theme")
        );
    }
}

#[cfg(test)]
mod voice_noise_compatibility_tests {
    use super::*;
    #[test]
    fn build_voice_noise_suppression_update_collects_backends_and_validates_numbers() {
        let form = MultiValueForm::parse(
            b"voice_ns_enabled=true&voice_ns_allow_user_override=on&voice_ns_default_backend=rnnoise&voice_ns_enabled_backends%5B%5D=deep_filter&voice_ns_enabled_backends%5B%5D=none&voice_ns_enabled_backends%5B%5D=none&voice_ns_rollout_basis_points=10000&voice_ns_suppression_strength=100&voice_ns_rollout_salt=%20voice-ns-v2%20",
        );
        let request = build_voice_noise_suppression_update(&form).expect("valid form");
        let update = request
            .voice_noise_suppression
            .expect("voice noise suppression update");
        assert_eq!(update.enabled, Some(true));
        assert_eq!(update.allow_user_override, Some(true));
        assert_eq!(
            update.default_backend,
            Some(NoiseSuppressionBackend::Rnnoise)
        );
        assert_eq!(
            update.enabled_backends,
            Some(vec![
                NoiseSuppressionBackend::None,
                NoiseSuppressionBackend::DeepFilter
            ])
        );
        assert_eq!(update.rollout_basis_points, Some(10_000));
        assert_eq!(update.suppression_strength, Some(100));
        assert_eq!(update.rollout_salt, Some("voice-ns-v2".to_owned()));
    }

    #[test]
    fn build_voice_noise_suppression_update_leaves_the_feature_inert_when_nothing_is_submitted() {
        let form = MultiValueForm::parse(b"_csrf=token");
        let request = build_voice_noise_suppression_update(&form).expect("valid form");
        assert_eq!(
            serde_json::to_value(request).expect("serializable update"),
            serde_json::json!({"voice_noise_suppression": {
                "enabled": false,
                "pipeline_v2_enabled": false,
                "pipeline_v2_all": false,
                "allow_user_override": false,
                "enabled_backends": [],
                "included_user_ids": [],
                "excluded_user_ids": [],
                "guild_overrides": [],
            }})
        );
    }
    #[test]
    fn build_voice_noise_suppression_update_reads_user_id_textareas() {
        let form = MultiValueForm::parse(
            b"voice_ns_included_user_ids=1500000000000000001%0A1500000000000000002&voice_ns_excluded_user_ids=1500000000000000003%2C%201500000000000000004",
        );
        let update = build_voice_noise_suppression_update(&form)
            .expect("valid form")
            .voice_noise_suppression
            .expect("voice noise suppression update");
        assert_eq!(
            update.included_user_ids,
            Some(vec![
                "1500000000000000001".to_owned(),
                "1500000000000000002".to_owned()
            ])
        );
        assert_eq!(
            update.excluded_user_ids,
            Some(vec![
                "1500000000000000003".to_owned(),
                "1500000000000000004".to_owned()
            ])
        );
    }

    #[test]
    fn parse_voice_noise_suppression_guild_overrides_rejects_malformed_lines() {
        for (line, message) in [
            ("456", "Guild overrides line 3 must use guild_id=backend"),
            (
                "=gate",
                "Guild overrides line 3 must use a guild ID with 1 to 20 decimal digits",
            ),
            (
                "not-a-guild=gate",
                "Guild overrides line 3 must use a guild ID with 1 to 20 decimal digits",
            ),
            (
                "999999999999999999999=gate",
                "Guild overrides line 3 must use a guild ID with 1 to 20 decimal digits",
            ),
            (
                "456=unknown_backend",
                "Guild overrides line 3 must name a supported backend",
            ),
            (
                "456=",
                "Guild overrides line 3 must name a supported backend",
            ),
            (
                "123=gate",
                "Guild overrides line 3 conflicts with an earlier rule for guild 123",
            ),
        ] {
            assert_eq!(
                parse_voice_noise_suppression_guild_overrides(&format!("\n123=rnnoise\n{line}"))
                    .expect_err("invalid guild rule"),
                message,
                "{line}"
            );
        }
    }

    #[test]
    fn build_voice_noise_suppression_update_rejects_invalid_numbers() {
        for (key, message, above_max) in [
            (
                "voice_ns_rollout_basis_points",
                "Rollout basis points must be a whole number between 0 and 10000",
                "10001",
            ),
            (
                "voice_ns_suppression_strength",
                "Suppression strength must be a whole number between 0 and 100",
                "101",
            ),
        ] {
            for value in [
                "",
                "%20%20",
                "abc",
                "-1",
                "1.5",
                "9999999999999999999999999",
                above_max,
            ] {
                let form = MultiValueForm::parse(format!("{key}={value}").as_bytes());
                assert_eq!(
                    build_voice_noise_suppression_update(&form).expect_err("invalid number"),
                    message,
                    "{key}={value}"
                );
            }
        }
    }

    #[test]
    fn build_voice_noise_suppression_update_rejects_invalid_pipeline_v2_tuning() {
        for (key, message, below_min, above_max) in [
            (
                "voice_ns_pipeline_v2_gate_open_probability",
                "Gate open probability must be a number between 0.3 and 0.95",
                "0.29",
                "0.96",
            ),
            (
                "voice_ns_pipeline_v2_gate_refresh_probability",
                "Gate refresh probability must be a number between 0.1 and 0.9",
                "0.09",
                "0.91",
            ),
            (
                "voice_ns_pipeline_v2_gate_hangover_ms",
                "Gate hangover must be a whole number between 100 and 1500",
                "99",
                "1501",
            ),
            (
                "voice_ns_pipeline_v2_gain_target_dbfs",
                "Gain target must be a whole number between -40 and -14",
                "-41",
                "-13",
            ),
            (
                "voice_ns_pipeline_v2_gain_max_db",
                "Maximum gain must be a whole number between 0 and 30",
                "-1",
                "31",
            ),
        ] {
            for value in [
                "",
                "%20%20",
                "abc",
                "NaN",
                "inf",
                "12.5",
                "9999999999999999999999999",
                below_min,
                above_max,
            ] {
                let form = MultiValueForm::parse(format!("{key}={value}").as_bytes());
                assert_eq!(
                    build_voice_noise_suppression_update(&form).expect_err("invalid tuning"),
                    message,
                    "{key}={value}"
                );
            }
        }
    }

    #[test]
    fn build_voice_noise_suppression_update_reads_pipeline_v2_tuning_at_the_bounds() {
        let form = MultiValueForm::parse(
            b"voice_ns_pipeline_v2_gate_open_probability=%200.95%20&voice_ns_pipeline_v2_gate_refresh_probability=0.1&voice_ns_pipeline_v2_gate_hangover_ms=100&voice_ns_pipeline_v2_gain_target_dbfs=-14&voice_ns_pipeline_v2_gain_max_db=30",
        );
        let update = build_voice_noise_suppression_update(&form)
            .expect("valid form")
            .voice_noise_suppression
            .expect("voice noise suppression update");
        assert_eq!(update.pipeline_v2_gate_open_probability, Some(0.95));
        assert_eq!(update.pipeline_v2_gate_refresh_probability, Some(0.1));
        assert_eq!(update.pipeline_v2_gate_hangover_ms, Some(100));
        assert_eq!(update.pipeline_v2_gain_target_dbfs, Some(-14));
        assert_eq!(update.pipeline_v2_gain_max_db, Some(30));
    }
    #[test]
    fn build_voice_noise_suppression_update_accepts_padded_numbers() {
        let form = MultiValueForm::parse(b"voice_ns_rollout_basis_points=%20250%20");
        let update = build_voice_noise_suppression_update(&form)
            .expect("valid form")
            .voice_noise_suppression
            .expect("voice noise suppression update");
        assert_eq!(update.rollout_basis_points, Some(250));
    }

    #[test]
    fn build_voice_noise_suppression_update_rejects_invalid_rollout_salts() {
        for salt in [
            String::new(),
            "   ".to_owned(),
            "é".repeat(65),
            "🎲".repeat(33),
        ] {
            let form = MultiValueForm::parse(format!("voice_ns_rollout_salt={salt}").as_bytes());
            assert_eq!(
                build_voice_noise_suppression_update(&form).expect_err("invalid salt"),
                "Rollout salt must be between 1 and 64 characters"
            );
        }
    }

    #[test]
    fn build_voice_noise_suppression_update_preserves_valid_rollout_salts() {
        for salt in ["x".to_owned(), "é".repeat(64), "🎲".repeat(32)] {
            let form =
                MultiValueForm::parse(format!("voice_ns_rollout_salt=%20{salt}%20").as_bytes());
            let update = build_voice_noise_suppression_update(&form)
                .expect("valid form")
                .voice_noise_suppression
                .expect("voice noise suppression update");
            assert_eq!(update.rollout_salt, Some(salt));
        }
    }

    #[test]
    fn parse_voice_noise_suppression_guild_overrides_normalizes_identical_rules() {
        let overrides = parse_voice_noise_suppression_guild_overrides(
            " 1600000000000000001 = rnnoise \n\n1600000000000000001=rnnoise\n1600000000000000002=speex\n",
        ).expect("valid guild rules");
        assert_eq!(
            overrides,
            vec![
                VoiceNoiseSuppressionGuildOverride {
                    guild_id: "1600000000000000001".to_owned(),
                    backend: NoiseSuppressionBackend::Rnnoise,
                    pipeline_v2: false,
                },
                VoiceNoiseSuppressionGuildOverride {
                    guild_id: "1600000000000000002".to_owned(),
                    backend: NoiseSuppressionBackend::Speex,
                    pipeline_v2: false,
                },
            ]
        );
    }
    #[test]
    fn parse_voice_noise_suppression_guild_overrides_rejects_exceeding_the_cap() {
        let value = (0..VOICE_NS_MAX_GUILD_OVERRIDES)
            .map(|index| format!("{index}=gate"))
            .collect::<Vec<_>>()
            .join("\n");
        let overrides =
            parse_voice_noise_suppression_guild_overrides(&format!("{value}\n199=gate"))
                .expect("valid guild rules at cap");
        assert_eq!(overrides.len(), VOICE_NS_MAX_GUILD_OVERRIDES);
        assert_eq!(
            overrides.last().map(|entry| entry.guild_id.as_str()),
            Some("199")
        );
        assert_eq!(
            parse_voice_noise_suppression_guild_overrides(&format!("{value}\n200=gate"))
                .expect_err("too many guild rules"),
            "Guild overrides must contain at most 200 unique guilds"
        );
    }

    #[test]
    fn build_voice_noise_suppression_update_reports_invalid_targeting_fields() {
        for (form, message) in [
            (
                "voice_ns_default_backend=unknown",
                "Default backend must name a supported noise suppression backend",
            ),
            (
                "voice_ns_default_backend=",
                "Default backend must name a supported noise suppression backend",
            ),
            (
                "voice_ns_enabled_backends%5B%5D=rnnoise&voice_ns_enabled_backends%5B%5D=unknown",
                "Enabled backends must name supported noise suppression backends",
            ),
            (
                "voice_ns_included_user_ids=123%2Cinvalid",
                "Included user IDs entry 2 must contain 1 to 20 decimal digits",
            ),
            (
                "voice_ns_excluded_user_ids=123%2Cinvalid",
                "Excluded user IDs entry 2 must contain 1 to 20 decimal digits",
            ),
            (
                "voice_ns_guild_overrides=123%3Dgate%0A123%3Drnnoise",
                "Guild overrides line 2 conflicts with an earlier rule for guild 123",
            ),
        ] {
            let form = MultiValueForm::parse(form.as_bytes());
            assert_eq!(
                build_voice_noise_suppression_update(&form).expect_err("invalid targeting"),
                message
            );
        }
    }
}
