// SPDX-License-Identifier: AGPL-3.0-or-later

use axum::{
    Json, Router,
    body::{Body, to_bytes},
    extract::State,
    http::{Method, Request, StatusCode, Uri, header},
    response::{IntoResponse, Response},
};
use fluxer_admin::{
    build_router,
    config::{AdminConfig, ProxyConfig},
    session,
};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;
use tower::ServiceExt;

const SECRET: &str = "username-admin-test-secret";
type Writes = Arc<Mutex<Vec<(String, Value, String)>>>;
type Reads = Arc<Mutex<Vec<String>>>;

#[tokio::test]
async fn reserve_unreserve_and_assign_preserve_contract_and_audit_reason() {
    let app = setup(&["*"], None).await;
    for (action, fields, expected) in [
        (
            "hold",
            "username=reserved&note=Support%20name",
            json!({"username":"reserved", "note":"Support name"}),
        ),
        (
            "unhold",
            "username=reserved",
            json!({"username":"reserved"}),
        ),
        (
            "assign",
            "username=reserved&user_id=1500000000000000001",
            json!({"username":"reserved", "user_id":"1500000000000000001"}),
        ),
    ] {
        let response = post(
            &app,
            &format!("/usernames-reserve?action={action}"),
            &format!("{fields}&audit_log_reason=Reviewed%20request"),
            true,
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let writes = app.writes.lock().unwrap();
        let (_, body, reason) = writes.last().unwrap();
        assert_eq!(body, &expected);
        assert_eq!(reason, "Reviewed request");
    }
    let writes = app.writes.lock().unwrap();
    assert_eq!(
        writes
            .iter()
            .map(|(path, _, _)| path.as_str())
            .collect::<Vec<_>>(),
        [
            "POST /admin/usernames/reserve",
            "POST /admin/usernames/unreserve",
            "POST /admin/usernames/assign"
        ]
    );
}

#[tokio::test]
async fn assignment_requires_both_permissions() {
    for acls in [vec!["username:reserve"], vec!["user:update:username"]] {
        let app = setup(&acls, None).await;
        let response = post(
            &app,
            "/usernames-reserve?action=assign",
            "username=reserved&user_id=1500000000000000001&audit_log_reason=reviewed",
            true,
        )
        .await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert!(app.writes.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn reserve_and_dictionary_writes_require_csrf_and_reason() {
    for (uri, fields) in [
        ("/usernames-reserve?action=hold", "username=reserved"),
        ("/usernames-reserve?action=unhold", "username=reserved"),
        (
            "/usernames-reserve?action=assign",
            "username=reserved&user_id=1500000000000000001",
        ),
        ("/username-dictionary", "scope=uname_exact&add=admin"),
    ] {
        let app = setup(&["*"], None).await;
        let response = post(
            &app,
            uri,
            &format!("{fields}&audit_log_reason=reviewed"),
            false,
        )
        .await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let response = post(&app, uri, fields, true).await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert!(app.writes.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn reserve_operations_are_denied_without_reserve_acl() {
    let app = setup(&["admin:authenticate"], None).await;
    for action in ["hold", "unhold"] {
        let response = post(
            &app,
            &format!("/usernames-reserve?action={action}"),
            "username=reserved&audit_log_reason=reviewed",
            true,
        )
        .await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }
    assert!(app.writes.lock().unwrap().is_empty());
}

#[tokio::test]
async fn dictionary_publish_uses_inverse_allow_permissions() {
    for (scope, field, acl, denied_acl) in [
        (
            "uname_exact",
            "add",
            "ban:profile_substring:add",
            "ban:profile_substring:remove",
        ),
        (
            "uname_contains",
            "remove",
            "ban:profile_substring:remove",
            "ban:profile_substring:add",
        ),
        (
            "uname_allow",
            "add",
            "ban:profile_substring:remove",
            "ban:profile_substring:add",
        ),
        (
            "uname_allow",
            "remove",
            "ban:profile_substring:add",
            "ban:profile_substring:remove",
        ),
    ] {
        let fields = format!("scope={scope}&{field}=admin&audit_log_reason=reviewed");
        let allowed = setup(&[acl], None).await;
        let response = post(&allowed, "/username-dictionary", &fields, true).await;
        assert_eq!(response.status(), StatusCode::OK);
        {
            let writes = allowed.writes.lock().unwrap();
            assert_eq!(writes[0].0, "PATCH /admin/username-dictionary");
            assert_eq!(writes[0].1["scope"], scope);
            assert_eq!(writes[0].1[field], json!(["admin"]));
        }
        let denied = setup(&[denied_acl], None).await;
        let response = post(&denied, "/username-dictionary", &fields, true).await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert!(denied.writes.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn dictionary_rejects_legacy_scopes_empty_changes_and_invalid_entries() {
    let app = setup(&["*"], None).await;
    for fields in [
        "scope=username&add=admin",
        "scope=uname_exact",
        "scope=uname_exact&add=bad_name",
        "scope=uname_contains&add=one%0Atwo%21",
    ] {
        let response = post(
            &app,
            "/username-dictionary",
            &format!("{fields}&audit_log_reason=reviewed"),
            true,
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
    assert!(app.writes.lock().unwrap().is_empty());
}

#[tokio::test]
async fn mixed_dictionary_changes_need_both_permissions_and_normalize_entries() {
    let fields = "scope=uname_exact&add=ADMIN%0Asystem&remove=blocked&audit_log_reason=reviewed";
    for permission in ["ban:profile_substring:add", "ban:profile_substring:remove"] {
        let app = setup(&[permission], None).await;
        assert_eq!(
            post(&app, "/username-dictionary", fields, true)
                .await
                .status(),
            StatusCode::FORBIDDEN
        );
        assert!(app.writes.lock().unwrap().is_empty());
    }
    let app = setup(&["*"], None).await;
    assert_eq!(
        post(&app, "/username-dictionary", fields, true)
            .await
            .status(),
        StatusCode::OK
    );
    let writes = app.writes.lock().unwrap();
    assert_eq!(writes[0].1["add"], json!(["admin", "system"]));
    assert_eq!(writes[0].1["remove"], json!(["blocked"]));
}

#[tokio::test]
async fn dictionary_rejects_more_than_twenty_thousand_changes() {
    let app = setup(&["*"], None).await;
    let entries = std::iter::repeat_n("admin", 20_001)
        .collect::<Vec<_>>()
        .join("%0A");
    let fields = format!("scope=uname_exact&add={entries}&audit_log_reason=reviewed");
    assert_eq!(
        post(&app, "/username-dictionary", &fields, true)
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    assert!(app.writes.lock().unwrap().is_empty());
}

#[tokio::test]
async fn dictionary_forms_follow_the_allow_list_permission_inversion() {
    let app = setup(
        &["ban:profile_substring:check", "ban:profile_substring:add"],
        None,
    )
    .await;
    let html = body_text(get(&app, "/username-dictionary").await).await;
    assert!(html.contains("id=\"add-uname_exact\" name=\"add\""));
    assert!(html.contains("id=\"add-uname_contains\" name=\"add\""));
    assert!(html.contains("id=\"remove-uname_allow\" name=\"remove\""));
    assert!(!html.contains("id=\"remove-uname_exact\""));
    assert!(!html.contains("id=\"add-uname_allow\""));
}

#[tokio::test]
async fn audit_reasons_reject_controls_and_utf16_overflow_before_api_writes() {
    let app = setup(&["*"], None).await;
    for reason in [
        "one\ntwo".to_owned(),
        "one\ttwo".to_owned(),
        "a".repeat(513),
        "😀".repeat(257),
    ] {
        let reason = urlencoding::encode(&reason);
        for (uri, fields) in [
            ("/usernames-reserve?action=hold", "username=reserved"),
            ("/usernames-reserve?action=unhold", "username=reserved"),
            (
                "/usernames-reserve?action=assign",
                "username=reserved&user_id=1500000000000000001",
            ),
            ("/username-dictionary", "scope=uname_exact&add=admin"),
        ] {
            assert_eq!(
                post(
                    &app,
                    uri,
                    &format!("{fields}&audit_log_reason={reason}"),
                    true
                )
                .await
                .status(),
                StatusCode::BAD_REQUEST
            );
        }
    }
    assert!(app.writes.lock().unwrap().is_empty());
}

#[tokio::test]
async fn unicode_reason_bytes_are_preserved_and_note_limit_counts_utf16() {
    let app = setup(&["*"], None).await;
    let reason = "Türkçe karar – kullanıcı talebi";
    let fields = format!(
        "username=reserved&note=Review&audit_log_reason={}",
        urlencoding::encode(reason)
    );
    assert_eq!(
        post(&app, "/usernames-reserve?action=hold", &fields, true)
            .await
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        app.writes.lock().unwrap()[0].2.as_bytes(),
        reason.as_bytes()
    );
    let note = "😀".repeat(501);
    let fields = format!(
        "username=reserved&note={}&audit_log_reason=reviewed",
        urlencoding::encode(&note)
    );
    assert_eq!(
        post(&app, "/usernames-reserve?action=hold", &fields, true)
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(app.writes.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn claim_rejection_is_not_reported_as_success() {
    let app = setup(
        &["*"],
        Some(json!({"ok":false, "code":"RELEASE_EMBARGO", "available_at":"2026-10-23T00:00:00Z"})),
    )
    .await;
    let response = post(
        &app,
        "/usernames-reserve?action=hold",
        "username=reserved&audit_log_reason=reviewed",
        true,
    )
    .await;
    let html = body_text(response).await;
    assert!(html.contains("RELEASE_EMBARGO"));
    assert!(html.contains("2026-10-23T00:00:00Z"));
    assert!(!html.contains("Reservation held successfully"));
}

#[tokio::test]
async fn pages_show_published_generation_and_hide_unauthorized_controls() {
    let app = setup(&["username:reserve", "ban:profile_substring:check"], None).await;
    let html = body_text(get(&app, "/usernames-reserve").await).await;
    assert!(html.contains("reserved"));
    assert!(html.contains("max=\"1023\""));
    assert!(html.contains("Load page"));
    assert!(html.contains("action=hold"));
    assert!(!html.contains("action=assign"));
    let html = body_text(get(&app, "/username-dictionary").await).await;
    assert!(html.contains("Generation 7"));
    assert!(html.contains("published-hash"));
    assert!(html.contains("20,000"));
    assert!(html.contains("/profile-substring-bans"));
    assert!(!html.contains("Publish generation"));
    let denied = setup(&["admin:authenticate"], None).await;
    assert_eq!(
        get(&denied, "/username-dictionary").await.status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        get(&denied, "/usernames-reserve").await.status(),
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn reservations_get_uses_one_bucket_cursor_limit_and_escapes_private_notes() {
    let app = setup(&["username:reserve"], None).await;
    let html =
        body_text(get(&app, "/usernames-reserve?bucket=42&cursor=admin&limit=2").await).await;
    assert!(html.contains("Bucket 42"), "{html}");
    assert!(html.contains("&lt;private-note&gt;"), "{html}");
    assert!(
        html.contains("bucket=42&amp;limit=2&amp;cursor=reserved"),
        "{html}"
    );
    assert!(!html.contains("<private-note>"));
    assert_eq!(
        *app.reads.lock().unwrap(),
        ["/admin/usernames/reservations?bucket=42&limit=2&cursor=admin"]
    );
}

#[tokio::test]
async fn invalid_reservation_query_is_not_silently_replaced_by_a_default_page() {
    let app = setup(&["username:reserve"], None).await;
    for query in [
        "bucket=1024",
        "bucket=-1",
        "bucket=0&limit=101",
        "bucket=0&cursor=bad%21name",
    ] {
        let response = get(&app, &format!("/usernames-reserve?{query}")).await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{query}");
    }
    assert!(app.reads.lock().unwrap().is_empty());
}

#[tokio::test]
async fn dictionary_lists_are_bounded_and_extreme_page_numbers_are_clamped() {
    let mut published = dictionary();
    published["entries"]["uname_exact"] =
        json!((0..201).map(|i| format!("entry{i:03}")).collect::<Vec<_>>());
    published["counts"]["uname_exact"] = json!(201);
    published["count"] = json!(203);
    let app = setup_dictionary(&["ban:profile_substring:check"], None, published).await;
    let first = body_text(get(&app, "/username-dictionary").await).await;
    assert!(first.contains(">entry000</code>"));
    assert!(first.contains(">entry099</code>"));
    assert!(!first.contains(">entry100</code>"));
    assert!(first.contains("scope=uname_exact&amp;page=1"));
    let last = body_text(
        get(
            &app,
            "/username-dictionary?scope=uname_exact&page=18446744073709551615",
        )
        .await,
    )
    .await;
    assert!(last.contains(">entry200</code>"));
    assert!(!last.contains(">entry000</code>"));
    assert!(last.contains("scope=uname_exact&amp;page=1"));
}

#[derive(Clone)]
struct MockState {
    acls: Vec<String>,
    writes: Writes,
    reads: Reads,
    claim: Option<Value>,
    dictionary: Value,
}
struct TestApp {
    router: Router,
    cookie: String,
    writes: Writes,
    reads: Reads,
}

async fn setup(acls: &[&str], claim: Option<Value>) -> TestApp {
    setup_dictionary(acls, claim, dictionary()).await
}

async fn setup_dictionary(acls: &[&str], claim: Option<Value>, dictionary: Value) -> TestApp {
    let writes = Arc::new(Mutex::new(Vec::new()));
    let reads = Arc::new(Mutex::new(Vec::new()));
    let state = MockState {
        acls: acls.iter().map(|acl| (*acl).to_owned()).collect(),
        writes: Arc::clone(&writes),
        reads: Arc::clone(&reads),
        claim,
        dictionary,
    };
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let api_endpoint = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        axum::serve(listener, Router::new().fallback(mock_api).with_state(state))
            .await
            .unwrap();
    });
    let session_value = session::create_session("1130650140672000000", "test-token", SECRET);
    TestApp {
        router: build_router(test_config(api_endpoint)),
        cookie: format!("{}={session_value}", session::SESSION_COOKIE_NAME),
        writes,
        reads,
    }
}

async fn get(app: &TestApp, path: &str) -> Response {
    app.router
        .clone()
        .oneshot(
            Request::builder()
                .uri(path)
                .header(header::COOKIE, &app.cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap()
}

async fn post(app: &TestApp, uri: &str, fields: &str, with_csrf: bool) -> Response {
    let token = session::create_csrf_token("1130650140672000000", SECRET);
    let body = if with_csrf {
        format!("_csrf={token}&{fields}")
    } else {
        fields.to_owned()
    };
    app.router
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri(uri)
                .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
                .header(
                    header::COOKIE,
                    format!("{}; __Host-csrf_token={token}", app.cookie),
                )
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap()
}

async fn body_text(response: Response) -> String {
    String::from_utf8(
        to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap()
}

async fn mock_api(
    State(state): State<MockState>,
    method: Method,
    uri: Uri,
    request: Request<Body>,
) -> Response {
    let path = uri.path();
    if method == Method::GET && path == "/admin/users/@me" {
        let mut user = admin_user();
        user["acls"] = json!(state.acls);
        return Json(json!({ "user": user })).into_response();
    }
    if method == Method::GET && path == "/admin/username-dictionary" {
        return Json(state.dictionary).into_response();
    }
    if method == Method::GET && path == "/admin/usernames/reservations" {
        state.reads.lock().unwrap().push(uri.to_string());
        let query = uri.query().unwrap_or("");
        let bucket = if query.contains("bucket=42") { 42 } else { 0 };
        return Json(json!({"bucket":bucket,"items":[{"username":"reserved","state":"held","user_id":null,"owned_gen":null,"held_by":"1130650140672000000","note":"<private-note>","blocked_until":null,"updated_at":"2026-10-09T00:00:00Z","index_ts":"1"}],"next_cursor":"reserved"})).into_response();
    }
    if method == Method::POST || method == Method::PATCH {
        let reason = String::from_utf8(
            request
                .headers()
                .get("x-audit-log-reason")
                .map(|v| v.as_bytes().to_vec())
                .unwrap_or_default(),
        )
        .unwrap();
        let bytes = to_bytes(request.into_body(), usize::MAX).await.unwrap();
        let body = serde_json::from_slice(&bytes).unwrap();
        state
            .writes
            .lock()
            .unwrap()
            .push((format!("{method} {path}"), body, reason));
        return match path {
            "/admin/usernames/unreserve" => StatusCode::NO_CONTENT.into_response(),
            "/admin/usernames/reserve" | "/admin/usernames/assign" => Json(
                state
                    .claim
                    .unwrap_or(json!({"ok":true, "username":"reserved", "noop":false})),
            )
            .into_response(),
            "/admin/username-dictionary" => Json(state.dictionary).into_response(),
            _ => StatusCode::NOT_FOUND.into_response(),
        };
    }
    StatusCode::NOT_FOUND.into_response()
}

fn dictionary() -> Value {
    json!({"dictionary_gen":7, "hash":"published-hash", "count":3, "counts":{"uname_exact":1,"uname_contains":1,"uname_allow":1}, "entries":{"uname_exact":["admin"],"uname_contains":["blocked"],"uname_allow":["allowed"]}})
}

fn test_config(api_endpoint: String) -> AdminConfig {
    AdminConfig {
        host: "127.0.0.1".to_owned(),
        port: 0,
        secret_key_base: SECRET.to_owned(),
        base_path: String::new(),
        api_endpoint,
        media_endpoint: "https://media.example.test".to_owned(),
        static_cdn_endpoint: "https://static.example.test".to_owned(),
        reports_bucket_origin: "https://reports.example.test".to_owned(),
        admin_endpoint: "https://admin.example.test".to_owned(),
        web_app_endpoint: "https://app.example.test".to_owned(),
        oauth_client_id: "admin-client".to_owned(),
        oauth_client_secret: "admin-secret".to_owned(),
        oauth_redirect_uri: "https://admin.example.test/callback".to_owned(),
        build_version: "test".to_owned(),
        self_hosted: false,
        proxy: ProxyConfig {
            trust_client_ip_header: false,
            client_ip_header_name: "x-forwarded-for".to_owned(),
        },
    }
}

fn admin_user() -> Value {
    json!({
        "id": "1130650140672000000",
        "username": "AdminUser",
        "discriminator": 0,
        "global_name": "AdminUser",
        "email": "admin@example.com",
        "acls": ["*"],
        "bot": false,
        "system": false,
        "flags": "0",
        "premium_flags": 0,
        "avatar": null,
        "banner": null,
        "bio": null,
        "pronouns": null,
        "accent_color": null,
        "email_verified": true,
        "email_bounced": false,
        "date_of_birth": null,
        "locale": "en-US",
        "premium_type": null,
        "premium_since": null,
        "premium_until": null,
        "premium_grace_ends_at": null,
        "premium_lifetime_sequence": null,
        "temp_banned_until": null,
        "pending_deletion_at": null,
        "pending_bulk_message_deletion_at": null,
        "deletion_reason_code": null,
        "deletion_public_reason": null,
        "deletion_audit_log_reason": null,
        "deletion_scheduled_by": null,
        "deletion_scheduled_at": null,
        "traits": [],
        "has_totp": false,
        "authenticator_types": [],
        "last_active_at": null,
        "last_active_ip": null,
        "last_active_ip_reverse": null,
        "last_active_location": null
    })
}
