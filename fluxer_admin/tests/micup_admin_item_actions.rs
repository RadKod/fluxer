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
    config::{AdminConfig, ProxyConfig, RuntimeEnv},
    middleware::flash::{FlashData, parse_flash},
    session,
};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;
use tower::ServiceExt;

const SECRET_KEY: &str = "micup-admin-item-actions-test-secret";
const END_PREMIUM_WARNING: &str = "Ends all Plus time now: bought, from a gift code and from the \
                                   free trial. The trial cannot be taken again. Use this after \
                                   refunding a Plus payment in Payriff.";

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
    worn: bool,
    issued: u64,
    // None answers a paid end far in the future.
    previous_paid_until: Option<Value>,
    // The ultra item carries a 24-frame in-front set.
    front: bool,
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

fn flash_type(headers: &HeaderMap) -> Option<String> {
    flash(headers).map(|flash| flash.flash_type)
}

fn api_calls_to(app: &TestApp, path: &str) -> Vec<Call> {
    app.api
        .lock()
        .unwrap()
        .calls
        .iter()
        .filter(|call| call.path == path)
        .cloned()
        .collect()
}

fn api_call(app: &TestApp, method: &Method, path: &str) -> Option<Call> {
    api_calls_to(app, path)
        .into_iter()
        .find(|call| call.method == *method)
}

