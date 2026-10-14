// SPDX-License-Identifier: AGPL-3.0-or-later

use axum::{
    Json, Router,
    body::{Body, Bytes, to_bytes},
    extract::State,
    http::{HeaderMap, Method, Request, StatusCode, Uri, header},
    response::{IntoResponse, Response},
};
use fluxer_admin::{
    build_router,
    config::{AdminConfig, ProxyConfig},
    middleware::flash,
    session,
};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;
use tower::ServiceExt;

const SECRET_KEY: &str = "micup-admin-referral-test-secret";
const XSS: &str = "<script>alert(1)</script>";
const ADMIN_ID: &str = "1500000000000000000";
const USER_ID: &str = "1500000000000000001";
const FAILING_USER_ID: &str = "1500000000000000999";
const TIER_ID: &str = "1900000000000000001";
const PASTED_CODE: &str = "PASTED-SECRET-CODE-7731";
const NOTICE_TEXT: &str = "Referans ödülün için destek ekibimize yaz.";

#[derive(Default)]
struct MockApi {
    acls: Vec<String>,
    // (method, path, query, body)
    requests: Vec<(Method, String, String, Value)>,
}

type Shared = Arc<Mutex<MockApi>>;

struct TestApp {
    router: Router,
    session_cookie: String,
    api: Shared,
}

async fn setup(acls: &[&str]) -> TestApp {
    let api: Shared = Arc::new(Mutex::new(MockApi {
        acls: acls.iter().map(|acl| (*acl).to_owned()).collect(),
        ..MockApi::default()
    }));
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let addr = listener.local_addr().unwrap();
    let mock = Router::new().fallback(mock_api).with_state(api.clone());
    tokio::spawn(async move { axum::serve(listener, mock).await.unwrap() });
    let router = build_router(test_config(format!("http://{addr}")));
    let session_value = session::create_session(ADMIN_ID, "test-token", SECRET_KEY);
    TestApp {
        router,
        session_cookie: format!("{}={session_value}", session::SESSION_COOKIE_NAME),
        api,
    }
}

async fn send(app: &TestApp, request: Request<Body>) -> (StatusCode, HeaderMap, String) {
    let response = app.router.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, headers, String::from_utf8(body.to_vec()).unwrap())
}

async fn get(app: &TestApp, uri: &str) -> (StatusCode, HeaderMap, String) {
    let request = Request::builder()
        .method(Method::GET)
        .uri(uri)
        .header(header::COOKIE, &app.session_cookie)
        .body(Body::empty())
        .unwrap();
    send(app, request).await
}

async fn post(app: &TestApp, page: &str, uri: &str, form: &str) -> (StatusCode, HeaderMap, String) {
    let (_, headers, body) = get(app, page).await;
    let token =
        csrf_cookie(&headers).unwrap_or_else(|| panic!("{page} set no csrf cookie\n{body}"));
    let request = Request::builder()
        .method(Method::POST)
        .uri(uri)
        .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .header(
            header::COOKIE,
            format!("{}; csrf_token={token}", app.session_cookie),
        )
        .body(Body::from(format!("_csrf={token}&{form}")))
        .unwrap();
    send(app, request).await
}

fn csrf_cookie(headers: &HeaderMap) -> Option<String> {
    headers
        .get_all(header::SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .find_map(|value| {
            let pair = value.split(';').next()?;
            let token = pair
                .strip_prefix("__Host-csrf_token=")
                .or_else(|| pair.strip_prefix("csrf_token="))?;
            (!token.is_empty()).then(|| token.to_owned())
        })
}

fn location(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::LOCATION)
        .and_then(|value| value.to_str().ok())
}

