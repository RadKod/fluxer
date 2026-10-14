// SPDX-License-Identifier: AGPL-3.0-or-later

use axum::{
    Json, Router,
    body::{Body, to_bytes},
    extract::State,
    http::{HeaderMap, Method, Request, StatusCode, Uri, header},
    response::{IntoResponse, Response},
};
use fluxer_admin::{
    build_router,
    config::{AdminConfig, ProxyConfig, RuntimeEnv},
    middleware::flash::parse_flash,
    session,
};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::net::TcpListener;
use tower::ServiceExt;

const SECRET: &str = "username-migration-test-secret";
const PAGE: &str = "/username-migration";

struct MockApi {
    acls: Vec<String>,
    migration: Option<Value>,
    policy_available: bool,
    held_manifest: Option<Value>,
    fail_writes: bool,
    failure_status: StatusCode,
    write_response: Option<Value>,
    inspection: Option<Value>,
    reads: Vec<String>,
    writes: Vec<(String, Value, Option<String>)>,
}

type Shared = Arc<Mutex<MockApi>>;

struct TestApp {
    router: Router,
    cookie: String,
    api: Shared,
}

async fn setup(acls: &[&str], migration: Option<Value>) -> TestApp {
    let api = Arc::new(Mutex::new(MockApi {
        acls: acls.iter().map(|acl| (*acl).to_owned()).collect(),
        migration,
        policy_available: true,
        held_manifest: Some(Value::Null),
        fail_writes: false,
        failure_status: StatusCode::SERVICE_UNAVAILABLE,
        write_response: None,
        inspection: None,
        reads: Vec::new(),
        writes: Vec::new(),
    }));
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let addr = listener.local_addr().unwrap();
    let mock = Router::new().fallback(mock_api).with_state(api.clone());
    tokio::spawn(async move { axum::serve(listener, mock).await.unwrap() });
    let router = build_router(config(format!("http://{addr}")));
    let value = session::create_session("1500000000000000000", "token", SECRET);
    TestApp {
        router,
        cookie: format!("{}={value}", session::SESSION_COOKIE_NAME),
        api,
    }
}

async fn send(app: &TestApp, request: Request<Body>) -> (StatusCode, HeaderMap, String) {
    let response = app.router.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, headers, String::from_utf8(bytes.to_vec()).unwrap())
}

async fn page(app: &TestApp) -> (StatusCode, HeaderMap, String) {
    send(
        app,
        Request::builder()
            .uri(PAGE)
            .header(header::COOKIE, &app.cookie)
            .body(Body::empty())
            .unwrap(),
    )
    .await
}

async fn post(
    app: &TestApp,
    action: &str,
    form: &str,
    csrf: bool,
) -> (StatusCode, HeaderMap, String) {
    let (_, _, _) = page(app).await;
    let token = session::create_csrf_token("1500000000000000000", SECRET);
    let form = if csrf {
        format!("_csrf={token}&{form}")
    } else {
        form.to_owned()
    };
    send(
        app,
        Request::builder()
            .method(Method::POST)
            .uri(format!("{PAGE}?action={action}"))
            .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
            .header(
                header::COOKIE,
                format!("{}; __Host-csrf_token={token}", app.cookie),
            )
            .body(Body::from(form))
            .unwrap(),
    )
    .await
}

