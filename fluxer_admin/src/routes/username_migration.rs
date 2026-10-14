// SPDX-License-Identifier: AGPL-3.0-or-later

use super::{ActionQuery, acl_forbidden, api_failure};
use crate::{
    acl,
    api::client::{AdminApiClient, ApiResultExt},
    middleware::{
        auth::AuthContext,
        csrf::CsrfToken,
        flash::{self, FlashData},
    },
    state::AppState,
    templates::pages::username_migration,
    utils::forms::MultiValueForm,
};
use axum::{
    Router,
    extract::{Query, Request, State},
    response::{Html, IntoResponse, Response},
    routing::get,
};
use reqwest::Method;
use serde::Deserialize;
use serde_json::{Value, json};
use time::{Duration, OffsetDateTime, format_description::well_known::Rfc3339};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
pub const START_CONFIRMATION: &str = "START USERNAME MIGRATION";
pub const MISSING_READINESS: &str =
    "Start unavailable: validation scan results and required reservations could not be verified.";

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TierMode {
    Locked,
    ForSale,
    Public,
}

impl TierMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Locked => "locked",
            Self::ForSale => "for_sale",
            Self::Public => "public",
        }
    }
}

#[derive(Deserialize)]
pub struct UsernameTiers {
    #[serde(rename = "1")]
    pub one: TierMode,
    #[serde(rename = "2")]
    pub two: TierMode,
    #[serde(rename = "3")]
    pub three: TierMode,
}

#[derive(Deserialize)]
pub struct Admission {
    pub global_per_second: u64,
    pub paused: bool,
}

#[derive(Deserialize)]
pub struct UsernamePolicy {
    pub revision: u64,
    pub tiers: UsernameTiers,
    pub dictionary_gen: u64,
    pub dictionary_hash: Option<String>,
    pub next_dictionary_gen: u64,
    pub admission: Admission,
    pub held_manifest: Option<Vec<String>>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum MigrationState {
    Legacy,
    Preparing,
    Selecting,
}

impl MigrationState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Legacy => "legacy",
            Self::Preparing => "preparing",
            Self::Selecting => "selecting",
        }
    }
}

#[derive(Deserialize)]
pub struct MigrationStatus {
    pub state: MigrationState,
    pub epoch: u64,
    pub preparing_at: Option<String>,
    pub started_at: Option<String>,
    pub forced_at: Option<String>,
}

impl MigrationStatus {
    fn valid(&self) -> bool {
        if self.epoch > MAX_SAFE_INTEGER {
            return false;
        }
        match self.state {
            MigrationState::Legacy => {
                self.preparing_at.is_none() && self.started_at.is_none() && self.forced_at.is_none()
            }
            MigrationState::Preparing => {
                self.epoch > 0
                    && self
                        .preparing_at
                        .as_deref()
                        .is_some_and(|date| OffsetDateTime::parse(date, &Rfc3339).is_ok())
                    && self.started_at.is_none()
                    && self.forced_at.is_none()
            }
            MigrationState::Selecting => {
                let parse = |date: Option<&str>| {
                    date.and_then(|date| OffsetDateTime::parse(date, &Rfc3339).ok())
                };
                match (
                    parse(self.preparing_at.as_deref()),
                    parse(self.started_at.as_deref()),
                    parse(self.forced_at.as_deref()),
                ) {
                    (Some(prepared), Some(started), Some(forced)) => {
                        self.epoch > 0
                            && started - prepared >= Duration::seconds(60)
                            && forced - started == Duration::days(7)
                    }
                    _ => false,
                }
            }
        }
    }
}

#[derive(Deserialize)]
pub struct MigrationScan {
    pub epoch: u64,
    pub scanned: u64,
    pub found: u64,
    pub done_at: Option<String>,
}

#[derive(Deserialize)]
pub struct HoldsProof {
    pub policy_revision: u64,
    pub checked_at: String,
    pub held: u64,
    pub assigned: u64,
    pub missing: Vec<String>,
}

