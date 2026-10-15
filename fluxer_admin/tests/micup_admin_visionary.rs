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
    middleware::flash::{FlashData, parse_flash},
    session,
};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;
use tower::ServiceExt;

const SECRET_KEY: &str = "micup-admin-visionary-test-secret";
const TAKE_BACK_WARNING: &str =
    "The number is retired and never sold again. Reward decorations are taken back.";
const EARLY_PLUS_BADGE_HINT: &str = "Choose a new badge made only for Early Plus. Revoke removes this \
                                     badge from the user even if it was given by hand.";
const EARLY_PLUS_FIXED: &str = "The badge is fixed: Early Plus has opened before.";
const VISIONARY_END_NOTE: &str = "Visionary is lifetime Plus, which ending Plus does not \
                                  change. Use Take Visionary back instead.";

#[derive(Clone, Debug)]
struct Call {
    method: Method,
    path: String,
    reason: Option<String>,
    body: Value,
}

#[derive(Default)]
struct MockApi {
    acls: Vec<String>,
    calls: Vec<Call>,
    stock: Option<Value>,
    lifetime_sequence: Option<i32>,
    shrink_refused: bool,
    early_plus_open: bool,
    early_plus_opened_once: bool,
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
    let session_value = session::create_session("1500000000000000000", "test-token", SECRET_KEY);
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

fn flash(headers: &HeaderMap) -> Option<FlashData> {
    headers
        .get_all(header::SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .find_map(|value| parse_flash(value.split(';').next()?.strip_prefix("flash=")?))
}

fn writes(app: &TestApp) -> Vec<Call> {
    app.api
        .lock()
        .unwrap()
        .calls
        .iter()
        .filter(|call| call.method != Method::GET)
        .cloned()
        .collect()
}

fn calls_to(app: &TestApp, path: &str) -> Vec<Call> {
    app.api
        .lock()
        .unwrap()
        .calls
        .iter()
        .filter(|call| call.path == path)
        .cloned()
        .collect()
}

#[tokio::test]
async fn shop_page_shows_the_visionary_card_to_shop_manage() {
    let app = setup(&["*"]).await;
    let (status, _, page) = get(&app, "/shop").await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert!(!calls_to(&app, "/admin/shop/visionary").is_empty());
    assert!(
        page.contains("Total 10 · Sold 3 · Held 1 · Left 6"),
        "{page}"
    );
    assert!(page.contains(r#"name="visionary_price""#), "{page}");
    // sanalyer: lira, comma decimals, no symbol in the field so it reads back unchanged.
    assert!(page.contains(r#"value="1250,50""#), "{page}");
    assert!(page.contains("Hidden"), "{page}");
    assert!(page.contains("Put on sale"), "{page}");
    for action in [
        "visionary_price",
        "visionary_sale",
        "visionary_slots",
        "visionary_rewards",
    ] {
        assert!(
            page.contains(&format!(r#"action="/shop?action={action}""#)),
            "{action}: {page}"
        );
    }
    // Visionary takes a campaign, so it is a row of the campaign table.
    assert!(
        page.contains(r#"name="product_ids" value="visionary""#),
        "{page}"
    );
    assert!(page.contains("₺1.125,45"), "{page}");

    let app = setup(&["admin:authenticate", "cosmetics:manage"]).await;
    let (status, _, page) = get(&app, "/shop").await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{page}");
    let (status, _, _) = post(
        &app,
        "/cosmetics",
        "/shop?action=visionary_slots",
        "total=25",
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let touched: Vec<_> = app
        .api
        .lock()
        .unwrap()
        .calls
        .iter()
        .filter(|call| call.path.starts_with("/admin/shop"))
        .map(|call| call.path.clone())
        .collect();
    assert!(touched.is_empty(), "{touched:?}");
}

#[tokio::test]
async fn visionary_card_actions_call_the_api() {
    let app = setup(&["*"]).await;
    let cases = [
        (
            "visionary_price",
            "visionary_price=149.99",
            Method::PUT,
            "/admin/shop/prices",
            json!({"prices": [{"sku": "visionary", "base_try_minor": 14999}]}),
        ),
        (
            "visionary_price",
            "visionary_price=149%2C99",
            Method::PUT,
            "/admin/shop/prices",
            json!({"prices": [{"sku": "visionary", "base_try_minor": 14999}]}),
        ),
        (
            "visionary_price",
            "visionary_price=",
            Method::PUT,
            "/admin/shop/prices",
            json!({"prices": [{"sku": "visionary", "base_try_minor": null}]}),
        ),
        (
            "visionary_sale",
            "visionary_on_sale=true",
            Method::PATCH,
            "/admin/shop/settings",
            json!({"visionary_on_sale": true}),
        ),
        (
            "visionary_sale",
            "visionary_on_sale=false",
            Method::PATCH,
            "/admin/shop/settings",
            json!({"visionary_on_sale": false}),
        ),
        (
            "visionary_slots",
            "total=25",
            Method::PUT,
            "/admin/shop/visionary/slots",
            json!({"total": 25}),
        ),
        (
            "visionary_rewards",
            "reward_item_ids=9&reward_item_ids=11",
            Method::PATCH,
            "/admin/shop/settings",
            json!({"visionary_reward_item_ids": ["9", "11"]}),
        ),
        (
            "visionary_rewards",
            "",
            Method::PATCH,
            "/admin/shop/settings",
            json!({"visionary_reward_item_ids": []}),
        ),
    ];
    for (action, form, method, path, body) in cases {
        app.api.lock().unwrap().calls.clear();
        let uri = format!("/shop?action={action}");
        let (status, headers, page) = post(&app, "/shop", &uri, form).await;
        assert_eq!(status, StatusCode::SEE_OTHER, "{action}: {page}");
        let flash = flash(&headers).expect("no flash");
        assert_eq!(
            flash.flash_type, "success",
            "{action} {form}: {}",
            flash.message
        );
        let sent = writes(&app);
        assert_eq!(sent.len(), 1, "{action} {form}: {sent:?}");
        assert_eq!((&sent[0].method, sent[0].path.as_str()), (&method, path));
        assert_eq!(sent[0].body, body, "{action} {form}");
    }
}

#[tokio::test]
async fn visionary_row_in_the_campaign_table_takes_a_campaign() {
    let app = setup(&["*"]).await;
    let (status, headers, page) = post(
        &app,
        "/shop",
        "/shop?action=apply_campaign",
        "product_ids=visionary&discount_percent=10&ends_at=",
    )
    .await;
    assert_eq!(status, StatusCode::SEE_OTHER, "{page}");
    assert_eq!(
        flash(&headers).map(|f| f.flash_type).as_deref(),
        Some("success")
    );
    let sent = calls_to(&app, "/admin/shop/campaigns");
    assert_eq!(sent.len(), 1, "{sent:?}");
    assert_eq!(
        sent[0].body,
        json!({"skus": ["visionary"], "percent": 10, "ends_at": null})
    );
}

#[tokio::test]
async fn visionary_card_refuses_bad_input_before_the_api() {
    let app = setup(&["*"]).await;
    let eleven = (1..=11)
        .map(|n| format!("reward_item_ids={n}"))
        .collect::<Vec<_>>()
        .join("&");
    let cases = [
        ("visionary_price", "visionary_price=0".to_owned()),
        ("visionary_price", "visionary_price=abc".to_owned()),
        ("visionary_slots", "total=".to_owned()),
        ("visionary_slots", "total=-1".to_owned()),
        ("visionary_slots", "total=100001".to_owned()),
        ("visionary_slots", "total=2.5".to_owned()),
        ("visionary_rewards", eleven),
        ("visionary_rewards", "reward_item_ids=abc".to_owned()),
        ("visionary_rewards", "reward_item_ids=0".to_owned()),
    ];
    for (action, form) in &cases {
        let uri = format!("/shop?action={action}");
        let (status, headers, page) = post(&app, "/shop", &uri, form).await;
        assert_eq!(status, StatusCode::SEE_OTHER, "{page}");
        assert_eq!(
            flash(&headers).map(|f| f.flash_type).as_deref(),
            Some("error"),
            "{action} {form}"
        );
    }
    assert!(writes(&app).is_empty(), "{:?}", writes(&app));
}

#[tokio::test]
async fn reward_picker_lists_only_unpriced_owned_items() {
    let app = setup(&["*"]).await;
    let (status, _, page) = get(&app, "/shop").await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert!(
        page.contains(r#"name="reward_item_ids" value="9" checked"#),
        "{page}"
    );
    assert!(
        page.contains(r#"name="reward_item_ids" value="11""#),
        "{page}"
    );
    assert!(
        !page.contains(r#"name="reward_item_ids" value="11" checked"#),
        "{page}"
    );
    assert!(page.contains("Altin Hale (Avatar decoration)"), "{page}");
    // Priced (on sale) and free items can never be rewards.
    assert!(
        !page.contains(r#"name="reward_item_ids" value="7""#),
        "{page}"
    );
    assert!(
        !page.contains(r#"name="reward_item_ids" value="8""#),
        "{page}"
    );
}

// The API refuses a price on a reward, and one refused row fails the whole save.
#[tokio::test]
async fn reward_decorations_show_in_the_price_table_without_a_price_field() {
    let app = setup(&["*"]).await;
    let (status, _, page) = get(&app, "/shop").await;
    assert_eq!(status, StatusCode::OK, "{page}");
    for field in [
        r#"name="price_cosmetic:9""#,
        r#"name="was_cosmetic:9""#,
        r#"name="rows" value="cosmetic:9""#,
        r#"name="product_ids" value="cosmetic:9""#,
    ] {
        assert!(!page.contains(field), "{field}: {page}");
    }
    assert!(page.contains("Visionary reward: cannot be sold"), "{page}");
    assert!(page.contains(r#"name="price_cosmetic:11""#), "{page}");
}

#[tokio::test]
async fn over_cap_and_held_warnings_show_as_badges() {
    let app = setup(&["*"]).await;
    let (_, _, calm) = get(&app, "/shop").await;
    assert!(!calm.contains("Over the total"), "{calm}");
    assert!(!calm.contains("Many numbers held"), "{calm}");
    app.api.lock().unwrap().stock = Some(json!({
        "total": 10, "sold": 6, "held": 3, "remaining": 1, "over_cap_grants": 2
    }));
    let (status, _, page) = get(&app, "/shop").await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert!(page.contains("Over the total: 2"), "{page}");
    assert!(page.contains("Many numbers held"), "{page}");
}

#[tokio::test]
async fn shrink_refusal_shows_a_flash_error() {
    let app = setup(&["*"]).await;
    app.api.lock().unwrap().shrink_refused = true;
    let (status, headers, page) =
        post(&app, "/shop", "/shop?action=visionary_slots", "total=2").await;
    assert_eq!(status, StatusCode::SEE_OTHER, "{page}");
    let flash = flash(&headers).expect("no flash");
    assert_eq!(flash.flash_type, "error");
    assert_eq!(
        flash.message,
        "Numbers that are sold or held cannot be removed."
    );
    assert_eq!(calls_to(&app, "/admin/shop/visionary/slots").len(), 1);
}

#[tokio::test]
async fn early_plus_card_picks_an_unnumbered_badge_before_the_first_opening() {
    let app = setup(&["*"]).await;
    let (status, _, page) = get(&app, "/shop").await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert!(page.contains("Early Plus"), "{page}");
    assert!(
        page.contains(r#"action="/shop?action=early_plus_badge""#),
        "{page}"
    );
    assert!(page.contains(r#"name="early_plus_badge_id""#), "{page}");
    assert!(page.contains(r#"<option value="21""#), "{page}");
    // A numbered badge is given only with its own number, so it is never offered.
    assert!(!page.contains(r#"<option value="22""#), "{page}");
    assert!(page.contains(EARLY_PLUS_BADGE_HINT), "{page}");
    assert!(
        page.contains(r#"name="early_plus_open" value="true""#),
        "{page}"
    );
    assert!(page.contains("Choose a badge before opening."), "{page}");

    app.api.lock().unwrap().early_plus_open = true;
    let (status, _, page) = get(&app, "/shop").await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert!(page.contains("Badge: Erken Plus"), "{page}");
    assert!(
        page.contains(r#"name="early_plus_open" value="false""#),
        "{page}"
    );
    assert!(page.contains(EARLY_PLUS_FIXED), "{page}");
    assert!(!page.contains(r#"name="early_plus_badge_id""#), "{page}");

    // Closed again after the first opening: the badge stays fixed.
    app.api.lock().unwrap().early_plus_open = false;
    app.api.lock().unwrap().early_plus_opened_once = true;
    let (status, _, page) = get(&app, "/shop").await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert!(page.contains(EARLY_PLUS_FIXED), "{page}");
    assert!(!page.contains(r#"name="early_plus_badge_id""#), "{page}");
    assert!(
        page.contains(r#"name="early_plus_open" value="true""#),
        "{page}"
    );
}

// Choosing the badge and opening need badges:manage in the API; closing needs only shop:manage.
#[tokio::test]
async fn early_plus_card_without_badges_manage_only_closes() {
    let app = setup(&["admin:authenticate", "shop:manage"]).await;
    let (status, _, page) = get(&app, "/shop").await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert!(page.contains("badges:manage"), "{page}");
    assert!(!page.contains(r#"name="early_plus_badge_id""#), "{page}");
    assert!(
        !page.contains(r#"name="early_plus_open" value="true""#),
        "{page}"
    );
    assert!(calls_to(&app, "/admin/badges").is_empty());

    app.api.lock().unwrap().early_plus_open = true;
    let (status, _, page) = get(&app, "/shop").await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert!(
        page.contains(r#"name="early_plus_open" value="false""#),
        "{page}"
    );
}

#[tokio::test]
async fn early_plus_actions_call_the_api() {
    let app = setup(&["*"]).await;
    let cases = [
        (
            "early_plus_badge",
            "early_plus_badge_id=21",
            json!({"early_plus_badge_id": "21"}),
        ),
        (
            "early_plus_badge",
            "early_plus_badge_id=",
            json!({"early_plus_badge_id": null}),
        ),
        (
            "early_plus_open",
            "early_plus_open=true",
            json!({"early_plus_open": true}),
        ),
        (
            "early_plus_open",
            "early_plus_open=false",
            json!({"early_plus_open": false}),
        ),
    ];
    for (action, form, body) in cases {
        app.api.lock().unwrap().calls.clear();
        let uri = format!("/shop?action={action}");
        let (status, headers, page) = post(&app, "/shop", &uri, form).await;
        assert_eq!(status, StatusCode::SEE_OTHER, "{action}: {page}");
        let flash = flash(&headers).expect("no flash");
        assert_eq!(flash.flash_type, "success", "{form}: {}", flash.message);
        let sent = writes(&app);
        assert_eq!(sent.len(), 1, "{form}: {sent:?}");
        assert_eq!(
            (&sent[0].method, sent[0].path.as_str()),
            (&Method::PATCH, "/admin/shop/settings")
        );
        assert_eq!(sent[0].body, body, "{form}");
    }

    app.api.lock().unwrap().calls.clear();
    for form in ["early_plus_badge_id=abc", "early_plus_badge_id=0"] {
        let (status, headers, page) =
            post(&app, "/shop", "/shop?action=early_plus_badge", form).await;
        assert_eq!(status, StatusCode::SEE_OTHER, "{page}");
        assert_eq!(
            flash(&headers).map(|f| f.flash_type).as_deref(),
            Some("error"),
            "{form}"
        );
    }
    assert!(writes(&app).is_empty(), "{:?}", writes(&app));
}

#[tokio::test]
async fn user_overview_shows_the_visionary_form_only_with_both_acls() {
    let app = setup(&["*"]).await;
    let (status, _, page) = get(&app, "/users/1?tab=overview").await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert!(page.contains("Not a Visionary"), "{page}");
    assert!(page.contains("action=grant_visionary"), "{page}");
    assert!(page.contains(r#"name="slot""#), "{page}");
    assert!(!page.contains("action=revoke_visionary"), "{page}");

    app.api.lock().unwrap().lifetime_sequence = Some(3);
    let (status, _, page) = get(&app, "/users/1?tab=overview").await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert!(page.contains("Visionary #3"), "{page}");
    assert!(page.contains("action=revoke_visionary"), "{page}");
    assert!(page.contains(TAKE_BACK_WARNING), "{page}");
    assert!(!page.contains("action=grant_visionary"), "{page}");

    for acls in [
        &["admin:authenticate", "shop:manage"][..],
        &["admin:authenticate", "user:update:flags"][..],
    ] {
        let app = setup(acls).await;
        let (status, _, page) = get(&app, "/users/1?tab=overview").await;
        assert_eq!(status, StatusCode::OK, "{acls:?}: {page}");
        assert!(!page.contains("_visionary"), "{acls:?}: {page}");
    }
}

// Ending premium leaves lifetime premium as it is, so a Visionary account gets a note instead.
#[tokio::test]
async fn end_premium_is_a_note_on_a_visionary_account() {
    let app = setup(&["*"]).await;
    let (status, _, page) = get(&app, "/users/1?tab=overview").await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert!(page.contains("action=end_premium"), "{page}");
    assert!(!page.contains(VISIONARY_END_NOTE), "{page}");

    app.api.lock().unwrap().lifetime_sequence = Some(3);
    let (status, _, page) = get(&app, "/users/1?tab=overview").await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert!(!page.contains("action=end_premium"), "{page}");
    assert!(page.contains(VISIONARY_END_NOTE), "{page}");
}

#[tokio::test]
async fn give_and_take_back_send_the_reason_header() {
    let app = setup(&["*"]).await;
    let grant = "/users/1?action=grant_visionary&tab=overview";
    for form in [
        "slot=&audit_log_reason=",
        "slot=0&audit_log_reason=Epha+is+number+one",
        "slot=abc&audit_log_reason=Epha+is+number+one",
        "slot=100001&audit_log_reason=Epha+is+number+one",
    ] {
        let (status, headers, page) = post(&app, "/users/1", grant, form).await;
        assert_eq!(status, StatusCode::SEE_OTHER, "{page}");
        assert_eq!(
            flash(&headers).map(|f| f.flash_type).as_deref(),
            Some("error"),
            "{form}"
        );
    }
    assert!(calls_to(&app, "/admin/users/1/visionary").is_empty());

    let (status, headers, page) = post(
        &app,
        "/users/1",
        grant,
        "slot=1&audit_log_reason=Epha+is+number+one",
    )
    .await;
    assert_eq!(status, StatusCode::SEE_OTHER, "{page}");
    let calls = calls_to(&app, "/admin/users/1/visionary");
    assert_eq!(calls.len(), 1, "{calls:?}");
    assert_eq!(calls[0].method, Method::POST);
    assert_eq!(calls[0].body, json!({"slot": 1}));
    assert_eq!(calls[0].reason.as_deref(), Some("Epha is number one"));
    let flash_data = flash(&headers).expect("no flash");
    assert_eq!(flash_data.flash_type, "success");
    assert_eq!(flash_data.message, "Gave Visionary #1 to 1.");

    app.api.lock().unwrap().calls.clear();
    let (_, _, _) = post(&app, "/users/1", grant, "slot=&audit_log_reason=Gift").await;
    let calls = calls_to(&app, "/admin/users/1/visionary");
    assert_eq!(calls.len(), 1, "{calls:?}");
    assert_eq!(calls[0].body, json!({}));

    app.api.lock().unwrap().calls.clear();
    let revoke = "/users/1?action=revoke_visionary&tab=overview";
    let (_, headers, _) = post(&app, "/users/1", revoke, "audit_log_reason=").await;
    assert_eq!(
        flash(&headers).map(|f| f.flash_type).as_deref(),
        Some("error")
    );
    assert!(calls_to(&app, "/admin/users/1/visionary").is_empty());
    let (status, headers, page) =
        post(&app, "/users/1", revoke, "audit_log_reason=Refund+42").await;
    assert_eq!(status, StatusCode::SEE_OTHER, "{page}");
    let calls = calls_to(&app, "/admin/users/1/visionary");
    assert_eq!(calls.len(), 1, "{calls:?}");
    assert_eq!(calls[0].method, Method::DELETE);
    assert_eq!(calls[0].reason.as_deref(), Some("Refund 42"));
    assert_eq!(
        flash(&headers).map(|f| f.message).as_deref(),
        Some("Took Visionary #3 back from 1; the number is retired.")
    );
}

#[tokio::test]
async fn giving_a_taken_number_shows_why() {
    let app = setup(&["*"]).await;
    let (status, headers, page) = post(
        &app,
        "/users/1",
        "/users/1?action=grant_visionary&tab=overview",
        "slot=5&audit_log_reason=Gift",
    )
    .await;
    assert_eq!(status, StatusCode::SEE_OTHER, "{page}");
    let flash = flash(&headers).expect("no flash");
    assert_eq!(flash.flash_type, "error");
    assert_eq!(
        flash.message,
        "Number 5 is taken or does not exist, or no number is free. Raise the total on the Shop page first."
    );
}

async fn mock_api(
    State(api): State<Shared>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let path = uri.path().to_owned();
    let request: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let mut api = api.lock().unwrap();
    api.calls.push(Call {
        method: method.clone(),
        path: path.clone(),
        reason: headers
            .get("x-audit-log-reason")
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned),
        body: request.clone(),
    });
    let manages_cosmetics = api
        .acls
        .iter()
        .any(|acl| acl == "*" || acl == "cosmetics:manage");
    let manages_badges = api
        .acls
        .iter()
        .any(|acl| acl == "*" || acl == "badges:manage");
    match (method, path.as_str()) {
        (Method::GET, "/admin/users/@me") => {
            json_response(json!({ "user": user("1500000000000000000", &api.acls, None) }))
        }
        (Method::GET, "/admin/users/1") => {
            json_response(json!({ "users": [user("1", &[], api.lifetime_sequence)] }))
        }
        (Method::GET, "/admin/instance/config") => json_response(instance_config()),
        (Method::GET, "/admin/cosmetics/items") if manages_cosmetics => json_response(json!([
            item("7", "avatar_ultra", "Yitik Melek", "owned"),
            item("8", "nameplate", "Free plate", "free"),
            item("9", "avatar_decoration", "Altin Hale", "owned"),
            item("11", "profile_effect", "Kanat Izi", "owned"),
        ])),
        (Method::GET, "/admin/cosmetics/items") => StatusCode::FORBIDDEN.into_response(),
        (Method::GET, "/admin/badges") if manages_badges => json_response(json!([
            {"id": "21", "icon": "abcd1234", "description": "Erken Plus"},
            {"id": "22", "icon": "abcd1234", "description": "Öncü #{n}"},
        ])),
        (Method::GET, "/admin/badges") => StatusCode::FORBIDDEN.into_response(),
        (Method::GET, "/admin/shop") => {
            json_response(shop_admin(api.early_plus_open, api.early_plus_opened_once))
        }
        (Method::GET, "/admin/shop/visionary") => json_response(api.stock.clone().unwrap_or_else(
            || json!({"total": 10, "sold": 3, "held": 1, "remaining": 6, "over_cap_grants": 0}),
        )),
        (Method::PUT, "/admin/shop/visionary/slots") if api.shrink_refused => (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "code": "CANNOT_SHRINK_RESERVED_SLOTS",
                "message": "Cannot shrink reserved slots"
            })),
        )
            .into_response(),
        (Method::PUT, "/admin/shop/visionary/slots") => json_response(json!({
            "total": request["total"], "sold": 3, "held": 1, "remaining": 6, "over_cap_grants": 0
        })),
        (Method::PATCH, "/admin/shop/settings") => json_response(
            shop_admin(api.early_plus_open, api.early_plus_opened_once)["settings"].clone(),
        ),
        (Method::PUT, "/admin/shop/prices")
        | (Method::POST, "/admin/shop/campaigns" | "/admin/shop/campaigns/remove") => {
            json_response(shop_admin(api.early_plus_open, api.early_plus_opened_once))
        }
        (Method::POST, "/admin/users/1/visionary") if request["slot"] == 5 => (
            StatusCode::NOT_FOUND,
            Json(json!({
                "code": "SHOP_ITEM_UNAVAILABLE",
                "message": "This can't be bought right now."
            })),
        )
            .into_response(),
        (Method::POST, "/admin/users/1/visionary") => json_response(json!({
            "user_id": "1",
            "slot": request["slot"].as_i64().unwrap_or(4),
            "lifetime": true,
            "changed": true
        })),
        (Method::DELETE, "/admin/users/1/visionary") => json_response(json!({
            "user_id": "1", "slot": 3, "lifetime": false, "changed": true
        })),
        _ => (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" }))).into_response(),
    }
}

fn json_response(value: Value) -> Response {
    Json(value).into_response()
}

fn price(sku: &str, base: i32, campaign: Option<i32>, sale: i32) -> Value {
    json!({
        "sku": sku,
        "base_try_minor": base,
        "campaign_percent": campaign,
        "campaign_ends_at": null,
        "now": {
            "base_try_minor": base,
            "campaign_percent": campaign,
            "campaign_ends_at": null,
            "sale_try_minor": sale,
            "premium_try_minor": null
        }
    })
}

fn shop_admin(early_plus_open: bool, early_plus_opened_once: bool) -> Value {
    json!({
        "settings": {
            "premium_sales_open": true,
            "item_sales_open": true,
            "premium_discount_percent": 30,
            "payment_provider_configured": true,
            "visionary_on_sale": false,
            "visionary_reward_item_ids": ["9"],
            "early_plus_badge_id": (early_plus_open || early_plus_opened_once).then_some("21"),
            "early_plus_open": early_plus_open,
            "early_plus_opened_once": early_plus_open || early_plus_opened_once
        },
        "prices": [
            price("cosmetic:7", 500, None, 500),
            price("visionary", 125_050, Some(10), 112_545)
        ],
        "health": {
            "busy_refusals_last_hour": 0,
            "reconcile_lag_seconds": 0,
            "provider_backing_off": false
        }
    })
}

fn item(id: &str, item_type: &str, name: &str, availability: &str) -> Value {
    json!({
        "id": id,
        "type": item_type,
        "name": name,
        "description": null,
        "asset": "0a1b2c3d",
        "availability": availability
    })
}

fn user(id: &str, acls: &[String], lifetime_sequence: Option<i32>) -> Value {
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
        "premium_type": lifetime_sequence.map(|_| 2),
        "premium_since": null,
        "premium_until": null,
        "premium_grace_ends_at": null,
        "premium_lifetime_sequence": lifetime_sequence,
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