fn flash_type(headers: &HeaderMap) -> String {
    headers
        .get_all(header::SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .find_map(|value| parse_flash(value.split(';').next()?.strip_prefix("flash=")?))
        .expect("flash cookie")
        .flash_type
}

#[tokio::test]
async fn policy_save_is_one_patch_with_all_tiers_and_admission_and_audit_reason() {
    let app = setup(&["*"], Some(migration("legacy", 0))).await;
    let (status, headers, _) = post(&app, "policy",
        "tier_1=locked&tier_2=for_sale&tier_3=public&global_per_second=139&paused=true&reason=Capacity%20review", true).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    assert_eq!(flash_type(&headers), "success");
    assert_eq!(
        app.api.lock().unwrap().writes,
        vec![(
            "PATCH /admin/instance/username-policy".to_owned(),
            json!({"tiers":{"1":"locked","2":"for_sale","3":"public"},
            "admission":{"global_per_second":139,"paused":true}}),
            Some("Capacity review".to_owned()),
        )]
    );
}

#[tokio::test]
async fn audit_reason_preserves_turkish_utf8_bytes() {
    let app = setup(&["*"], Some(migration("legacy", 0))).await;
    let reason = "Göç hazırlığı";
    post(
        &app,
        "prepare",
        &format!(
            "processes_ready=true&reason={}",
            urlencoding::encode(reason)
        ),
        true,
    )
    .await;
    assert_eq!(app.api.lock().unwrap().writes[0].2.as_deref(), Some(reason));
}

#[tokio::test]
async fn open_all_tiers_is_one_atomic_patch() {
    let app = setup(&["*"], Some(migration("legacy", 0))).await;
    post(
        &app,
        "policy",
        "open_all=true&tier_1=locked&tier_2=locked&tier_3=locked&global_per_second=0&reason=Open",
        true,
    )
    .await;
    let api = app.api.lock().unwrap();
    assert_eq!(api.writes.len(), 1);
    assert_eq!(
        api.writes[0].1["tiers"],
        json!({"1":"public","2":"public","3":"public"})
    );
    assert_eq!(api.writes[0].1["admission"]["paused"], false);
}

#[tokio::test]
async fn invalid_policy_and_missing_reason_never_reach_the_api() {
    let app = setup(&["*"], Some(migration("legacy", 0))).await;
    for form in [
        "tier_1=locked&tier_2=locked&global_per_second=10&reason=Change",
        "tier_1=locked&tier_2=bad&tier_3=public&global_per_second=10&reason=Change",
        "tier_1=locked&tier_2=locked&tier_3=locked&global_per_second=-1&reason=Change",
        "tier_1=locked&tier_2=locked&tier_3=locked&global_per_second=9007199254740992&reason=Change",
        "tier_1=locked&tier_2=locked&tier_3=locked&global_per_second=10&reason=%20",
        "tier_1=locked&tier_2=locked&tier_3=locked&global_per_second=10&reason=First%0ASecond",
    ] {
        let (_, headers, _) = post(&app, "policy", form, true).await;
        assert_eq!(flash_type(&headers), "error", "{form}");
    }
    assert!(app.api.lock().unwrap().writes.is_empty());
}

#[tokio::test]
async fn long_and_control_character_reasons_are_rejected_for_every_action() {
    let app = setup(&["*"], Some(migration("preparing", 4))).await;
    for action in ["policy", "prepare", "start", "rollback"] {
        for reason in ["a".repeat(513), "a\tb".to_owned()] {
            let (_, headers, _) = post(
                &app,
                action,
                &format!("epoch=4&reason={}", urlencoding::encode(&reason)),
                true,
            )
            .await;
            assert_eq!(flash_type(&headers), "error");
        }
    }
    assert!(app.api.lock().unwrap().writes.is_empty());
}

#[tokio::test]
async fn prepare_requires_manual_process_confirmation_and_sends_only_the_api_contract() {
    let app = setup(&["username:migration:start"], Some(migration("legacy", 3))).await;
    let (_, headers, _) = post(&app, "prepare", "reason=Prepare", true).await;
    assert_eq!(flash_type(&headers), "error");
    assert!(app.api.lock().unwrap().writes.is_empty());
    let (status, headers, _) =
        post(&app, "prepare", "processes_ready=true&reason=Prepare", true).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    assert_eq!(flash_type(&headers), "success");
    assert_eq!(
        app.api.lock().unwrap().writes[0].0,
        "POST /admin/instance/username-migration/prepare"
    );
    assert_eq!(
        app.api.lock().unwrap().writes[0].1,
        json!({"processes_ready":true})
    );
}

#[tokio::test]
async fn preparing_exposes_epoch_and_only_preparing_has_rollback() {
    for state in ["legacy", "preparing", "selecting"] {
        let app = setup(&["*"], Some(migration(state, 4))).await;
        let (_, _, html) = page(&app).await;
        assert_eq!(
            html.contains("action=rollback"),
            state == "preparing",
            "{html}"
        );
        assert_eq!(html.contains("action=prepare"), state == "legacy", "{html}");
        if state == "preparing" {
            assert!(html.contains("name=\"epoch\" value=\"4\""), "{html}");
        }
    }
}

#[tokio::test]
async fn rollback_requires_preparing_and_current_epoch() {
    let app = setup(&["*"], Some(migration("preparing", 4))).await;
    post(&app, "rollback", "epoch=3&reason=Rollback", true).await;
    assert!(app.api.lock().unwrap().writes.is_empty());
    let (_, headers, _) = post(&app, "rollback", "epoch=4&reason=Rollback", true).await;
    assert_eq!(flash_type(&headers), "success");
    assert_eq!(app.api.lock().unwrap().writes[0].1, json!({"epoch":4}));
    let app = setup(&["*"], Some(migration("selecting", 4))).await;
    post(&app, "rollback", "epoch=4&reason=Rollback", true).await;
    assert!(app.api.lock().unwrap().writes.is_empty());
}

#[tokio::test]
async fn start_requires_mobile_confirmation_version_and_exact_typed_phrase() {
    let app = setup(&["*"], Some(migration("preparing", 4))).await;
    for (fields, expected) in [
        (
            "mobile_version=1.2.3&confirmation=START%20USERNAME%20MIGRATION",
            "mobile version",
        ),
        (
            "mobile_published=true&mobile_version=%20&confirmation=START%20USERNAME%20MIGRATION",
            "mobile version",
        ),
        (
            "mobile_published=true&mobile_version=1.2.3&confirmation=start",
            "Type START USERNAME MIGRATION",
        ),
        (
            "mobile_published=true&mobile_version=1.2.3&confirmation=START%20USERNAME%20MIGRATION",
            "Start unavailable",
        ),
    ] {
        let (_, headers, _) = post(
            &app,
            "start",
            &format!("epoch=4&reason=Start&{fields}"),
            true,
        )
        .await;
        let flash = headers
            .get_all(header::SET_COOKIE)
            .iter()
            .filter_map(|value| value.to_str().ok())
            .find_map(|value| parse_flash(value.split(';').next()?.strip_prefix("flash=")?))
            .unwrap();
        assert_eq!(flash.flash_type, "error");
        assert!(flash.message.contains(expected), "{}", flash.message);
    }
    assert!(app.api.lock().unwrap().writes.is_empty());
}

#[tokio::test]
async fn start_stays_disabled_and_forged_prerequisites_never_reach_the_api() {
    let app = setup(&["*"], Some(migration("preparing", 4))).await;
    let (_, _, html) = page(&app).await;
    let at = html.find("action=start").expect("start form");
    let form = &html[at..at + html[at..].find("</form>").unwrap()];
    assert!(form.contains("fieldset disabled"), "{form}");
    assert!(form.contains("mobile_published"), "{form}");
    assert!(form.contains("mobile_version"), "{form}");
    assert!(form.contains("confirmation"), "{form}");
    for text in [
        "Validation scan",
        "Held claims",
        "T6 capacity",
        "unavailable",
    ] {
        assert!(html.contains(text), "{text}: {html}");
    }
    let (_, headers, _) = post(&app, "start",
        "epoch=4&mobile_published=true&mobile_version=1.2.3&confirmation=START%20USERNAME%20MIGRATION&reason=Start&found=0&held_claims_ready=true&capacity_ready=true", true).await;
    assert_eq!(flash_type(&headers), "error");
    assert!(app.api.lock().unwrap().writes.is_empty());
}

#[tokio::test]
async fn inspection_get_displays_authoritative_scan_holds_and_declaration() {
    let app = setup(&["*"], Some(migration("preparing", 4))).await;
    app.api.lock().unwrap().inspection = Some(inspection());
    let (_, _, html) = page(&app).await;
    for text in ["1234", "Held: 2", "Assigned: 1", "capacity-report"] {
        assert!(html.contains(text), "{text}: {html}");
    }
    let at = html.find("action=start").unwrap();
    let form = &html[at..at + html[at..].find("</form>").unwrap()];
    assert!(!form.contains("fieldset disabled"), "{form}");
    assert!(form.contains("max_guild_members"));
    assert!(form.contains("observed_at"));
}

#[tokio::test]
async fn start_sends_only_mobile_and_guild_declaration_contract_after_reading_evidence() {
    let app = setup(&["*"], Some(migration("preparing", 4))).await;
    app.api.lock().unwrap().inspection = Some(inspection());
    let observed = OffsetDateTime::now_utc().format(&Rfc3339).unwrap();
    let fields = format!(
        "epoch=4&mobile_published=true&mobile_version=1.2.3&confirmation=START%20USERNAME%20MIGRATION&max_guild_members=100&max_guild_online=10&source=capacity-report&observed_at={}&reason=Start",
        urlencoding::encode(&observed)
    );
    let (_, headers, _) = post(&app, "start", &fields, true).await;
    assert_eq!(flash_type(&headers), "success");
    assert_eq!(
        app.api.lock().unwrap().writes[0].1,
        json!({"epoch":4,"mobile_published":true,"mobile_version":"1.2.3","guild_capacity":{"max_guild_members":100,"max_guild_online":10,"source":"capacity-report","observed_at":observed}})
    );
}

#[tokio::test]
async fn stale_epoch_conflicts_missing_holds_and_missing_capacity_cannot_start() {
    for (path, value) in [
        ("scan/epoch", json!(3)),
        ("scan/found", json!(1)),
        ("scan/done_at", Value::Null),
        ("holds/ready", json!(false)),
        ("capacity/proof", Value::Null),
    ] {
        let app = setup(&["*"], Some(migration("preparing", 4))).await;
        let mut evidence = inspection();
        *evidence.pointer_mut(&format!("/{path}")).unwrap() = value;
        app.api.lock().unwrap().inspection = Some(evidence);
        let (_, _, html) = page(&app).await;
        let at = html.find("action=start").unwrap();
        assert!(html[at..].contains("fieldset disabled"), "{path}: {html}");
        post(&app, "start", "epoch=4&mobile_published=true&mobile_version=1.2.3&confirmation=START%20USERNAME%20MIGRATION&reason=Start", true).await;
        assert!(app.api.lock().unwrap().writes.is_empty(), "{path}");
    }
}

#[tokio::test]
async fn guild_declaration_requires_safe_counts_source_and_fresh_utc_observation() {
    let app = setup(&["*"], Some(migration("preparing", 4))).await;
    app.api.lock().unwrap().inspection = Some(inspection());
    let now = OffsetDateTime::now_utc().format(&Rfc3339).unwrap();
    let stale = (OffsetDateTime::now_utc() - time::Duration::hours(2))
        .format(&Rfc3339)
        .unwrap();
    let future = (OffsetDateTime::now_utc() + time::Duration::hours(2))
        .format(&Rfc3339)
        .unwrap();
    for fields in [
        format!("max_guild_members=-1&max_guild_online=0&source=report&observed_at={now}"),
        format!(
            "max_guild_members=100&max_guild_online=9007199254740992&source=report&observed_at={now}"
        ),
        format!("max_guild_members=100&max_guild_online=10&source=%20&observed_at={now}"),
        format!("max_guild_members=100&max_guild_online=10&source=report&observed_at={stale}"),
        format!("max_guild_members=100&max_guild_online=10&source=report&observed_at={future}"),
    ] {
        let (_, headers, _) = post(&app, "start", &format!("epoch=4&mobile_published=true&mobile_version=1.2.3&confirmation=START%20USERNAME%20MIGRATION&reason=Start&{fields}"), true).await;
        assert_eq!(flash_type(&headers), "error");
    }
    assert!(app.api.lock().unwrap().writes.is_empty());
}

#[tokio::test]
async fn first_guild_declaration_can_be_submitted_before_capacity_is_declared() {
    let app = setup(&["*"], Some(migration("preparing", 4))).await;
    let mut evidence = inspection();
    evidence["capacity"]["available"] = json!(false);
    evidence["capacity"]["ready"] = json!(false);
    evidence["capacity"]["proof"]["guild_capacity"] = Value::Null;
    app.api.lock().unwrap().inspection = Some(evidence);
    let (_, _, html) = page(&app).await;
    let at = html.find("action=start").unwrap();
    let form = &html[at..at + html[at..].find("</form>").unwrap()];
    assert!(!form.contains("fieldset disabled"), "{form}");
}

#[tokio::test]
async fn incomplete_inspection_with_null_account_count_still_allows_preparing_rollback() {
    let app = setup(&["*"], Some(migration("preparing", 4))).await;
    let mut evidence = inspection();
    evidence["scan"] = Value::Null;
    evidence["capacity"]["proof"]["total_accounts"] = Value::Null;
    app.api.lock().unwrap().inspection = Some(evidence);
    let (_, headers, _) = post(&app, "rollback", "epoch=4&reason=Rollback", true).await;
    assert_eq!(flash_type(&headers), "success");
}

#[tokio::test]
async fn selecting_has_no_capacity_refresh_and_start_never_reaches_the_api() {
    let app = setup(&["*"], Some(migration("selecting", 4))).await;
    let mut evidence = inspection();
    evidence["migration"] = migration("selecting", 4);
    app.api.lock().unwrap().inspection = Some(evidence);
    let (_, _, html) = page(&app).await;
    assert!(!html.contains("action=start"), "{html}");
    assert!(!html.contains("Refresh capacity declaration"), "{html}");
    let observed = OffsetDateTime::now_utc().format(&Rfc3339).unwrap();
    let fields = format!(
        "epoch=4&mobile_published=true&mobile_version=1.2.3&confirmation=START%20USERNAME%20MIGRATION&max_guild_members=100&max_guild_online=10&source=renewed-report&observed_at={}&reason=Refresh",
        urlencoding::encode(&observed)
    );
    let (_, headers, _) = post(&app, "start", &fields, true).await;
    assert_eq!(flash_type(&headers), "error");
    assert!(app.api.lock().unwrap().writes.is_empty());
}

#[tokio::test]
async fn policy_manifest_is_explicit_bounded_canonical_and_saved_with_existing_policy() {
    let app = setup(&["*"], Some(migration("legacy", 0))).await;
    let fields = "tier_1=locked&tier_2=locked&tier_3=locked&global_per_second=10&reason=Manifest&update_held_manifest=true&held_manifest=MICUP%0Aadmin";
    post(&app, "policy", fields, true).await;
    assert_eq!(
        app.api.lock().unwrap().writes[0].1["held_manifest"],
        json!(["micup", "admin"])
    );
    let before = app.api.lock().unwrap().writes.len();
    for manifest in [
        "duplicate%0ADUPLICATE".to_owned(),
        "bad%21name".to_owned(),
        std::iter::repeat_n("admin", 1001)
            .collect::<Vec<_>>()
            .join("%0A"),
    ] {
        post(&app, "policy", &format!("tier_1=locked&tier_2=locked&tier_3=locked&global_per_second=10&reason=Manifest&update_held_manifest=true&held_manifest={manifest}"), true).await;
    }
    assert_eq!(app.api.lock().unwrap().writes.len(), before);
}

#[tokio::test]
async fn missing_manifest_shows_an_empty_unsaved_list_without_selecting_replacement() {
    for manifest in [None, Some(Value::Null)] {
        let app = setup(&["*"], Some(migration("legacy", 0))).await;
        app.api.lock().unwrap().held_manifest = manifest;
        let (_, _, html) = page(&app).await;
        let field = &html[html.find("<textarea id=\"held_manifest\"").unwrap()..];
        let value = &field[field.find('>').unwrap() + 1..field.find("</textarea>").unwrap()];
        assert!(value.is_empty(), "{value}");
        assert!(html.contains("No manifest is saved."));
        let at = html.find("name=\"update_held_manifest\"").unwrap();
        let input = &html[html[..at].rfind("<input").unwrap()..at + html[at..].find('>').unwrap()];
        assert!(!input.contains("checked"), "{input}");
        assert!(app.api.lock().unwrap().writes.is_empty());
    }
}

#[tokio::test]
async fn explicitly_saved_empty_manifest_stays_empty_without_the_starting_suggestion() {
    let app = setup(&["*"], Some(migration("legacy", 0))).await;
    app.api.lock().unwrap().held_manifest = Some(json!([]));
    let (_, _, html) = page(&app).await;
    let field = &html[html.find("<textarea id=\"held_manifest\"").unwrap()..];
    let value = &field[field.find('>').unwrap() + 1..field.find("</textarea>").unwrap()];
    assert!(value.is_empty());
    assert!(!html.contains("No manifest is saved."));
    assert!(html.contains("0 names"));
}

#[tokio::test]
async fn missing_and_malformed_discovery_fail_closed_instead_of_assuming_legacy() {
    for value in [
        None,
        Some(json!({"state":"legacy","epoch":-1})),
        Some(migration("future", 4)),
        Some(migration("preparing", 0)),
        Some(
            json!({"state":"preparing","epoch":4,"preparing_at":"bad","started_at":null,"forced_at":null}),
        ),
        Some(
            json!({"state":"selecting","epoch":4,"preparing_at":"2026-10-09T00:00:00Z", "started_at":"2026-10-09T00:00:30Z", "forced_at":"2026-10-16T00:00:30Z"}),
        ),
    ] {
        let app = setup(&["*"], value).await;
        let (_, _, html) = page(&app).await;
        assert!(html.contains("Migration state unavailable"), "{html}");
        assert!(!html.contains("action=prepare"), "{html}");
        assert!(!html.contains("action=rollback"), "{html}");
        post(&app, "prepare", "processes_ready=true&reason=Prepare", true).await;
        assert!(app.api.lock().unwrap().writes.is_empty());
    }
}

#[tokio::test]
async fn read_only_admin_sees_no_mutation_forms_and_post_rejects_each_action() {
    let app = setup(&["instance:config:view"], Some(migration("preparing", 4))).await;
    let (_, _, html) = page(&app).await;
    for action in ["policy", "prepare", "start", "rollback"] {
        assert!(!html.contains(&format!("action={action}")), "{html}");
        let (status, _, _) = post(&app, action, "reason=Change", true).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{action}");
    }
    assert!(app.api.lock().unwrap().writes.is_empty());
    assert!(
        !app.api
            .lock()
            .unwrap()
            .reads
            .iter()
            .any(|path| path == "/admin/instance/username-migration")
    );
}

#[tokio::test]
async fn admin_without_page_permissions_is_rejected_before_showing_controls() {
    let app = setup(&[], Some(migration("legacy", 0))).await;
    let (status, _, _) = page(&app).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    for action in ["policy", "prepare", "start", "rollback"] {
        let (status, _, _) = post(&app, action, "reason=Change", true).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{action}");
    }
    assert!(app.api.lock().unwrap().writes.is_empty());
}

#[tokio::test]
async fn csrf_is_required_for_each_mutation() {
    let app = setup(&["*"], Some(migration("preparing", 4))).await;
    for action in ["policy", "prepare", "start", "rollback"] {
        let (status, _, _) = post(&app, action, "reason=Change", false).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{action}");
    }
    assert!(app.api.lock().unwrap().writes.is_empty());
}

#[tokio::test]
async fn failed_api_write_never_reports_success() {
    let app = setup(&["*"], Some(migration("legacy", 0))).await;
    app.api.lock().unwrap().fail_writes = true;
    let (_, headers, _) = post(&app, "prepare", "processes_ready=true&reason=Prepare", true).await;
    assert_eq!(flash_type(&headers), "error");
}

#[tokio::test]
async fn unavailable_policy_does_not_render_a_default_editable_policy() {
    let app = setup(&["*"], Some(migration("legacy", 0))).await;
    app.api.lock().unwrap().policy_available = false;
    let (_, _, html) = page(&app).await;
    assert!(html.contains("Username policy unavailable"), "{html}");
    assert!(!html.contains("action=policy"), "{html}");
}

async fn mock_api(
    State(api): State<Shared>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    request: Request<Body>,
) -> Response {
    let bytes = to_bytes(request.into_body(), usize::MAX).await.unwrap();
    let mut api = api.lock().unwrap();
    if method == Method::GET {
        api.reads.push(uri.path().to_owned());
    }
    match (method.clone(), uri.path()) {
        (Method::GET, "/admin/users/@me") => Json(json!({"user":{
            "id":"1500000000000000000", "username":"Admin", "discriminator":1, "acls":api.acls
        }})).into_response(),
        (Method::GET, "/.well-known/fluxer") => Json(json!({"username_migration":api.migration})).into_response(),
        (Method::GET, "/admin/instance/username-migration") => Json(api.inspection.clone().unwrap_or_else(|| json!({"migration":api.migration,"scan":null,"holds":{"required":null,"ready":false,"proof":null},"capacity":{"available":false,"ready":false,"proof":null}}))).into_response(),
        (Method::GET, "/admin/instance/username-policy") if api.policy_available => {
            let mut policy = policy();
            if let Some(manifest) = &api.held_manifest { policy["held_manifest"] = manifest.clone(); }
            else { policy.as_object_mut().unwrap().remove("held_manifest"); }
            Json(policy).into_response()
        },
        (Method::POST | Method::PATCH, _) => {
            api.writes.push((format!("{method} {}", uri.path()), serde_json::from_slice(&bytes).unwrap(),
                headers.get("x-audit-log-reason").and_then(|value| String::from_utf8(value.as_bytes().to_vec()).ok())));
            if api.fail_writes {
                return (api.failure_status, Json(json!({"message":"unavailable"}))).into_response();
            }
            if let Some(response) = &api.write_response { return Json(response.clone()).into_response(); }
            if uri.path().ends_with("username-policy") { Json(policy()).into_response() }
            else if uri.path().ends_with("rollback") { Json(migration("legacy", 4)).into_response() }
            else if uri.path().ends_with("start") { Json(migration("selecting", 4)).into_response() }
            else { Json(migration("preparing", 4)).into_response() }
        }
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

fn policy() -> Value {
    json!({"revision":1,"tiers":{"1":"locked","2":"locked","3":"locked"},
        "dictionary_gen":1,"dictionary_hash":"a".repeat(64),"next_dictionary_gen":2,
        "admission":{"global_per_second":139,"paused":false}, "held_manifest":null})
}

fn inspection() -> Value {
    let now = OffsetDateTime::now_utc().format(&Rfc3339).unwrap();
    let holds = json!({"policy_revision":1,"checked_at":now,"held":2,"assigned":1,"missing":[]});
    json!({"migration":migration("preparing",4),"scan":{"epoch":4,"scanned":1234,"found":0,"done_at":now},"holds":{"required":3,"ready":true,"proof":holds},"capacity":{"available":true,"ready":true,"proof":{"epoch":4,"policy_revision":1,"total_accounts":1234,"guild_capacity":{"max_guild_members":100,"max_guild_online":10,"source":"capacity-report","observed_at":now,"epoch":4,"admin_id":"1500000000000000000"},"holds":holds}}})
}

fn migration(state: &str, epoch: u64) -> Value {
    json!({"state":state,"epoch":epoch,
        "preparing_at":if state == "legacy" { None } else { Some("2026-10-09T00:00:00Z") },
        "started_at":if state == "selecting" { Some("2026-10-09T00:01:00Z") } else { None },
        "forced_at":if state == "selecting" { Some("2026-10-16T00:01:00Z") } else { None }})
}

fn config(api_endpoint: String) -> AdminConfig {
    AdminConfig {
        env: RuntimeEnv::Test,
        host: "127.0.0.1".to_owned(),
        port: 0,
        secret_key_base: SECRET.to_owned(),
        base_path: String::new(),
        api_endpoint,
        media_endpoint: "https://media.example.test".to_owned(),
        static_cdn_endpoint: "https://static.example.test".to_owned(),
        admin_endpoint: "https://admin.example.test".to_owned(),
        web_app_endpoint: "https://app.example.test".to_owned(),
        oauth_client_id: "admin".to_owned(),
        oauth_client_secret: "secret".to_owned(),
        oauth_redirect_uri: "https://admin.example.test/callback".to_owned(),
        build_version: "test".to_owned(),
        self_hosted: false,
        proxy: ProxyConfig {
            trust_client_ip_header: false,
            client_ip_header_name: "x-forwarded-for".to_owned(),
        },
    }
}