#[derive(Deserialize)]
pub struct MigrationHolds {
    pub required: Option<u64>,
    pub ready: bool,
    pub proof: Option<HoldsProof>,
}

#[derive(Deserialize)]
pub struct GuildCapacity {
    pub max_guild_members: u64,
    pub max_guild_online: u64,
    pub source: String,
    pub observed_at: String,
    pub epoch: u64,
    pub admin_id: String,
}

#[derive(Deserialize)]
pub struct CapacityProof {
    pub epoch: u64,
    pub policy_revision: u64,
    pub total_accounts: Option<u64>,
    pub guild_capacity: Option<GuildCapacity>,
    pub holds: Option<HoldsProof>,
}

#[derive(Deserialize)]
pub struct MigrationCapacity {
    pub available: bool,
    pub ready: bool,
    pub proof: Option<CapacityProof>,
}

#[derive(Deserialize)]
pub struct MigrationInspection {
    pub migration: MigrationStatus,
    pub scan: Option<MigrationScan>,
    pub holds: MigrationHolds,
    pub capacity: MigrationCapacity,
}

#[derive(Deserialize)]
struct Discovery {
    username_migration: Option<MigrationStatus>,
}

impl MigrationInspection {
    pub fn start_ready(&self) -> bool {
        self.migration.state == MigrationState::Preparing
            && self.scan.as_ref().is_some_and(|scan| {
                scan.epoch == self.migration.epoch
                    && scan.found == 0
                    && scan
                        .done_at
                        .as_deref()
                        .is_some_and(|date| OffsetDateTime::parse(date, &Rfc3339).is_ok())
            })
            && self.holds.ready
            && self.holds.proof.is_some()
            && self
                .capacity
                .proof
                .as_ref()
                .is_some_and(|proof| proof.epoch == self.migration.epoch)
    }
}

pub fn router() -> Router<AppState> {
    Router::new().route("/username-migration", get(page).post(post))
}

fn permitted(auth: &AuthContext, permission: &str) -> bool {
    acl::has_permission(
        auth.admin_user
            .as_ref()
            .map(|user| user.acls.as_slice())
            .unwrap_or(&[]),
        permission,
    )
}

async fn read_migration(client: &AdminApiClient) -> Option<MigrationInspection> {
    client
        .get::<MigrationInspection>("/admin/instance/username-migration", None)
        .await
        .log_error("load username migration state")
        .filter(|inspection| inspection.migration.valid())
}

async fn page(
    State(state): State<AppState>,
    auth: axum::Extension<AuthContext>,
    csrf: axum::Extension<CsrfToken>,
    flash: Option<axum::Extension<FlashData>>,
) -> Response {
    let config = state.config();
    let can_view_policy = permitted(&auth.0, acl::INSTANCE_CONFIG_VIEW);
    let can_migrate = permitted(&auth.0, acl::USERNAME_MIGRATION_START);
    if !can_view_policy
        && !can_migrate
        && let Some(response) = acl_forbidden(config, &auth.0, acl::INSTANCE_CONFIG_VIEW)
    {
        return response;
    }
    let client = AdminApiClient::new(state.http_client(), config, &auth.0.session);
    let (policy, inspection) = tokio::join!(
        async {
            if can_view_policy {
                client
                    .get::<UsernamePolicy>("/admin/instance/username-policy", None)
                    .await
                    .log_error("load username policy")
                    .filter(|policy| policy.admission.global_per_second <= MAX_SAFE_INTEGER)
            } else {
                None
            }
        },
        async {
            if can_migrate {
                read_migration(&client).await
            } else {
                None
            }
        }
    );
    let public_migration = if !can_migrate {
        client
            .get::<Discovery>("/.well-known/fluxer", None)
            .await
            .log_error("load public migration state")
            .and_then(|discovery| discovery.username_migration)
            .filter(MigrationStatus::valid)
    } else {
        None
    };
    let migration = inspection
        .as_ref()
        .map(|inspection| &inspection.migration)
        .or(public_migration.as_ref());
    let flash = flash.map(|flash| flash.0.to_flash_message());
    Html(
        username_migration::page(
            config,
            &auth.0,
            &csrf.0.0,
            flash.as_ref(),
            policy.as_ref(),
            migration,
            inspection.as_ref(),
        )
        .into_string(),
    )
    .into_response()
}