fn flash_data(headers: &HeaderMap) -> Option<flash::FlashData> {
    headers
        .get_all(header::SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .find_map(|value| value.split(';').next()?.strip_prefix("flash="))
        .and_then(flash::parse_flash)
}

fn flash_message(headers: &HeaderMap) -> String {
    flash_data(headers)
        .map(|flash| flash.message)
        .unwrap_or_default()
}

fn all_set_cookies(headers: &HeaderMap) -> String {
    headers
        .get_all(header::SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .collect::<Vec<_>>()
        .join("\n")
}

/// Requests that reached the referral contract routes, with their bodies.
fn referral_calls(app: &TestApp) -> Vec<(Method, String, String, Value)> {
    app.api
        .lock()
        .unwrap()
        .requests
        .iter()
        .filter(|(_, path, _, _)| path.contains("referral"))
        .cloned()
        .collect()
}

fn writes(app: &TestApp) -> Vec<(Method, String, Value)> {
    referral_calls(app)
        .into_iter()
        .filter(|(method, _, _, _)| method != Method::GET)
        .map(|(method, path, _, body)| (method, path, body))
        .collect()
}

fn last_write(app: &TestApp) -> (Method, String, Value) {
    writes(app)
        .pop()
        .expect("no referral write reached the API")
}

#[tokio::test]
async fn referral_pages_forbidden_without_referral_manage() {
    let app = setup(&["admin:authenticate", "shop:manage", "cosmetics:manage"]).await;
    for page in ["/referral", &format!("/referral/users/{USER_ID}")] {
        let (status, _, body) = get(&app, page).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{page}: {body}");
    }
    for action in [
        "settings",
        "tier_create",
        "tier_update",
        "tier_toggle",
        "deliver",
        "notify",
    ] {
        let form = format!(
            "user_id={USER_ID}&tier_id={TIER_ID}&threshold=5&reward_type=premium_days&days=30\
             &content=Hi&enabled=true"
        );
        let uri = format!("/referral?action={action}");
        let (status, _, body) = post(&app, "/shop", &uri, &form).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{action}: {body}");
    }
    let touched = referral_calls(&app);
    assert!(
        touched.is_empty(),
        "referral API called without referral:manage: {touched:?}"
    );
    let (_, _, page) = get(&app, "/shop").await;
    assert!(!page.contains(r#"href="/referral""#), "{page}");
}

#[tokio::test]
async fn referral_pages_open_with_acl_and_nav_link() {
    let app = setup(&["admin:authenticate", "referral:manage"]).await;
    let (status, _, page) = get(&app, "/referral").await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert!(page.contains(r#"href="/referral""#), "nav link: {page}");
    assert!(page.contains("Referral"), "{page}");
    let (status, _, page) = get(&app, &format!("/referral/users/{USER_ID}")).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    let (status, _, page) = get(&app, "/referral/users/not-a-number").await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{page}");
}

#[tokio::test]
async fn referral_settings_form_posts_the_four_settings() {
    let app = setup(&["*"]).await;
    let (status, headers, body) = post(
        &app,
        "/referral",
        "/referral?action=settings",
        "enabled=true&min_active_days=5&daily_valid_cap=75&ip_registration_limit=2",
    )
    .await;
    assert!(status.is_redirection(), "{status}: {body}");
    assert_eq!(location(&headers), Some("/referral"));
    let (method, path, body) = last_write(&app);
    assert_eq!(
        (method, path.as_str()),
        (Method::PATCH, "/admin/referral/settings")
    );
    assert_eq!(
        body,
        json!({
            "enabled": true,
            "min_active_days": 5,
            "daily_valid_cap": 75,
            "ip_registration_limit": 2
        })
    );
    // An unticked box is an explicit off, not an omitted field.
    post(
        &app,
        "/referral",
        "/referral?action=settings",
        "min_active_days=3&daily_valid_cap=50&ip_registration_limit=3",
    )
    .await;
    assert_eq!(last_write(&app).2["enabled"], json!(false));
}

#[tokio::test]
async fn referral_settings_outside_the_contract_ranges_never_reach_the_api() {
    let app = setup(&["*"]).await;
    for form in [
        "min_active_days=0&daily_valid_cap=50&ip_registration_limit=3",
        "min_active_days=31&daily_valid_cap=50&ip_registration_limit=3",
        "min_active_days=3&daily_valid_cap=0&ip_registration_limit=3",
        "min_active_days=3&daily_valid_cap=10001&ip_registration_limit=3",
        "min_active_days=3&daily_valid_cap=50&ip_registration_limit=0",
        "min_active_days=3&daily_valid_cap=50&ip_registration_limit=101",
        "min_active_days=x&daily_valid_cap=50&ip_registration_limit=3",
    ] {
        let (status, headers, _) = post(&app, "/referral", "/referral?action=settings", form).await;
        assert!(status.is_redirection(), "{form}");
        assert!(
            flash_data(&headers).is_some_and(|flash| flash.message.len() > 3),
            "{form}: no flash"
        );
    }
    assert!(writes(&app).is_empty(), "{:?}", writes(&app));
}

#[tokio::test]
async fn referral_tier_form_posts_reward_union_json() {
    let app = setup(&["*"]).await;
    let create = |form: &'static str| {
        let app = &app;
        async move { post(app, "/referral", "/referral?action=tier_create", form).await }
    };
    create("threshold=10&reward_type=cosmetic&item_id=7&enabled=true").await;
    let (method, path, body) = last_write(&app);
    assert_eq!(
        (method, path.as_str()),
        (Method::POST, "/admin/referral/tiers")
    );
    assert_eq!(
        body,
        json!({"threshold": 10, "reward": {"type": "cosmetic", "item_id": "7"}, "enabled": true})
    );
    create(
        "threshold=25&reward_type=premium_days&days=30&item_id=7&description=ignored&enabled=true",
    )
    .await;
    assert_eq!(
        last_write(&app).2,
        json!({"threshold": 25, "reward": {"type": "premium_days", "days": 30}, "enabled": true})
    );
    create("threshold=100&reward_type=offsite&description=Steam+gift+card&days=9").await;
    assert_eq!(
        last_write(&app).2,
        json!({"threshold": 100, "reward": {"type": "offsite", "description": "Steam gift card"}, "enabled": false})
    );

    // A tier's reward cannot change: the reward fields of an edit form never reach the API.
    post(
        &app,
        "/referral",
        "/referral?action=tier_update",
        &format!(
            "tier_id={TIER_ID}&threshold=12&enabled=true&reward_type=premium_days&days=90&item_id=7\
             &description=x"
        ),
    )
    .await;
    let (method, path, body) = last_write(&app);
    assert_eq!(
        (method, path),
        (Method::PATCH, format!("/admin/referral/tiers/{TIER_ID}"))
    );
    assert_eq!(body, json!({"threshold": 12, "enabled": true}));

    post(
        &app,
        "/referral",
        "/referral?action=tier_toggle",
        &format!("tier_id={TIER_ID}&enabled=false"),
    )
    .await;
    let (method, path, body) = last_write(&app);
    assert_eq!(
        (method, path),
        (Method::PATCH, format!("/admin/referral/tiers/{TIER_ID}"))
    );
    assert_eq!(body, json!({"enabled": false}));
}

#[tokio::test]
async fn referral_tier_forms_outside_the_contract_never_reach_the_api() {
    let app = setup(&["*"]).await;
    let long = "d".repeat(201);
    let bad = [
        "threshold=0&reward_type=premium_days&days=30".to_owned(),
        "threshold=1000001&reward_type=premium_days&days=30".to_owned(),
        "threshold=x&reward_type=premium_days&days=30".to_owned(),
        "threshold=5&reward_type=premium_days&days=0".to_owned(),
        "threshold=5&reward_type=premium_days&days=3651".to_owned(),
        "threshold=5&reward_type=cosmetic".to_owned(),
        "threshold=5&reward_type=cosmetic&item_id=abc".to_owned(),
        "threshold=5&reward_type=offsite&description=+++".to_owned(),
        format!("threshold=5&reward_type=offsite&description={long}"),
        "threshold=5&reward_type=gold".to_owned(),
    ];
    for form in &bad {
        post(&app, "/referral", "/referral?action=tier_create", form).await;
    }
    post(
        &app,
        "/referral",
        "/referral?action=tier_update",
        "tier_id=abc&threshold=5&reward_type=premium_days&days=30",
    )
    .await;
    post(
        &app,
        "/referral",
        "/referral?action=tier_update",
        &format!("tier_id={TIER_ID}&threshold=0"),
    )
    .await;
    assert!(writes(&app).is_empty(), "{:?}", writes(&app));
}

#[tokio::test]
async fn referral_cosmetic_select_lists_only_owned_items() {
    let app = setup(&["admin:authenticate", "referral:manage", "cosmetics:manage"]).await;
    let (status, _, page) = get(&app, "/referral").await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert!(page.contains("Kuzgun"), "{page}");
    assert!(page.contains("Gece Plakasi"), "{page}");
    assert!(
        !page.contains("Serbest Cerceve"),
        "free item offered: {page}"
    );
    assert!(
        !page.contains("Premium Cerceve"),
        "premium item offered: {page}"
    );
}

#[tokio::test]
async fn referral_page_without_cosmetics_manage_offers_no_cosmetic_reward() {
    let app = setup(&["admin:authenticate", "referral:manage"]).await;
    let (status, _, page) = get(&app, "/referral").await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert!(!page.contains("Kuzgun"), "{page}");
    assert!(
        !app.api
            .lock()
            .unwrap()
            .requests
            .iter()
            .any(|(_, path, _, _)| path.starts_with("/admin/cosmetics")),
        "cosmetics API called without cosmetics:manage"
    );
}

#[tokio::test]
async fn referral_pages_escape_api_text() {
    let app = setup(&["*"]).await;
    for page in ["/referral".to_owned(), format!("/referral/users/{USER_ID}")] {
        let (status, _, body) = get(&app, &page).await;
        assert_eq!(status, StatusCode::OK, "{page}: {body}");
        assert!(!body.contains(XSS), "{page} rendered raw API text");
        assert!(body.contains("&lt;script&gt;"), "{page}: {body}");
    }
}

#[tokio::test]
async fn referral_deliver_posts_code_and_note_to_the_contract_route() {
    let app = setup(&["*"]).await;
    let (status, headers, body) = post(
        &app,
        "/referral",
        "/referral?action=deliver",
        &format!("user_id={USER_ID}&tier_id={TIER_ID}&code={PASTED_CODE}&note=Sent+by+hand"),
    )
    .await;
    assert!(status.is_redirection(), "{status}: {body}");
    assert_eq!(location(&headers), Some("/referral"));
    let (method, path, body) = last_write(&app);
    assert_eq!(
        (method, path),
        (
            Method::POST,
            format!("/admin/users/{USER_ID}/referral-rewards/{TIER_ID}/deliver")
        )
    );
    assert_eq!(body, json!({"code": PASTED_CODE, "note": "Sent by hand"}));

    post(
        &app,
        "/referral",
        "/referral?action=deliver",
        &format!("user_id={USER_ID}&tier_id={TIER_ID}&code=&note="),
    )
    .await;
    assert_eq!(last_write(&app).2, json!({"code": null, "note": null}));

    let too_long = "n".repeat(501);
    let before = writes(&app).len();
    post(
        &app,
        "/referral",
        "/referral?action=deliver",
        &format!("user_id={USER_ID}&tier_id={TIER_ID}&note={too_long}"),
    )
    .await;
    let too_long_code = "c".repeat(257);
    post(
        &app,
        "/referral",
        "/referral?action=deliver",
        &format!("user_id={USER_ID}&tier_id={TIER_ID}&code={too_long_code}"),
    )
    .await;
    assert_eq!(
        writes(&app).len(),
        before,
        "an over-long field reached the API"
    );
}

#[tokio::test]
async fn referral_pasted_code_is_never_rendered_back() {
    let app = setup(&["*"]).await;
    // Success: the redirect, its cookies and every page afterwards stay free of the code.
    let (_, headers, body) = post(
        &app,
        "/referral",
        "/referral?action=deliver",
        &format!("user_id={USER_ID}&tier_id={TIER_ID}&code={PASTED_CODE}&note=n"),
    )
    .await;
    assert!(!body.contains(PASTED_CODE), "{body}");
    assert!(!all_set_cookies(&headers).contains(PASTED_CODE));
    assert!(!flash_message(&headers).contains(PASTED_CODE));
    // Failure (the API refuses): the flash must not echo it either.
    let (_, headers, body) = post(
        &app,
        "/referral",
        "/referral?action=deliver",
        &format!("user_id={FAILING_USER_ID}&tier_id={TIER_ID}&code={PASTED_CODE}"),
    )
    .await;
    assert!(!body.contains(PASTED_CODE), "{body}");
    assert!(!all_set_cookies(&headers).contains(PASTED_CODE));
    assert!(!flash_message(&headers).is_empty());
    for page in ["/referral".to_owned(), format!("/referral/users/{USER_ID}")] {
        let (_, _, html) = get(&app, &page).await;
        assert!(!html.contains(PASTED_CODE), "{page}");
    }
    // The input is a password box that never carries a value.
    let (_, _, page) = get(&app, "/referral").await;
    let input = page
        .split("<input")
        .find(|chunk| chunk.contains(r#"name="code""#))
        .expect("deliver form has a code input");
    let input = input.split('>').next().unwrap();
    assert!(input.contains(r#"type="password""#), "{input}");
    assert!(input.contains(r#"autocomplete="off""#), "{input}");
    assert!(!input.contains("value="), "{input}");
}

#[tokio::test]
async fn referral_notify_posts_content() {
    let app = setup(&["*"]).await;
    let (_, _, page) = get(&app, "/referral").await;
    assert!(page.contains(NOTICE_TEXT), "prefilled notice: {page}");
    let (status, headers, body) = post(
        &app,
        "/referral",
        "/referral?action=notify",
        &format!(
            "user_id={USER_ID}&tier_id={TIER_ID}&content={}",
            urlencoding::encode("Write to support.")
        ),
    )
    .await;
    assert!(status.is_redirection(), "{status}: {body}");
    assert_eq!(location(&headers), Some("/referral"));
    let (method, path, body) = last_write(&app);
    assert_eq!(
        (method, path),
        (
            Method::POST,
            format!("/admin/users/{USER_ID}/referral-rewards/{TIER_ID}/notify")
        )
    );
    assert_eq!(body, json!({"content": "Write to support."}));
    let before = writes(&app).len();
    for content in ["".to_owned(), "   ".to_owned(), "x".repeat(2001)] {
        post(
            &app,
            "/referral",
            "/referral?action=notify",
            &format!("user_id={USER_ID}&tier_id={TIER_ID}&content={content}"),
        )
        .await;
    }
    assert_eq!(writes(&app).len(), before);
}

fn pending_queries(app: &TestApp) -> Vec<String> {
    referral_calls(app)
        .into_iter()
        .filter(|(_, path, _, _)| path == "/admin/referral/pending-rewards")
        .map(|(_, _, query, _)| query)
        .collect()
}

#[tokio::test]
async fn referral_pending_rewards_page_within_a_month() {
    let app = setup(&["*"]).await;
    let (_, _, page) = get(&app, "/referral?month=2020-10&cursor=abc").await;
    let queries = pending_queries(&app);
    assert!(
        queries
            .iter()
            .any(|query| query.contains("month=2020-10") && query.contains("cursor=abc")),
        "{queries:?}"
    );
    assert!(page.contains("cursor=next-page"), "next link: {page}");
    assert!(page.contains("month=2020-10"), "{page}");
    // A malformed month is never forwarded.
    let app = setup(&["*"]).await;
    get(&app, "/referral?month=oct&cursor=abc").await;
    let queries = pending_queries(&app);
    assert!(
        queries.iter().all(|query| !query.contains("month=oct")),
        "{queries:?}"
    );
}

#[tokio::test]
async fn referral_pending_rewards_default_to_this_month_and_count_the_last_three() {
    let app = setup(&["*"]).await;
    let (_, _, page) = get(&app, "/referral").await;
    let queries = pending_queries(&app);
    // One first-page call per month, three in all and no more: the month on show is one of them.
    assert_eq!(queries.len(), 3, "{queries:?}");
    let mut months: Vec<_> = queries
        .iter()
        .map(|query| {
            assert!(!query.contains("cursor="), "{query}");
            query
                .split('&')
                .find_map(|pair| pair.strip_prefix("month="))
                .unwrap_or_else(|| panic!("no month in {query}"))
                .to_owned()
        })
        .collect();
    months.sort();
    months.dedup();
    assert_eq!(months.len(), 3, "{queries:?}");
    for month in &months {
        assert_eq!(month.len(), 7, "{month}");
        assert!(page.contains(&format!("month={month}")), "{month}: {page}");
    }
    // The newest month is on show: its rows are the table's.
    assert!(page.contains("Deliver"), "{page}");
}

#[tokio::test]
async fn referral_user_page_shows_rewards_and_pages_the_referees() {
    let app = setup(&["*"]).await;
    let (_, _, page) = get(&app, &format!("/referral/users/{USER_ID}?cursor=r1")).await;
    let call = referral_calls(&app)
        .into_iter()
        .find(|(_, path, _, _)| path == &format!("/admin/users/{USER_ID}/referrals"))
        .expect("user referrals requested");
    assert!(call.2.contains("cursor=r1"), "{}", call.2);
    assert!(page.contains("1500000000000000042"), "referee id: {page}");
    assert!(
        page.contains(r#"href="/users/1500000000000000042""#),
        "referee links to the user page: {page}"
    );
    assert!(
        page.contains("Same IP as referrer"),
        "reject reason: {page}"
    );
    assert!(page.contains("cursor=r2"), "next link: {page}");
    assert!(page.contains("code on file"), "has_code badge: {page}");
    assert!(
        !page.contains("reg_ip") && !page.contains("203.0.113"),
        "ip shown: {page}"
    );
}

#[tokio::test]
async fn referral_api_failures_become_flash_not_pages() {
    let app = setup(&["*"]).await;
    let (status, headers, _) = post(
        &app,
        "/referral",
        "/referral?action=deliver",
        &format!("user_id={FAILING_USER_ID}&tier_id={TIER_ID}&code={PASTED_CODE}"),
    )
    .await;
    assert!(status.is_redirection());
    assert_eq!(location(&headers), Some("/referral"));
    assert!(
        flash_message(&headers).contains("Failed"),
        "{}",
        flash_message(&headers)
    );
}

async fn mock_api(State(api): State<Shared>, method: Method, uri: Uri, body: Bytes) -> Response {
    let path = uri.path().to_owned();
    let query = uri.query().unwrap_or_default().to_owned();
    let body_json: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let mut api = api.lock().unwrap();
    api.requests
        .push((method.clone(), path.clone(), query, body_json));
    match (method, path.as_str()) {
        (Method::GET, "/admin/users/@me") => {
            json_response(json!({ "user": user(ADMIN_ID, &api.acls) }))
        }
        (Method::GET, "/admin/instance/config") => json_response(instance_config()),
        (Method::GET, "/admin/cosmetics/items") => json_response(json!([
            item("1700000000000000010", "Serbest Cerceve", "free"),
            item("1700000000000000011", "Premium Cerceve", "premium"),
            item("7", "Kuzgun", "owned"),
            item("8", "Gece Plakasi", "owned"),
        ])),
        (Method::GET, "/admin/referral") => json_response(admin_referral()),
        (Method::PATCH, "/admin/referral/settings") => json_response(admin_referral()),
        (Method::POST, "/admin/referral/tiers") => json_response(tier(TIER_ID, 10, true)),
        (Method::PATCH, path) if path.starts_with("/admin/referral/tiers/") => {
            json_response(tier(TIER_ID, 10, true))
        }
        (Method::GET, "/admin/referral/pending-rewards") => json_response(json!({
            "month": "2026-10",
            "items": [{
                "user_id": USER_ID,
                "tier_id": TIER_ID,
                "reward": {"type": "offsite", "description": XSS},
                "created_at": "2026-10-02T10:00:00.000Z"
            }],
            "next_cursor": "next-page"
        })),
        (Method::GET, path) if path.ends_with("/referrals") => json_response(user_referrals()),
        (Method::POST, path) if path.contains(FAILING_USER_ID) => (
            StatusCode::CONFLICT,
            Json(json!({"code": "CONFLICT", "message": "already delivered"})),
        )
            .into_response(),
        (Method::POST, path) if path.ends_with("/deliver") => json_response(json!({
            "user_id": USER_ID,
            "tier_id": TIER_ID,
            "status": "delivered",
            "delivered_at": "2026-10-02T11:00:00.000Z",
            "has_code": true
        })),
        (Method::POST, path) if path.ends_with("/notify") => StatusCode::NO_CONTENT.into_response(),
        _ => (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" }))).into_response(),
    }
}

fn json_response(value: Value) -> Response {
    Json(value).into_response()
}

fn item(id: &str, name: &str, availability: &str) -> Value {
    json!({
        "id": id,
        "type": "avatar_decoration",
        "name": name,
        "description": null,
        "asset": "0a1b2c3d",
        "availability": availability
    })
}

fn tier(id: &str, threshold: u32, enabled: bool) -> Value {
    json!({
        "id": id,
        "threshold": threshold,
        "reward": {"type": "premium_days", "days": 30},
        "enabled": enabled
    })
}

fn admin_referral() -> Value {
    json!({
        "settings": {
            "enabled": true,
            "min_active_days": 3,
            "daily_valid_cap": 50,
            "ip_registration_limit": 3
        },
        "tiers": [
            tier(TIER_ID, 10, true),
            {
                "id": "1900000000000000002",
                "threshold": 25,
                "reward": {"type": "cosmetic", "item_id": "7"},
                "enabled": true
            },
            {
                "id": "1900000000000000003",
                "threshold": 100,
                "reward": {"type": "offsite", "description": XSS},
                "enabled": false
            }
        ]
    })
}

fn user_referrals() -> Value {
    json!({
        "user_id": USER_ID,
        "code": "abcdefghij",
        "referrer_id": null,
        "counts": {"pending": 1, "valid": 12, "rejected": 2},
        "rewards": [{
            "tier_id": TIER_ID,
            "reward": {"type": "offsite", "description": XSS},
            "status": "delivered",
            "granted_at": "2026-10-01T10:00:00.000Z",
            "delivered_at": "2026-10-02T11:00:00.000Z",
            "delivered_by": ADMIN_ID,
            "note": XSS,
            "has_code": true
        }],
        "referees": [{
            "referee_id": "1500000000000000042",
            "state": "rejected",
            "reason": "same_ip",
            "referred_at": "2026-10-01T09:00:00.000Z"
        }],
        "next_cursor": "r2"
    })
}

fn user(id: &str, acls: &[String]) -> Value {
    json!({
        "id": id,
        "username": "AdminUser",
        "discriminator": 1,
        "avatar": null,
        "banner": null,
        "email": "admin@example.com",
        "email_verified": true,
        "email_bounced": false,
        "global_name": "AdminUser",
        "bio": null,
        "pronouns": null,
        "accent_color": null,
        "date_of_birth": null,
        "locale": "en-US",
        "acls": acls,
        "traits": [],
        "flags": "0",
        "premium_flags": 0,
        "bot": false,
        "system": false,
        "premium_type": null,
        "premium_since": null,
        "premium_until": null,
        "premium_grace_ends_at": null,
        "premium_lifetime_sequence": null,
        "suspicious_activity_flags": 0,
        "phone_verification_deferred": false,
        "has_totp": false,
        "authenticator_types": [],
        "has_verified_phone": false,
        "temp_banned_until": null,
        "pending_deletion_at": null,
        "pending_bulk_message_deletion_at": null,
        "deletion_reason_code": null,
        "deletion_public_reason": null,
        "last_active_at": null,
        "last_active_ip": null,
        "last_active_ip_reverse": null,
        "last_active_location": null
    })
}

fn instance_config() -> Value {
    json!({
        "sso": {"enabled": false, "enforced": false},
        "gateway_rollout": {
            "session_rollout_percentage": 100,
            "session_rollout_mode": "modulo",
            "guild_rollout_percentage": 100,
            "rpc_request_timeout_ms": 5000,
            "max_concurrent_session_starts": 16,
            "max_concurrent_guild_starts": 16,
            "voice_e2ee_scope": "guild_feature_only"
        },
        "self_hosted": true,
        "policy": {"premium_mode": "mirror", "single_community_guild_id": null}
    })
}

fn test_config(api_endpoint: String) -> AdminConfig {
    AdminConfig {
        host: "127.0.0.1".to_owned(),
        port: 0,
        secret_key_base: SECRET_KEY.to_owned(),
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
        self_hosted: true,
        proxy: ProxyConfig {
            trust_client_ip_header: false,
            client_ip_header_name: "x-forwarded-for".to_owned(),
        },
    }
}