#[tokio::test]
async fn cosmetics_page_links_sizes_and_offers_owned_items() {
    let app = setup(&["*"]).await;
    let (status, _, page) = get(&app, "/cosmetics").await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert!(
        page.contains(r#"href="/cosmetics?ultra=7#ultra""#),
        "{page}"
    );
    assert!(page.contains("/cosmetics?action=grant"), "{page}");
    assert!(page.contains("/cosmetics?action=revoke"), "{page}");
    assert!(page.contains("Yitik Melek (Ultra decoration)"), "{page}");
    assert!(!page.contains("Free plate (Nameplate)"), "{page}");
    let (status, _, page) = get(&app, "/cosmetics?ultra=7").await;
    assert_eq!(status, StatusCode::OK, "{page}");
    for name in ["compact_width", "voice_offset_x", "profile_offset_y"] {
        assert!(
            page.contains(&format!(r#"name="{name}""#)),
            "{name}: {page}"
        );
    }
    assert!(page.contains("/cosmetics?action=ultra_reset"), "{page}");
    assert!(
        page.contains("Yitik Melek and Kuzgun keep their look."),
        "{page}"
    );
}

#[tokio::test]
async fn give_item_sends_the_reason_header_and_reports_the_result() {
    let app = setup(&["*"]).await;
    let (status, headers, body) = post(
        &app,
        "/cosmetics",
        "/cosmetics?action=grant",
        "user_id=1&item_id=7&audit_log_reason=Refund+42",
    )
    .await;
    assert_eq!(status, StatusCode::SEE_OTHER, "{body}");
    let call = api_call(&app, &Method::POST, "/admin/users/1/cosmetics/7").expect("no grant call");
    assert_eq!(call.reason.as_deref(), Some("Refund 42"));
    let flash = flash(&headers).expect("no flash");
    assert_eq!(flash.flash_type, "success");
    assert_eq!(flash.message, "Gave Yitik Melek to 1.");
}

#[tokio::test]
async fn give_item_without_a_reason_is_refused_before_the_api() {
    let app = setup(&["*"]).await;
    let long_reason = "a".repeat(513);
    let forms = [
        "user_id=1&item_id=7".to_owned(),
        "user_id=1&item_id=7&audit_log_reason=+++".to_owned(),
        format!("user_id=1&item_id=7&audit_log_reason={long_reason}"),
        // The reason travels in an HTTP header, which carries ASCII only.
        "user_id=1&item_id=7&audit_log_reason=%C4%B0ade".to_owned(),
    ];
    for form in &forms {
        let (status, headers, body) =
            post(&app, "/cosmetics", "/cosmetics?action=grant", form).await;
        assert_eq!(status, StatusCode::SEE_OTHER, "{body}");
        assert_eq!(flash_type(&headers).as_deref(), Some("error"), "{form}");
    }
    assert!(api_calls_to(&app, "/admin/users/1/cosmetics/7").is_empty());
}

#[tokio::test]
async fn take_back_reports_that_a_worn_item_was_taken_off() {
    let app = setup(&["*"]).await;
    app.api.lock().unwrap().worn = true;
    let (status, headers, body) = post(
        &app,
        "/cosmetics",
        "/cosmetics?action=revoke",
        "user_id=1&item_id=7&audit_log_reason=Refund+42",
    )
    .await;
    assert_eq!(status, StatusCode::SEE_OTHER, "{body}");
    let call =
        api_call(&app, &Method::DELETE, "/admin/users/1/cosmetics/7").expect("no take back call");
    assert_eq!(call.reason.as_deref(), Some("Refund 42"));
    assert_eq!(
        flash(&headers).map(|flash| flash.message).as_deref(),
        Some("Took Yitik Melek back from 1; it was worn and has been taken off.")
    );
}

#[tokio::test]
async fn ultra_size_sends_multiples_and_blank_surfaces_as_null() {
    let app = setup(&["*"]).await;
    let form = "item_id=7&compact_width=2.30&compact_height=2.30&compact_offset_x=0\
                &compact_offset_y=0.10&voice_width=&voice_height=&voice_offset_x=&voice_offset_y=";
    let (status, headers, body) =
        post(&app, "/cosmetics?ultra=7", "/cosmetics?action=ultra", form).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "{body}");
    let call = api_call(&app, &Method::PATCH, "/admin/cosmetics/items/7").expect("no size call");
    assert_eq!(
        call.body,
        json!({"ultra_layout": {
            "compact": {"width": 2.3, "height": 2.3, "offset_x": 0.0, "offset_y": 0.1},
            "voice": null,
            "profile": null
        }})
    );
    assert_eq!(flash_type(&headers).as_deref(), Some("success"));
}

#[tokio::test]
async fn ultra_size_with_a_half_filled_surface_is_refused() {
    let app = setup(&["*"]).await;
    let (_, headers, _) = post(
        &app,
        "/cosmetics",
        "/cosmetics?action=ultra",
        "item_id=7&voice_width=3.20&voice_height=3.20",
    )
    .await;
    let flash = flash(&headers).expect("no flash");
    assert_eq!(flash.flash_type, "error");
    assert_eq!(flash.message, "Fill all four numbers of Voice tile or none");
    assert!(api_calls_to(&app, "/admin/cosmetics/items/7").is_empty());
}

#[tokio::test]
async fn ultra_reset_sends_null() {
    let app = setup(&["*"]).await;
    let (status, headers, body) = post(
        &app,
        "/cosmetics?ultra=7",
        "/cosmetics?action=ultra_reset",
        "item_id=7&compact_width=2.30",
    )
    .await;
    assert_eq!(status, StatusCode::SEE_OTHER, "{body}");
    let call = api_call(&app, &Method::PATCH, "/admin/cosmetics/items/7").expect("no reset call");
    assert_eq!(call.body, json!({"ultra_layout": null}));
    assert_eq!(flash_type(&headers).as_deref(), Some("success"));
}

const SIZES_ONLY_BEHIND: &str = "This item is drawn in front at a fixed 3.468 \u{d7} the avatar; \
                                 these sizes apply only when it is drawn behind.";

fn data_url(payload: &str) -> String {
    format!("data:image/webp;base64,{payload}")
}

#[tokio::test]
async fn front_form_sends_the_full_set_in_one_patch() {
    let app = setup(&["*"]).await;
    let [closed, first, second, idle] = ["Q0w=", "MDA=", "MDE=", "SUQ="].map(data_url);
    let form = format!(
        "item_id=7&closed={}&open={}&open={}&idle={}",
        urlencoding::encode(&closed),
        urlencoding::encode(&first),
        urlencoding::encode(&second),
        urlencoding::encode(&idle)
    );
    let (status, headers, body) = post(
        &app,
        "/cosmetics?ultra=7",
        "/cosmetics?action=ultra_front",
        &form,
    )
    .await;
    assert_eq!(status, StatusCode::SEE_OTHER, "{body}");
    let calls = api_calls_to(&app, "/admin/cosmetics/items/7");
    assert_eq!(calls.len(), 1, "{calls:?}");
    assert_eq!(calls[0].method, Method::PATCH);
    assert_eq!(
        calls[0].body,
        json!({"ultra_front": {"closed": closed, "open": [first, second], "idle": idle}})
    );
    assert_eq!(flash_type(&headers).as_deref(), Some("success"));
}

#[tokio::test]
async fn front_form_with_one_frame_never_reaches_the_api() {
    let app = setup(&["*"]).await;
    let form = format!(
        "item_id=7&closed={0}&open={0}&idle={0}",
        urlencoding::encode(&data_url("QQ=="))
    );
    let (_, headers, _) = post(&app, "/cosmetics", "/cosmetics?action=ultra_front", &form).await;
    let flash = flash(&headers).expect("no flash");
    assert_eq!(
        (flash.flash_type.as_str(), flash.message.as_str()),
        ("error", "Upload 2-30 opening frames")
    );
    assert!(api_calls_to(&app, "/admin/cosmetics/items/7").is_empty());
}

#[tokio::test]
async fn front_reset_sends_null() {
    let app = setup(&["*"]).await;
    let (status, headers, body) = post(
        &app,
        "/cosmetics?ultra=7",
        "/cosmetics?action=ultra_front_reset",
        "item_id=7",
    )
    .await;
    assert_eq!(status, StatusCode::SEE_OTHER, "{body}");
    let call = api_call(&app, &Method::PATCH, "/admin/cosmetics/items/7").expect("no reset call");
    assert_eq!(call.body, json!({"ultra_front": null}));
    assert_eq!(flash_type(&headers).as_deref(), Some("success"));
}

#[tokio::test]
async fn relist_sends_on_sale_true() {
    let app = setup(&["*"]).await;
    let (status, _, page) = get(&app, "/cosmetics").await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert!(page.contains("/cosmetics?action=relist"), "{page}");
    // Every item is offered: the catalog does not say which ones are off sale.
    assert!(page.contains("Free plate (8)"), "{page}");
    let (status, headers, body) =
        post(&app, "/cosmetics", "/cosmetics?action=relist", "item_id=7").await;
    assert_eq!(status, StatusCode::SEE_OTHER, "{body}");
    let call = api_call(&app, &Method::PATCH, "/admin/cosmetics/items/7").expect("no relist call");
    assert_eq!(call.body, json!({"on_sale": true}));
    assert_eq!(
        flash(&headers).map(|flash| flash.message).as_deref(),
        Some("Yitik Melek is back on sale as an owned item")
    );
}

#[tokio::test]
async fn ultra_card_shows_the_front_state() {
    let app = setup(&["*"]).await;
    let (status, _, page) = get(&app, "/cosmetics?ultra=7").await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert!(page.contains("Front: none (drawn behind)"), "{page}");
    assert!(
        page.contains(r#"action="/cosmetics?action=ultra_front""#),
        "{page}"
    );
    for field in [
        r#"name="closed""#,
        r#"name="idle""#,
        r#"data-base64-name="open""#,
        r#"id="cosmetic-front-open" multiple"#,
    ] {
        assert!(page.contains(field), "{field}: {page}");
    }
    app.api.lock().unwrap().front = true;
    let (_, _, page) = get(&app, "/cosmetics?ultra=7").await;
    assert!(
        page.contains("Front: 24 opening frames, drawn in front"),
        "{page}"
    );
    assert!(
        page.contains("/cosmetics?action=ultra_front_reset"),
        "{page}"
    );
}

#[tokio::test]
async fn front_items_note_that_sizes_apply_only_behind() {
    let app = setup(&["*"]).await;
    let (_, _, page) = get(&app, "/cosmetics?ultra=7").await;
    assert!(!page.contains(SIZES_ONLY_BEHIND), "{page}");
    app.api.lock().unwrap().front = true;
    let (_, _, page) = get(&app, "/cosmetics?ultra=7").await;
    assert!(page.contains(SIZES_ONLY_BEHIND), "{page}");
}

#[tokio::test]
async fn item_codes_are_generated_in_chunks_of_one_hundred_with_an_item_csv() {
    let app = setup(&["*"]).await;
    let (status, _, page) = get(&app, "/gift-codes").await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert!(page.contains(r#"value="cosmetic""#), "{page}");
    assert!(page.contains("Yitik Melek (Ultra decoration)"), "{page}");
    assert!(!page.contains("Free plate"), "{page}");
    let (status, headers, body) = post(
        &app,
        "/gift-codes",
        "/gift-codes",
        "gives=cosmetic&item_id=7&count=250&duration_type=months&duration_quantity=1&format=csv",
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let calls = api_calls_to(&app, "/admin/gift-codes/cosmetic");
    let counts: Vec<u64> = calls
        .iter()
        .map(|call| call.body["count"].as_u64().unwrap())
        .collect();
    assert_eq!(counts, vec![100, 100, 50]);
    assert!(
        calls.iter().all(|call| call.body["item_id"] == "7"),
        "{calls:?}"
    );
    assert!(api_calls_to(&app, "/admin/gift-codes").is_empty());
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    assert!(content_type.starts_with("text/csv"), "{content_type}");
    let lines: Vec<&str> = body.lines().collect();
    assert_eq!(lines[0], "code,url,item_id,item_name,created_at");
    assert_eq!(lines.len(), 251, "{body}");
    let row: Vec<&str> = lines[1].split(',').collect();
    assert_eq!(row.len(), 5, "{}", lines[1]);
    assert!(row[1].ends_with(&format!("/{}", row[0])), "{}", lines[1]);
    assert_eq!((row[2], row[3]), ("7", "Yitik Melek"));
}

#[tokio::test]
async fn item_code_option_is_hidden_without_cosmetics_manage() {
    let app = setup(&["admin:authenticate", "gift_codes:generate"]).await;
    let (status, _, page) = get(&app, "/gift-codes").await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert!(!page.contains("Cosmetic item"), "{page}");
    assert!(!page.contains(r#"name="gives""#), "{page}");
    assert!(page.contains(r#"name="duration_type""#), "{page}");
    let (_, _, body) = post(
        &app,
        "/gift-codes",
        "/gift-codes",
        "gives=cosmetic&item_id=7&count=5&duration_type=months&duration_quantity=1",
    )
    .await;
    assert!(
        api_calls_to(&app, "/admin/gift-codes/cosmetic").is_empty(),
        "{body}"
    );
    // An item request never falls back to premium codes.
    assert!(api_calls_to(&app, "/admin/gift-codes").is_empty(), "{body}");
}

#[tokio::test]
async fn premium_codes_page_is_unchanged() {
    let app = setup(&["*"]).await;
    let forms = [
        "count=3&duration_type=weeks&duration_quantity=2&format=csv",
        "gives=premium&item_id=7&count=3&duration_type=weeks&duration_quantity=2&format=csv",
    ];
    for form in forms {
        let (status, _, body) = post(&app, "/gift-codes", "/gift-codes", form).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let lines: Vec<&str> = body.lines().collect();
        assert_eq!(
            lines[0],
            "code,url,duration_type,duration_quantity,created_at"
        );
        assert_eq!(lines.len(), 4, "{body}");
        let row: Vec<&str> = lines[1].split(',').collect();
        assert_eq!((row[2], row[3]), ("weeks", "2"), "{}", lines[1]);
    }
    let calls = api_calls_to(&app, "/admin/gift-codes");
    assert_eq!(calls.len(), 2);
    for call in calls {
        assert_eq!(call.body["count"], 3);
        assert_eq!(call.body["duration_type"], "weeks");
        assert_eq!(call.body["duration_quantity"], 2);
    }
    assert!(api_calls_to(&app, "/admin/gift-codes/cosmetic").is_empty());
    let (status, _, page) = get(&app, "/gift-codes").await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert!(page.contains(r#"name="duration_quantity""#), "{page}");
    assert!(page.contains("Generate and download CSV"), "{page}");
}

#[tokio::test]
async fn end_premium_needs_a_reason_and_posts_to_the_premium_end_route() {
    let app = setup(&["*"]).await;
    let uri = "/users/1?action=end_premium&tab=overview";
    let (status, headers, body) = post(&app, "/users/1", uri, "audit_log_reason=").await;
    assert_eq!(status, StatusCode::SEE_OTHER, "{body}");
    assert_eq!(flash_type(&headers).as_deref(), Some("error"));
    assert!(api_calls_to(&app, "/admin/users/1/premium/end").is_empty());
    let (status, headers, body) = post(&app, "/users/1", uri, "audit_log_reason=Refund+42").await;
    assert_eq!(status, StatusCode::SEE_OTHER, "{body}");
    let call =
        api_call(&app, &Method::POST, "/admin/users/1/premium/end").expect("no premium end call");
    assert_eq!(call.reason.as_deref(), Some("Refund 42"));
    assert_eq!(flash_type(&headers).as_deref(), Some("success"));
}

#[tokio::test]
async fn end_premium_says_what_it_ended() {
    let app = setup(&["*"]).await;
    let uri = "/users/1?action=end_premium&tab=overview";
    let (_, headers, body) = post(&app, "/users/1", uri, "audit_log_reason=Refund+42").await;
    let ended = flash(&headers).unwrap_or_else(|| panic!("no flash\n{body}"));
    assert_eq!(
        (ended.flash_type.as_str(), ended.message.as_str()),
        (
            "success",
            "Plus ended; it was paid until Dec 1, 2999, 12:00 AM UTC."
        )
    );
    for previous in [Value::Null, json!("2020-01-01T00:00:00.000Z")] {
        app.api.lock().unwrap().previous_paid_until = Some(previous.clone());
        let (_, headers, body) = post(&app, "/users/1", uri, "audit_log_reason=Refund+42").await;
        let nothing = flash(&headers).unwrap_or_else(|| panic!("no flash\n{body}"));
        assert_eq!(
            (nothing.flash_type.as_str(), nothing.message.as_str()),
            ("info", "Nothing to end: no paid Plus time was left."),
            "{previous}"
        );
    }
}

#[tokio::test]
async fn end_premium_form_warns_that_it_ends_every_kind_of_premium() {
    let app = setup(&["*"]).await;
    let (status, _, page) = get(&app, "/users/1?tab=overview").await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert!(page.contains(END_PREMIUM_WARNING), "{page}");
    assert!(page.contains("action=end_premium"), "{page}");
    let app = setup(&["admin:authenticate"]).await;
    let (status, _, page) = get(&app, "/users/1?tab=overview").await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert!(!page.contains(END_PREMIUM_WARNING), "{page}");
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
    match (method, path.as_str()) {
        (Method::GET, "/admin/users/@me") => {
            json_response(json!({ "user": user("1500000000000000000", &api.acls) }))
        }
        (Method::GET, "/admin/users/1") => json_response(json!({ "users": [user("1", &[])] })),
        (Method::GET, "/admin/instance/config") => json_response(instance_config()),
        (Method::GET, "/admin/cosmetics/items") if manages_cosmetics => {
            json_response(json!([ultra_item(api.front), free_item()]))
        }
        (Method::GET, "/admin/cosmetics/items") => StatusCode::FORBIDDEN.into_response(),
        (Method::POST, "/admin/users/1/cosmetics/7") => json_response(json!({
            "item_id": "7",
            "owned": true,
            "equipped": true,
            "changed": true,
            "unequipped": false
        })),
        (Method::DELETE, "/admin/users/1/cosmetics/7") => json_response(json!({
            "item_id": "7",
            "owned": false,
            "equipped": false,
            "changed": true,
            "unequipped": api.worn
        })),
        (Method::PATCH, "/admin/cosmetics/items/7") => {
            let mut item = ultra_item(api.front);
            item["ultra_layout"] = request["ultra_layout"].clone();
            json_response(item)
        }
        (Method::POST, "/admin/gift-codes" | "/admin/gift-codes/cosmetic") => {
            let count = request["count"].as_u64().unwrap();
            let codes: Vec<String> = (api.issued..api.issued + count)
                .map(|n| format!("https://gift.example.test/CODE{n:028}"))
                .collect();
            api.issued += count;
            json_response(json!({ "codes": codes }))
        }
        (Method::POST, "/admin/users/1/premium/end") => json_response(json!({
            "previous_paid_until": api
                .previous_paid_until
                .clone()
                .unwrap_or_else(|| json!("2999-12-01T00:00:00.000Z")),
            "paid_until": "2026-09-28T19:00:00.000Z"
        })),
        _ => (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" }))).into_response(),
    }
}

fn json_response(value: Value) -> Response {
    Json(value).into_response()
}

fn ultra_item(front: bool) -> Value {
    let mut item = json!({
        "id": "7",
        "type": "avatar_ultra",
        "name": "Yitik Melek",
        "description": null,
        "asset": "0a1b2c3d",
        "availability": "owned",
        "ultra_layout": null
    });
    if front {
        let open: Vec<String> = (0..24).map(|n| format!("0b{n:06x}")).collect();
        item["ultra_front"] = json!({"closed": "0b000000", "open": open, "idle": "a_0c1d2e3f"});
    }
    item
}

fn free_item() -> Value {
    json!({
        "id": "8",
        "type": "nameplate",
        "name": "Free plate",
        "description": null,
        "asset": "0a1b2c3e",
        "availability": "free"
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
        env: RuntimeEnv::Test,
        host: "127.0.0.1".to_owned(),
        port: 0,
        secret_key_base: SECRET_KEY.to_owned(),
        base_path: String::new(),
        api_endpoint,
        media_endpoint: "https://media.example.test".to_owned(),
        static_cdn_endpoint: "https://static.example.test".to_owned(),
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