async fn post(
    State(state): State<AppState>,
    auth: axum::Extension<AuthContext>,
    Query(query): Query<ActionQuery>,
    request: Request,
) -> Response {
    let config = state.config();
    let action = query.action.as_deref().unwrap_or("");
    let permission = if action == "policy" {
        acl::INSTANCE_CONFIG_UPDATE
    } else {
        acl::USERNAME_MIGRATION_START
    };
    if let Some(response) = acl_forbidden(config, &auth.0, permission) {
        return response;
    }
    let client = AdminApiClient::new(state.http_client(), config, &auth.0.session);
    let result = match MultiValueForm::from_request(request).await {
        Some(form) => apply_action(&client, action, &form).await,
        None => FlashData::error("Invalid form data"),
    };
    flash::redirect_with_flash(
        &format!("{}/username-migration", config.base_path),
        result,
        config.secure_cookies(),
    )
}

fn policy_body(form: &MultiValueForm) -> Result<Value, &'static str> {
    let mode = |key: &str| {
        form.first(key)
            .filter(|value| matches!(*value, "locked" | "for_sale" | "public"))
    };
    let (Some(one), Some(two), Some(three)) = (mode("tier_1"), mode("tier_2"), mode("tier_3"))
    else {
        return Err("Choose a valid mode for all three tiers.");
    };
    let Some(budget) = form
        .parse_u64("global_per_second")
        .filter(|value| *value <= MAX_SAFE_INTEGER)
    else {
        return Err("Admission budget must be a non-negative safe integer.");
    };
    let open_all = form.bool_value("open_all");
    let mut body = json!({
        "tiers": {
            "1": if open_all { "public" } else { one },
            "2": if open_all { "public" } else { two },
            "3": if open_all { "public" } else { three },
        },
        "admission": {"global_per_second":budget, "paused":form.bool_value("paused")},
    });
    if form.bool_value("update_held_manifest") {
        let entries: Vec<String> = form
            .first("held_manifest")
            .unwrap_or("")
            .split_whitespace()
            .map(str::to_ascii_lowercase)
            .collect();
        let unique: std::collections::BTreeSet<&str> = entries.iter().map(String::as_str).collect();
        if entries.len() > 1000
            || unique.len() != entries.len()
            || entries.iter().any(|name| {
                !(1..=32).contains(&name.len())
                    || !name
                        .bytes()
                        .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == b'_')
            })
        {
            return Err(
                "Manifest requires at most 1,000 unique usernames, each 1–32 letters, digits, or underscores.",
            );
        }
        body["held_manifest"] = json!(entries);
    }
    Ok(body)
}

async fn apply_action(client: &AdminApiClient, action: &str, form: &MultiValueForm) -> FlashData {
    let Some(reason) = form.clean("reason") else {
        return FlashData::error("An audit reason is required.");
    };
    if reason.encode_utf16().count() > 512 || reason.chars().any(char::is_control) {
        return FlashData::error(
            "The audit reason takes at most 512 characters and must not contain control characters.",
        );
    }
    if action == "policy" {
        let body = match policy_body(form) {
            Ok(body) => body,
            Err(message) => return FlashData::error(message),
        };
        return match client
            .send::<UsernamePolicy, _>(
                Method::PATCH,
                "/admin/instance/username-policy",
                Some(&body),
                Some(&reason),
            )
            .await
        {
            Ok(_) => FlashData::success(if form.bool_value("update_held_manifest") {
                "Username tiers, admission, and required reservation manifest saved together."
            } else {
                "Username tiers and admission saved together."
            }),
            Err(error) => api_failure("save username policy", &error),
        };
    }
    if !matches!(action, "prepare" | "start" | "rollback") {
        return FlashData::error("Unknown migration action.");
    }
    let Some(inspection) = read_migration(client).await else {
        return FlashData::error("Migration state unavailable. No migration action was sent.");
    };
    let migration = &inspection.migration;
    let body = if action == "prepare" {
        if migration.state != MigrationState::Legacy {
            return FlashData::error("Only legacy migration can be prepared.");
        }
        if !form.bool_value("processes_ready") {
            return FlashData::error(
                "Confirm all API and worker processes run the migration version.",
            );
        }
        json!({"processes_ready":true})
    } else {
        let epoch = form
            .parse_u64("epoch")
            .filter(|epoch| *epoch > 0 && *epoch <= MAX_SAFE_INTEGER);
        if migration.state != MigrationState::Preparing || epoch != Some(migration.epoch) {
            return FlashData::error(
                "This action requires the current migration epoch and a valid state. Refresh the page.",
            );
        }
        if action == "start" {
            if !form.bool_value("mobile_published")
                || form
                    .clean("mobile_version")
                    .is_none_or(|version| version.encode_utf16().count() > 100)
            {
                return FlashData::error(
                    "Confirm the mobile version is published in both Play and App Store and enter its version.",
                );
            }
            if form.first("confirmation") != Some(START_CONFIRMATION) {
                return FlashData::error("Type START USERNAME MIGRATION to confirm.");
            }
            if !inspection.start_ready() {
                return FlashData::error(MISSING_READINESS);
            }
            let count = |name| {
                form.parse_u64(name)
                    .filter(|value| *value <= MAX_SAFE_INTEGER)
            };
            let (Some(members), Some(online), Some(source), Some(observed_at)) = (
                count("max_guild_members"),
                count("max_guild_online"),
                form.clean("source"),
                form.clean("observed_at"),
            ) else {
                return FlashData::error(
                    "Enter the largest guild member and online counts, their source, and observation time.",
                );
            };
            if source.encode_utf16().count() > 1000 || source.chars().any(char::is_control) {
                return FlashData::error(
                    "Capacity source must take at most 1,000 characters without control characters.",
                );
            }
            let observed = OffsetDateTime::parse(&observed_at, &Rfc3339).ok();
            if !observed_at.ends_with('Z')
                || observed.is_none_or(|at| {
                    let age = OffsetDateTime::now_utc() - at;
                    age < Duration::ZERO || age >= Duration::hours(1)
                })
            {
                return FlashData::error(
                    "Capacity observation must be a UTC timestamp within the last 60 minutes.",
                );
            }
            json!({"epoch":migration.epoch, "mobile_published":true, "mobile_version":form.clean("mobile_version"),
                "guild_capacity":{"max_guild_members":members,"max_guild_online":online,"source":source,"observed_at":observed_at}})
        } else {
            json!({"epoch":migration.epoch})
        }
    };
    let path = format!("/admin/instance/username-migration/{action}");
    match client
        .send::<MigrationStatus, _>(Method::POST, &path, Some(&body), Some(&reason))
        .await
    {
        Ok(status)
            if status.valid()
                && (if action == "prepare" {
                    status.state == MigrationState::Preparing && status.epoch == migration.epoch + 1
                } else if action == "start" {
                    status.state == MigrationState::Selecting && status.epoch == migration.epoch
                } else {
                    status.state == MigrationState::Legacy && status.epoch == migration.epoch
                }) =>
        {
            FlashData::success(if action == "prepare" {
                "Migration preparation started. Refresh to read its state."
            } else if action == "start" {
                "Username selection started. Refresh to read the server deadlines."
            } else {
                "Migration preparation rolled back."
            })
        }
        Ok(_) => FlashData::error(
            "The migration response was invalid. Refresh to check server state before retrying.",
        ),
        Err(error) => api_failure("change username migration", &error),
    }
}
