// SPDX-License-Identifier: AGPL-3.0-or-later

use axum::{
    Json, Router,
    body::{Body, Bytes, to_bytes},
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, Method, Request, StatusCode, Uri, header},
    response::{IntoResponse, Response},
};
use base64::Engine;
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

const SECRET_KEY: &str = "micup-admin-pages-test-secret";
const XSS: &str = "<script>alert(1)</script>";

#[derive(Default)]
struct MockApi {
    acls: Vec<String>,
    premium_mode: &'static str,
    gift_code_calls: Vec<u64>,
    cosmetic_creates: Vec<Value>,
    cosmetic_patches: Vec<Value>,
    requests: Vec<(Method, String)>,
    shop_health: Option<Value>,
    shop_settings: Option<Value>,
    shop_writes: Vec<Value>,
}

type Shared = Arc<Mutex<MockApi>>;

struct TestApp {
    router: Router,
    session_cookie: String,
    api: Shared,
}

async fn setup(acls: &[&str], self_hosted: bool, premium_mode: &'static str) -> TestApp {
    let api: Shared = Arc::new(Mutex::new(MockApi {
        acls: acls.iter().map(|acl| (*acl).to_owned()).collect(),
        premium_mode,
        ..MockApi::default()
    }));
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let addr = listener.local_addr().unwrap();
    // The API side takes a full in-front set (about 3 MB of JSON); axum's 2 MB default would answer 413.
    let mock = Router::new()
        .fallback(mock_api)
        .layer(DefaultBodyLimit::disable())
        .with_state(api.clone());
    tokio::spawn(async move { axum::serve(listener, mock).await.unwrap() });
    let router = build_router(test_config(format!("http://{addr}"), self_hosted));
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

fn location(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::LOCATION)
        .and_then(|value| value.to_str().ok())
}

fn api_requests(app: &TestApp) -> Vec<(Method, String)> {
    app.api.lock().unwrap().requests.clone()
}

fn shop_writes(app: &TestApp) -> Vec<Value> {
    app.api.lock().unwrap().shop_writes.clone()
}

fn flash_message(headers: &HeaderMap) -> Option<String> {
    flash_data(headers).map(|flash| flash.message)
}

fn flash_data(headers: &HeaderMap) -> Option<flash::FlashData> {
    headers
        .get_all(header::SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .find_map(|value| value.split(';').next()?.strip_prefix("flash="))
        .and_then(flash::parse_flash)
}

fn bundle_calls(app: &TestApp) -> Vec<(Method, String)> {
    api_requests(app)
        .into_iter()
        .filter(|(_, path)| path.starts_with("/admin/shop/bundles"))
        .collect()
}

// URL encoding random-like base64 grows the form as it does for a real image.
fn image_data_url(bytes: usize) -> String {
    let mut state: u64 = 0x9E37_79B9_7F4A_7C15;
    let image: Vec<u8> = (0..bytes)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state >> 24) as u8
        })
        .collect();
    format!(
        "data:image/webp;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(image)
    )
}

fn create_form(asset: &str) -> String {
    format!(
        "type=avatar_ultra&availability=premium&name=Yitik+Melek&asset={}",
        urlencoding::encode(asset)
    )
}

#[tokio::test]
async fn new_pages_are_forbidden_without_their_acl() {
    let app = setup(&["admin:authenticate", "report:view"], false, "everyone").await;
    for page in ["/cosmetics", "/badges", "/feed-moderation", "/shop"] {
        let (status, _, body) = get(&app, page).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{page}: {body}");
    }
    let posts = [
        ("/cosmetics", "/cosmetics?action=retire", "item_id=1"),
        ("/badges", "/badges?action=grant", "user_id=1&badge_id=2"),
        (
            "/feed-moderation",
            "/feed-moderation?action=delete-post",
            "post_id=1",
        ),
        (
            "/shop",
            "/shop?action=remove_campaign",
            "product_ids=premium:1",
        ),
    ];
    for (page, uri, form) in posts {
        let (status, _, body) = post(&app, page, uri, form).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{uri}: {body}");
    }
    let touched: Vec<_> = api_requests(&app)
        .into_iter()
        .filter(|(_, path)| !path.starts_with("/admin/users/@me"))
        .collect();
    assert!(touched.is_empty(), "API called without ACL: {touched:?}");
}

#[tokio::test]
async fn new_pages_open_with_their_acl() {
    let app = setup(
        &[
            "admin:authenticate",
            "cosmetics:manage",
            "badges:manage",
            "feed:moderate",
            "shop:manage",
        ],
        false,
        "everyone",
    )
    .await;
    for page in ["/cosmetics", "/badges", "/feed-moderation", "/shop"] {
        let (status, _, body) = get(&app, page).await;
        assert_eq!(status, StatusCode::OK, "{page}: {body}");
        assert!(body.contains(r#"id="admin-sidebar""#), "{page}: {body}");
        assert!(body.contains(r#"href="/shop""#), "{page}: {body}");
    }
}

#[tokio::test]
async fn catalog_pages_escape_api_text() {
    let app = setup(&["*"], false, "everyone").await;
    for page in ["/cosmetics", "/badges"] {
        let (status, _, body) = get(&app, page).await;
        assert_eq!(status, StatusCode::OK, "{page}: {body}");
        assert!(
            !body.contains(XSS),
            "{page} rendered unescaped API text\n{body}"
        );
        assert!(
            body.contains("&lt;script&gt;alert(1)&lt;/script&gt;"),
            "{page} did not render the escaped text\n{body}"
        );
    }
}

#[tokio::test]
async fn cosmetics_form_offers_avatar_ultra() {
    let app = setup(&["*"], false, "everyone").await;
    let (status, _, page) = get(&app, "/cosmetics").await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert!(page.contains(r#"value="avatar_ultra""#), "{page}");
    assert!(page.contains("1,228,800 bytes"), "{page}");
}

#[tokio::test]
async fn cosmetics_form_takes_an_ultra_image_at_the_size_limit() {
    let app = setup(&["*"], false, "everyone").await;
    let asset = image_data_url(1_228_800);
    let form = create_form(&asset);
    assert!(
        form.len() > 1_700_000 && form.len() < 2 * 1024 * 1024,
        "{}",
        form.len()
    );
    let (status, _, body) = post(&app, "/cosmetics", "/cosmetics?action=create", &form).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "{body}");
    let sent = app.api.lock().unwrap().cosmetic_creates.clone();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0]["type"], "avatar_ultra");
    assert_eq!(sent[0]["asset"].as_str().map(str::len), Some(asset.len()));
}

const COSMETIC_FORM_MAX_BYTES: usize = 3 * 1024 * 1024;

// A create form whose whole request body, "_csrf=<token>&" included, is `total` bytes long.
async fn create_body_of(app: &TestApp, total: usize) -> String {
    let (_, headers, _) = get(app, "/cosmetics").await;
    let token = csrf_cookie(&headers).expect("no csrf cookie");
    let form = format!("{}&pad=", create_form(&image_data_url(1_228_800)));
    let pad = total - "_csrf=&".len() - token.len() - form.len();
    format!("{form}{}", "a".repeat(pad))
}

#[tokio::test]
async fn cosmetics_form_refuses_a_body_past_three_mebibytes() {
    let app = setup(&["*"], false, "everyone").await;
    let form = create_body_of(&app, COSMETIC_FORM_MAX_BYTES).await;
    let (status, headers, body) = post(&app, "/cosmetics", "/cosmetics?action=create", &form).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "{body}");
    assert_eq!(
        app.api.lock().unwrap().cosmetic_creates.len(),
        1,
        "{:?}",
        flash_message(&headers)
    );
    let form = create_body_of(&app, COSMETIC_FORM_MAX_BYTES + 1).await;
    let (status, headers, body) = post(&app, "/cosmetics", "/cosmetics?action=create", &form).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "{body}");
    assert_eq!(
        flash_message(&headers).as_deref(),
        Some("Invalid form data")
    );
    assert_eq!(
        app.api.lock().unwrap().cosmetic_creates.len(),
        1,
        "an oversized form reached the API"
    );
}

// The largest set the API takes: closed 150 KiB, 500 KiB of opening frames and a 1,500,000 byte loop.
fn front_form(frames: usize) -> String {
    let frame_bytes = 500 * 1024 / frames;
    let open: String = (0..frames)
        .map(|_| {
            format!(
                "&open={}",
                urlencoding::encode(&image_data_url(frame_bytes))
            )
        })
        .collect();
    format!(
        "item_id=7&closed={}{open}&idle={}",
        urlencoding::encode(&image_data_url(150 * 1024)),
        urlencoding::encode(&image_data_url(1_500_000))
    )
}

#[tokio::test]
async fn cosmetics_form_takes_a_front_set_near_three_mebibytes() {
    let app = setup(&["*"], false, "everyone").await;
    let form = front_form(8);
    assert!(
        form.len() > 2_900_000 && form.len() < COSMETIC_FORM_MAX_BYTES - 1024,
        "{}",
        form.len()
    );
    let (status, headers, body) = post(
        &app,
        "/cosmetics?ultra=7",
        "/cosmetics?action=ultra_front",
        &form,
    )
    .await;
    assert_eq!(status, StatusCode::SEE_OTHER, "{body}");
    let patches = app.api.lock().unwrap().cosmetic_patches.clone();
    assert_eq!(patches.len(), 1, "{:?}", flash_message(&headers));
    assert_eq!(
        patches[0]["ultra_front"]["open"].as_array().map(Vec::len),
        Some(8)
    );
}

#[tokio::test]
async fn cosmetics_front_needs_cosmetics_manage_before_the_body_is_read() {
    let app = setup(&["admin:authenticate", "report:view"], false, "everyone").await;
    // Past the route's body limit too: without the ACL the answer is 403, not a form error.
    let form = format!("{}&pad={}", front_form(8), "a".repeat(200_000));
    assert!(form.len() > COSMETIC_FORM_MAX_BYTES, "{}", form.len());
    for (uri, form) in [
        ("/cosmetics?action=ultra_front", form.as_str()),
        ("/cosmetics?action=ultra_front_reset", "item_id=7"),
        ("/cosmetics?action=relist", "item_id=7"),
    ] {
        let (status, _, body) = post(&app, "/cosmetics", uri, form).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{uri}: {body}");
    }
    let touched: Vec<_> = api_requests(&app)
        .into_iter()
        .filter(|(_, path)| !path.starts_with("/admin/users/@me"))
        .collect();
    assert!(touched.is_empty(), "API called without ACL: {touched:?}");
}

#[tokio::test]
async fn feed_post_deletion_calls_the_contract_route() {
    let app = setup(&["*"], false, "everyone").await;
    let (status, headers, body) = post(
        &app,
        "/feed-moderation",
        "/feed-moderation?action=delete-comment",
        "post_id=1700000000000000001&comment_id=1700000000000000002",
    )
    .await;
    assert_eq!(status, StatusCode::SEE_OTHER, "{body}");
    assert_eq!(location(&headers), Some("/feed-moderation"));
    assert!(api_requests(&app).contains(&(
        Method::DELETE,
        "/admin/feed/posts/1700000000000000001/comments/1700000000000000002".to_owned()
    )));
}

#[tokio::test]
async fn reports_list_labels_feed_report_types() {
    let app = setup(&["*"], false, "everyone").await;
    let (status, _, body) = get(&app, "/reports").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body.contains("Feed Post"), "{body}");
    assert!(body.contains("Feed Comment"), "{body}");
}

#[tokio::test]
async fn feed_report_detail_offers_feed_moderation() {
    let app = setup(&["*"], false, "everyone").await;
    let (status, _, body) = get(&app, "/reports/1800000000000000003").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body.contains("Feed Post"), "{body}");
    assert!(body.contains(r#"href="/feed-moderation"#), "{body}");
}

#[tokio::test]
async fn gift_codes_open_on_self_hosted_mirror_instances() {
    let app = setup(&["*"], true, "mirror").await;
    let (status, _, body) = get(&app, "/gift-codes").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body.contains(r#"max="2500""#), "{body}");
    assert!(body.contains("kod-uret.py"), "{body}");
}

#[tokio::test]
async fn gift_codes_redirect_on_self_hosted_everyone_instances() {
    let app = setup(&["*"], true, "everyone").await;
    let (status, headers, body) = get(&app, "/gift-codes").await;
    assert!(status.is_redirection(), "{status}: {body}");
    assert_eq!(location(&headers), Some("/dashboard"));
}

#[tokio::test]
async fn gift_code_csv_is_generated_in_chunks_of_one_hundred() {
    let app = setup(&["*"], true, "mirror").await;
    let (status, headers, body) = post(
        &app,
        "/gift-codes",
        "/gift-codes",
        "count=250&duration_type=months&duration_quantity=1&format=csv",
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(app.api.lock().unwrap().gift_code_calls, vec![100, 100, 50]);
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    assert!(content_type.starts_with("text/csv"), "{content_type}");
    let lines: Vec<&str> = body.lines().collect();
    assert_eq!(
        lines[0],
        "code,url,duration_type,duration_quantity,created_at"
    );
    assert_eq!(lines.len(), 251, "{body}");
    let row: Vec<&str> = lines[1].split(',').collect();
    assert_eq!(row.len(), 5, "{}", lines[1]);
    assert!(row[1].ends_with(&format!("/{}", row[0])), "{}", lines[1]);
    assert_eq!((row[2], row[3]), ("months", "1"));
}

#[tokio::test]
async fn gift_code_count_is_capped_to_fit_the_api_rate_limit() {
    let app = setup(&["*"], false, "everyone").await;
    let (status, _, body) = post(
        &app,
        "/gift-codes",
        "/gift-codes",
        "count=20000&duration_type=days&duration_quantity=7",
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let calls = app.api.lock().unwrap().gift_code_calls.clone();
    // The API's admin:code:generation bucket takes 30 calls a minute; 25 leave room for a retry.
    assert_eq!(calls.len(), 25);
    assert_eq!(calls.iter().sum::<u64>(), 2_500);
}

#[tokio::test]
async fn shop_page_is_forbidden_without_shop_manage() {
    let app = setup(
        &[
            "admin:authenticate",
            "cosmetics:manage",
            "gift_codes:generate",
        ],
        true,
        "mirror",
    )
    .await;
    let (status, _, body) = get(&app, "/shop?order=1490000000000000009").await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    for action in [
        "settings",
        "refresh_try_rate",
        "save_prices",
        "apply_campaign",
        "remove_campaign",
        "bundle_create",
        "bundle_update",
        "bundle_delete",
    ] {
        let uri = format!("/shop?action={action}");
        let form = "rows=premium:1&price_premium:1=1.00&product_ids=premium:1&discount_percent=20\
                    &bundle_id=1600000000000000001&name=Set&item_ids=7&item_ids=8";
        let (status, _, body) = post(&app, "/shop", &uri, form).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{action}: {body}");
    }
    let touched: Vec<_> = api_requests(&app)
        .into_iter()
        .filter(|(_, path)| path.starts_with("/admin/shop"))
        .collect();
    assert!(
        touched.is_empty(),
        "shop API called without SHOP_MANAGE: {touched:?}"
    );
    let (status, _, page) = get(&app, "/cosmetics").await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert!(!page.contains(r#"href="/shop""#), "{page}");
}

#[tokio::test]
async fn shop_settings_form_sends_the_rate_in_millionths() {
    let app = setup(&["*"], true, "mirror").await;
    let (status, headers, body) = post(
        &app,
        "/shop",
        "/shop?action=settings",
        "usd_to_azn_rate=1.7000&premium_discount_percent=30&premium_sales_open=on",
    )
    .await;
    assert_eq!(status, StatusCode::SEE_OTHER, "{body}");
    assert_eq!(location(&headers), Some("/shop"));
    assert!(api_requests(&app).contains(&(Method::PATCH, "/admin/shop/settings".to_owned())));
    assert_eq!(
        shop_writes(&app),
        vec![json!({
            "premium_sales_open": true,
            "item_sales_open": false,
            "usd_to_azn_rate_micro": 1_700_000,
            "premium_discount_percent": 30,
            "try_to_azn_rate_override": null
        })]
    );
}

#[tokio::test]
async fn shop_try_rate_override_sends_decimal_or_null_and_refuses_invalid_rates() {
    let app = setup(&["*"], true, "mirror").await;
    for (rate, expected) in [("0.038765", json!("0.038765")), ("", Value::Null)] {
        let form = format!(
            "usd_to_azn_rate=1.7&premium_discount_percent=30&try_to_azn_rate_override={rate}"
        );
        let (status, _, _) = post(&app, "/shop", "/shop?action=settings", &form).await;
        assert_eq!(status, StatusCode::SEE_OTHER);
        assert_eq!(
            shop_writes(&app).last().unwrap()["try_to_azn_rate_override"],
            expected
        );
    }
    let before = shop_writes(&app).len();
    for rate in ["0", "0.000999", "1.000001", "NaN", "1e-2", "0.0387651"] {
        let form = format!(
            "usd_to_azn_rate=1.7&premium_discount_percent=30&try_to_azn_rate_override={rate}"
        );
        let (_, headers, _) = post(&app, "/shop", "/shop?action=settings", &form).await;
        assert!(flash_message(&headers).unwrap().contains("0.001"));
    }
    assert_eq!(shop_writes(&app).len(), before);
}

#[tokio::test]
async fn shop_try_rate_refresh_requires_csrf_and_queues_the_admin_api() {
    let app = setup(&["*"], true, "mirror").await;
    let request = Request::builder()
        .method(Method::POST)
        .uri("/shop?action=refresh_try_rate")
        .header(header::COOKIE, &app.session_cookie)
        .body(Body::empty())
        .unwrap();
    assert_eq!(send(&app, request).await.0, StatusCode::FORBIDDEN);
    assert!(
        !api_requests(&app)
            .iter()
            .any(|(_, path)| path.ends_with("refresh-try-rate"))
    );
    let (_, _, page) = get(&app, "/shop").await;
    let refresh_form = page
        .split("/shop?action=refresh_try_rate")
        .nth(1)
        .expect("refresh form")
        .split("</form>")
        .next()
        .unwrap();
    assert!(refresh_form.contains("name=\"_csrf\""));
    let (status, headers, _) = post(&app, "/shop", "/shop?action=refresh_try_rate", "").await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    assert!(flash_message(&headers).unwrap().contains("queued"));
    assert!(api_requests(&app).contains(&(
        Method::POST,
        "/admin/shop/settings/refresh-try-rate".to_owned()
    )));
}

#[tokio::test]
async fn shop_try_rate_page_shows_automatic_rate_dates_override_and_stale_warning() {
    let app = setup(&["*"], true, "mirror").await;
    app.api.lock().unwrap().shop_settings = Some(json!({
        "try_to_azn_rate_micro": 38_765,
        "try_rate_date": "2020-01-02",
        "try_rate_fetched_at": "2020-01-03T12:00:00Z",
        "try_to_azn_rate_override_micro": 40_123,
        "try_rate_override_at": "2020-01-04T12:00:00Z"
    }));
    let (status, _, page) = get(&app, "/shop").await;
    assert_eq!(status, StatusCode::OK);
    for expected in [
        "0.038765",
        "2020-01-02",
        "2020-01-03",
        "0.040123",
        "2020-01-04",
        "days old",
        "older than 10 days",
        "~1.3%",
        "Blank uses the automatic rate",
        "Payriff charges AZN; users see TL (CBAR daily rate) and the AZN amount",
    ] {
        assert!(page.contains(expected), "missing {expected}");
    }
}

#[tokio::test]
async fn shop_try_rate_stale_warning_starts_after_ten_baku_calendar_days() {
    let app = setup(&["*"], true, "mirror").await;
    let today = time::OffsetDateTime::now_utc()
        .to_offset(time::UtcOffset::from_hms(4, 0, 0).unwrap())
        .date();
    for days in [10, 11] {
        app.api.lock().unwrap().shop_settings = Some(json!({
            "try_to_azn_rate_micro": 38_765,
            "try_rate_date": (today - time::Duration::days(days)).to_string(),
            "try_rate_fetched_at": time::OffsetDateTime::now_utc().format(&time::format_description::well_known::Rfc3339).unwrap()
        }));
        let (_, _, page) = get(&app, "/shop").await;
        assert_eq!(page.contains("older than 10 days"), days > 10);
    }
}

#[tokio::test]
async fn shop_settings_form_refuses_a_rate_outside_one_to_three() {
    let app = setup(&["*"], true, "mirror").await;
    for rate in ["0.017", "17"] {
        let form = format!("usd_to_azn_rate={rate}&premium_discount_percent=0");
        let (status, headers, body) = post(&app, "/shop", "/shop?action=settings", &form).await;
        assert_eq!(status, StatusCode::SEE_OTHER, "{body}");
        let message = flash_message(&headers).unwrap_or_default();
        assert!(message.contains("1.0000 to 3.0000"), "{rate}: {message}");
    }
    assert!(shop_writes(&app).is_empty());
}

#[tokio::test]
async fn shop_prices_form_sends_only_changed_rows_and_blank_as_null() {
    let app = setup(&["*"], true, "mirror").await;
    let form = "rows=premium:1&rows=premium:3&rows=cosmetic:7\
                &price_premium:1=5.00&price_premium:3=4.99&price_cosmetic:7=\
                &was_premium:1=5.00&was_premium:3=&was_cosmetic:7=5.00";
    let (status, headers, body) = post(&app, "/shop", "/shop?action=save_prices", form).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "{body}");
    assert!(api_requests(&app).contains(&(Method::PUT, "/admin/shop/prices".to_owned())));
    assert_eq!(
        shop_writes(&app),
        vec![json!({ "prices": [
            { "sku": "premium:3", "base_usd_cents": 499 },
            { "sku": "cosmetic:7", "base_usd_cents": null }
        ] })]
    );
    assert_eq!(flash_message(&headers).as_deref(), Some("Saved 2 prices."));
}

// The page was opened while cosmetic:7 had no price; someone priced it since. Saving only the
// premium:1 change must not take cosmetic:7 back out, and saving does not read the shop again.
#[tokio::test]
async fn shop_prices_form_compares_with_the_prices_it_showed() {
    let app = setup(&["*"], true, "mirror").await;
    let (_, _, page) = get(&app, "/shop").await;
    assert!(
        page.contains(r#"name="was_premium:1" value="5.00""#),
        "{page}"
    );
    assert!(page.contains(r#"name="was_premium:3" value="""#), "{page}");
    let form = "rows=premium:1&rows=cosmetic:7\
                &price_premium:1=6.00&was_premium:1=5.00\
                &price_cosmetic:7=&was_cosmetic:7=";
    let shop_reads = |app: &TestApp| {
        api_requests(app)
            .iter()
            .filter(|request| **request == (Method::GET, "/admin/shop".to_owned()))
            .count()
    };
    let reads_before = shop_reads(&app);
    let (status, headers, body) = post(&app, "/shop", "/shop?action=save_prices", form).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "{body}");
    assert_eq!(
        shop_writes(&app),
        vec![json!({ "prices": [{ "sku": "premium:1", "base_usd_cents": 600 }] })]
    );
    assert_eq!(flash_message(&headers).as_deref(), Some("Saved 1 price."));
    // One read is the page load that `post` does for its CSRF token.
    assert_eq!(shop_reads(&app), reads_before + 1);
}

#[tokio::test]
async fn shop_settings_form_refuses_a_rate_the_shop_cannot_show() {
    let app = setup(&["*"], true, "mirror").await;
    let form = "usd_to_azn_rate=1.702345&premium_discount_percent=0";
    let (status, headers, body) = post(&app, "/shop", "/shop?action=settings", form).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "{body}");
    let message = flash_message(&headers).unwrap_or_default();
    assert!(message.contains("at most four decimals"), "{message}");
    assert!(shop_writes(&app).is_empty());
    let (_, _, page) = get(&app, "/shop").await;
    assert!(
        page.contains(r#"name="usd_to_azn_rate" value="1.7000" step="0.0001""#),
        "{page}"
    );
}

#[tokio::test]
async fn shop_campaign_over_two_hundred_products_is_refused_before_the_api() {
    let app = setup(&["*"], true, "mirror").await;
    let many = (1..=201)
        .map(|n| format!("product_ids=cosmetic:{n}"))
        .collect::<Vec<_>>()
        .join("&");
    for action in ["apply_campaign", "remove_campaign"] {
        let uri = format!("/shop?action={action}");
        let form = format!("{many}&discount_percent=20&ends_at=");
        let (status, headers, body) = post(&app, "/shop", &uri, &form).await;
        assert_eq!(status, StatusCode::SEE_OTHER, "{body}");
        assert_eq!(
            flash_message(&headers).as_deref(),
            Some("Select at most 200 products at a time."),
            "{action}"
        );
    }
    assert!(shop_writes(&app).is_empty());
}

// Enter in a campaign field submits the campaign form, never "Save prices".
#[tokio::test]
async fn shop_campaign_fields_are_outside_the_prices_form() {
    let app = setup(&["*"], true, "mirror").await;
    let (status, _, page) = get(&app, "/shop").await;
    assert_eq!(status, StatusCode::OK, "{page}");
    let start = page
        .find(r#"id="shop-prices-form""#)
        .expect("no prices form");
    let end = start
        + page[start..]
            .find("</form>")
            .expect("prices form not closed");
    let prices_form = &page[start..end];
    for field in [
        r#"name="discount_percent""#,
        r#"name="ends_at""#,
        "action=apply_campaign",
        "action=remove_campaign",
    ] {
        assert!(!prices_form.contains(field), "{field}: {prices_form}");
    }
    assert!(page.contains(r#"form id="shop-campaign-form""#), "{page}");
    assert!(
        page.contains(r#"name="product_ids" value="premium:1" form="shop-campaign-form""#),
        "{page}"
    );
}

#[tokio::test]
async fn shop_campaign_end_is_turkey_time_sent_as_utc() {
    let app = setup(&["*"], true, "mirror").await;
    let (status, headers, body) = post(
        &app,
        "/shop",
        "/shop?action=apply_campaign",
        "product_ids=premium:1&product_ids=cosmetic:7&discount_percent=20&ends_at=2026-10-05T23%3A59",
    )
    .await;
    assert_eq!(status, StatusCode::SEE_OTHER, "{body}");
    assert!(api_requests(&app).contains(&(Method::POST, "/admin/shop/campaigns".to_owned())));
    assert_eq!(
        shop_writes(&app),
        vec![json!({
            "skus": ["premium:1", "cosmetic:7"],
            "percent": 20,
            "ends_at": "2026-10-05T20:59:00Z"
        })]
    );
    assert_eq!(
        flash_message(&headers).as_deref(),
        Some("Campaign −20% applied to 2 products until 5 Oct 23:59.")
    );
}

#[tokio::test]
async fn shop_campaign_without_a_selection_is_refused_before_the_api() {
    let app = setup(&["*"], true, "mirror").await;
    for action in ["apply_campaign", "remove_campaign"] {
        let uri = format!("/shop?action={action}");
        let (status, headers, body) =
            post(&app, "/shop", &uri, "discount_percent=20&ends_at=").await;
        assert_eq!(status, StatusCode::SEE_OTHER, "{body}");
        assert_eq!(
            flash_message(&headers).as_deref(),
            Some("Select at least one product."),
            "{action}"
        );
    }
    assert!(shop_writes(&app).is_empty());
}

#[tokio::test]
async fn shop_page_shows_the_now_price_from_the_api() {
    let app = setup(&["*"], true, "mirror").await;
    let (status, _, body) = get(&app, "/shop").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body.contains("$4.00"), "{body}");
    assert!(body.contains("Plus $2.80"), "{body}");
    assert!(body.contains("−20% until 5 Oct 23:59"), "{body}");
    assert!(body.contains("Kuzgun (Ultra decoration)"), "{body}");
    assert!(body.contains("not in shop"), "{body}");
    assert!(body.contains(r#"name="price_premium:12""#), "{body}");
    let (_, _, ultras) = get(&app, "/shop?type=avatar_ultra").await;
    assert!(ultras.contains("Kuzgun (Ultra decoration)"), "{ultras}");
    assert!(!ultras.contains(r#"name="price_premium:1""#), "{ultras}");
}

#[tokio::test]
async fn shop_page_warns_when_payriff_budget_triggers_fire() {
    let app = setup(&["*"], true, "mirror").await;
    let (_, _, calm) = get(&app, "/shop").await;
    assert!(calm.contains("No busy refusals"), "{calm}");
    assert!(calm.contains("Reconcile on time"), "{calm}");
    assert!(!calm.contains("refused as busy"), "{calm}");
    assert!(!calm.contains("min behind"), "{calm}");
    assert!(!calm.contains("backing off"), "{calm}");
    app.api.lock().unwrap().shop_health = Some(json!({
        "busy_refusals_last_hour": 3,
        "reconcile_lag_seconds": 1200,
        "payriff_backing_off": true
    }));
    let (status, _, body) = get(&app, "/shop").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(
        body.contains("refused as busy in the last hour: 3"),
        "{body}"
    );
    assert!(body.contains("Reconcile 20 min behind"), "{body}");
    assert!(body.contains("backing off"), "{body}");
}

#[tokio::test]
async fn shop_order_lookup_shows_the_order() {
    let app = setup(&["*"], true, "mirror").await;
    let (status, _, body) = get(&app, "/shop?order=1490000000000000009").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(api_requests(&app).contains(&(
        Method::GET,
        "/admin/shop/orders/1490000000000000009".to_owned()
    )));
    assert!(body.contains("PRF-ORDER-42"), "{body}");
    assert!(body.contains("APPROVED"), "{body}");
    assert!(body.contains(">granted<"), "{body}");
    assert!(
        body.contains(r#"href="/users/1500000000000000002""#),
        "{body}"
    );

    let app = setup(&["*"], true, "mirror").await;
    let (status, _, body) = get(&app, "/shop?order=abc").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body.contains("Enter an order number."), "{body}");
    assert!(
        !api_requests(&app)
            .iter()
            .any(|(_, path)| path.starts_with("/admin/shop/orders")),
        "an invalid order number reached the API"
    );
    let (status, _, body) = get(&app, "/shop?order=1490000000000000008").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body.contains("No order with that number."), "{body}");
}

// Bundle listings and price rows.
#[tokio::test]
async fn shop_page_lists_bundles_and_their_price_rows() {
    let app = setup(&["*"], true, "mirror").await;
    let (status, _, page) = get(&app, "/shop").await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert!(page.contains(">Bundles<"), "{page}");
    assert!(page.contains("Gece Seti"), "{page}");
    assert!(page.contains("bundle:1600000000000000001"), "{page}");
    // Item names in the bundle's own order.
    assert!(page.contains("Gece Plakasi, Kuzgun"), "{page}");
    // Only the second bundle has no price; its name is API text.
    assert_eq!(page.matches("not in the shop").count(), 1, "{page}");
    assert!(!page.contains(XSS), "{page}");
    assert!(
        page.contains("&lt;script&gt;alert(1)&lt;/script&gt;"),
        "{page}"
    );
    assert!(page.contains("Bundle · Gece Seti (2 items)"), "{page}");
    // Both bundles get a price row, and so does a bundle price whose bundle is gone.
    for sku in [
        "bundle:1600000000000000001",
        "bundle:1600000000000000002",
        "bundle:1600000000000000009",
    ] {
        assert!(
            page.contains(&format!(r#"name="price_{sku}""#)),
            "{sku}: {page}"
        );
    }
    assert!(page.contains(r#"<option value="bundle">"#), "{page}");
    // The API refuses a bundle item as a Visionary reward, so the reward picker leaves it out.
    assert!(
        page.contains(r#"name="reward_item_ids" value="9" checked"#),
        "{page}"
    );
    assert!(
        !page.contains(r#"name="reward_item_ids" value="8""#),
        "{page}"
    );
    let (_, _, bundles) = get(&app, "/shop?type=bundle").await;
    assert!(
        bundles.contains(r#"name="price_bundle:1600000000000000009""#),
        "{bundles}"
    );
    assert!(!bundles.contains(r#"name="price_premium:1""#), "{bundles}");
    assert!(!bundles.contains(r#"name="price_cosmetic:7""#), "{bundles}");
}

#[tokio::test]
async fn bundle_forms_call_the_contract_routes() {
    let app = setup(&["*"], true, "mirror").await;
    let (_, _, page) = get(&app, "/shop").await;
    assert!(page.contains("action=bundle_create"), "{page}");
    // The picker offers owned-only items that are not Visionary rewards.
    assert!(page.contains(r#"name="item_ids" value="7""#), "{page}");
    assert!(page.contains(r#"name="item_ids" value="8""#), "{page}");
    assert!(!page.contains(r#"name="item_ids" value="9""#), "{page}");
    let create = &page[page.find("action=bundle_create").expect("no create form")..];
    assert!(
        !create.contains(r#"name="item_ids" value="1700000000000000010""#),
        "{create}"
    );
    // The edit form keeps the bundle's order, so saving only a new name never reorders it.
    let edit = &page[page
        .find(r#"name="bundle_id" value="1600000000000000001""#)
        .expect("no edit form")..];
    let eight = edit.find(r#"value="8" checked"#).expect("8 not ticked");
    let seven = edit.find(r#"value="7" checked"#).expect("7 not ticked");
    assert!(eight < seven, "{edit}");
    assert!(page.contains("hx-confirm="), "{page}");

    let (status, headers, body) = post(
        &app,
        "/shop",
        "/shop?action=bundle_create",
        "name=Yaz+Seti&description=&item_ids=7&item_ids=8",
    )
    .await;
    assert_eq!(status, StatusCode::SEE_OTHER, "{body}");
    assert_eq!(location(&headers), Some("/shop"));
    let created = flash_data(&headers).expect("no flash");
    assert_eq!(created.flash_type, "success", "{}", created.message);
    assert!(created.message.contains("Yaz Seti"), "{}", created.message);
    let (status, headers, body) = post(
        &app,
        "/shop",
        "/shop?action=bundle_update",
        "bundle_id=1600000000000000001&name=Gece+Seti&description=Kuzgun+ve+plaka\
         &item_ids=8&item_ids=7",
    )
    .await;
    assert_eq!(status, StatusCode::SEE_OTHER, "{body}");
    assert_eq!(
        flash_data(&headers)
            .map(|flash| flash.flash_type)
            .as_deref(),
        Some("success")
    );
    let (status, headers, body) = post(
        &app,
        "/shop",
        "/shop?action=bundle_delete",
        "bundle_id=1600000000000000001",
    )
    .await;
    assert_eq!(status, StatusCode::SEE_OTHER, "{body}");
    assert_eq!(
        flash_data(&headers)
            .map(|flash| flash.flash_type)
            .as_deref(),
        Some("success")
    );
    assert_eq!(
        bundle_calls(&app),
        vec![
            (Method::POST, "/admin/shop/bundles".to_owned()),
            (
                Method::PATCH,
                "/admin/shop/bundles/1600000000000000001".to_owned()
            ),
            (
                Method::DELETE,
                "/admin/shop/bundles/1600000000000000001".to_owned()
            ),
        ]
    );
    assert_eq!(
        shop_writes(&app),
        vec![
            json!({ "name": "Yaz Seti", "description": null, "item_ids": ["7", "8"] }),
            json!({ "name": "Gece Seti", "description": "Kuzgun ve plaka", "item_ids": ["8", "7"] }),
        ]
    );
}

#[tokio::test]
async fn invalid_bundle_forms_never_reach_the_api() {
    let app = setup(&["*"], true, "mirror").await;
    let eleven = (1..=11)
        .map(|n| format!("item_ids={n}"))
        .collect::<Vec<_>>()
        .join("&");
    let cases = [
        ("bundle_create", "name=Set&item_ids=7".to_owned()),
        ("bundle_create", format!("name=Set&{eleven}")),
        ("bundle_create", "name=&item_ids=7&item_ids=8".to_owned()),
        (
            "bundle_update",
            "bundle_id=abc&name=Set&item_ids=7&item_ids=8".to_owned(),
        ),
        (
            "bundle_update",
            "bundle_id=1600000000000000001&name=Set&item_ids=7&item_ids=x".to_owned(),
        ),
        ("bundle_delete", "bundle_id=0".to_owned()),
        ("bundle_delete", String::new()),
    ];
    for (action, form) in &cases {
        let uri = format!("/shop?action={action}");
        let (status, headers, body) = post(&app, "/shop", &uri, form).await;
        assert_eq!(status, StatusCode::SEE_OTHER, "{body}");
        assert_eq!(
            flash_data(&headers)
                .map(|flash| flash.flash_type)
                .as_deref(),
            Some("error"),
            "{action} {form}"
        );
    }
    assert!(bundle_calls(&app).is_empty(), "{:?}", bundle_calls(&app));
    assert!(shop_writes(&app).is_empty());
}

// Without cosmetics:manage there are no item names to pick from: ids only, no create or edit form.
// Deleting needs no names, so shop:manage alone still deletes.
#[tokio::test]
async fn bundle_forms_need_cosmetics_manage() {
    let app = setup(&["admin:authenticate", "shop:manage"], true, "mirror").await;
    let (status, _, page) = get(&app, "/shop").await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert!(page.contains("Gece Seti"), "{page}");
    assert!(page.contains("8, 7"), "{page}");
    for action in ["bundle_create", "bundle_update"] {
        assert!(
            !page.contains(&format!("action={action}")),
            "{action}: {page}"
        );
    }
    assert_eq!(page.matches("action=bundle_delete").count(), 2, "{page}");
}

// An item that left the picker (no longer owned-only, or deleted) stays ticked in the bundle's edit
// form, in bundle order, so saving the form never drops it unseen.
#[tokio::test]
async fn bundle_edit_form_keeps_items_no_longer_offered() {
    let app = setup(&["*"], true, "mirror").await;
    let (_, _, page) = get(&app, "/shop").await;
    let edit = &page[page
        .find(r#"name="bundle_id" value="1600000000000000002""#)
        .expect("no edit form")..];
    let edit = &edit[..edit.find("</form>").expect("edit form not closed")];
    let seven = edit.find(r#"value="7" checked"#).expect("7 not ticked");
    let free = edit
        .find(r#"name="item_ids" value="1700000000000000010" checked"#)
        .expect("the free item was dropped");
    let gone = edit
        .find(r#"name="item_ids" value="1700000000000000099" checked"#)
        .expect("the deleted item was dropped");
    assert!(seven < free && free < gone, "{edit}");
    assert!(
        edit.contains("&lt;script&gt;alert(1)&lt;/script&gt; (no longer offered)"),
        "{edit}"
    );
    assert!(
        edit.contains("1700000000000000099 (no longer offered)"),
        "{edit}"
    );
    assert!(!edit.contains(XSS), "{edit}");
}

#[tokio::test]
async fn shop_order_lookup_lists_the_items_of_a_bundle_order() {
    let items_row = |page: &str| {
        let row = &page[page.find(">Items</dt>").expect("no Items row")..];
        row[..row.find("</dd>").expect("Items row not closed")].to_owned()
    };
    let app = setup(&["*"], true, "mirror").await;
    let (status, _, page) = get(&app, "/shop?order=1490000000000000010").await;
    assert_eq!(status, StatusCode::OK, "{page}");
    let row = items_row(&page);
    assert!(row.contains("Gece Plakasi, Kuzgun"), "{row}");
    assert!(
        row.contains(
            "To refund: refund the whole order in Payriff, then take back on the user page the \
             items this order gave; an item another order gave stays (the API log names it)."
        ),
        "{row}"
    );
    let (_, _, single) = get(&app, "/shop?order=1490000000000000009").await;
    assert!(!single.contains(">Items</dt>"), "{single}");
    // Nothing was paid, so there is nothing to refund or take back.
    let (_, _, unpaid) = get(&app, "/shop?order=1490000000000000011").await;
    let row = items_row(&unpaid);
    assert!(row.contains("Gece Plakasi, Kuzgun"), "{row}");
    assert!(!row.contains("refund"), "{row}");

    let app = setup(&["admin:authenticate", "shop:manage"], true, "mirror").await;
    let (_, _, page) = get(&app, "/shop?order=1490000000000000010").await;
    assert!(items_row(&page).contains("8, 7"), "{page}");
}

async fn mock_api(State(api): State<Shared>, method: Method, uri: Uri, body: Bytes) -> Response {
    let path = uri.path().to_owned();
    let mut api = api.lock().unwrap();
    api.requests.push((method.clone(), path.clone()));
    match (method, path.as_str()) {
        (Method::GET, "/admin/users/@me") => {
            json_response(json!({ "user": user("1500000000000000000", &api.acls) }))
        }
        (Method::GET, "/admin/instance/config") => json_response(instance_config(api.premium_mode)),
        (Method::POST, "/admin/gift-codes") => {
            let request: Value = serde_json::from_slice(&body).unwrap();
            let count = request["count"].as_u64().unwrap();
            let offset = api.gift_code_calls.iter().sum::<u64>();
            api.gift_code_calls.push(count);
            let codes: Vec<String> = (offset..offset + count)
                .map(|n| format!("https://gift.example.test/CODE{n:028}"))
                .collect();
            json_response(json!({ "codes": codes }))
        }
        (Method::GET, "/admin/cosmetics/items") => json_response(json!([{
            "id": "1700000000000000010",
            "type": "avatar_decoration",
            "name": XSS,
            "description": null,
            "asset": "0a1b2c3d",
            "availability": "free"
        }, {
            "id": "7",
            "type": "avatar_ultra",
            "name": "Kuzgun",
            "description": null,
            "asset": "0a1b2c3f",
            "availability": "owned"
        }, {
            "id": "8",
            "type": "nameplate",
            "name": "Gece Plakasi",
            "description": null,
            "asset": "0a1b2c40",
            "availability": "owned"
        }, {
            "id": "9",
            "type": "avatar_decoration",
            "name": "Odul Halkasi",
            "description": null,
            "asset": "0a1b2c41",
            "availability": "owned"
        }])),
        (Method::POST, "/admin/cosmetics/items") => {
            let request: Value = serde_json::from_slice(&body).unwrap();
            api.cosmetic_creates.push(request.clone());
            json_response(json!({
                "id": "1700000000000000011",
                "type": request["type"],
                "name": request["name"],
                "description": null,
                "asset": "0a1b2c3e",
                "availability": request["availability"]
            }))
        }
        (Method::PATCH, "/admin/cosmetics/items/7") => {
            api.cosmetic_patches
                .push(serde_json::from_slice(&body).unwrap());
            json_response(json!({
                "id": "7",
                "type": "avatar_ultra",
                "name": "Kuzgun",
                "description": null,
                "asset": "0a1b2c3f",
                "availability": "owned"
            }))
        }
        (Method::GET, "/admin/badges") => json_response(json!([{
            "id": "1700000000000000020",
            "icon": "9f3c2b1a",
            "description": XSS
        }])),
        (Method::DELETE, path) if path.starts_with("/admin/feed/posts/") => {
            StatusCode::NO_CONTENT.into_response()
        }
        (Method::GET, "/admin/reports") => json_response(json!({
            "reports": [feed_report("1800000000000000003", 3), feed_report("1800000000000000004", 4)],
            "total": 2,
            "offset": 0,
            "limit": 25
        })),
        (Method::GET, "/admin/reports/1800000000000000003") => {
            json_response(feed_report("1800000000000000003", 3))
        }
        (Method::GET, "/admin/shop") => {
            let mut shop = shop_admin(api.shop_health.clone());
            if let Some(settings) = &api.shop_settings {
                shop["settings"]
                    .as_object_mut()
                    .unwrap()
                    .extend(settings.as_object().unwrap().clone());
            }
            json_response(shop)
        }
        (Method::POST, "/admin/shop/settings/refresh-try-rate") => {
            StatusCode::NO_CONTENT.into_response()
        }
        (Method::GET, "/admin/shop/orders/1490000000000000009") => json_response(shop_order()),
        (Method::GET, "/admin/shop/orders/1490000000000000010") => {
            let mut order = shop_order();
            order["id"] = json!("1490000000000000010");
            order["sku"] = json!("bundle:1600000000000000001");
            order["item_ids"] = json!(["8", "7"]);
            json_response(order)
        }
        (Method::GET, "/admin/shop/orders/1490000000000000011") => {
            let mut order = shop_order();
            order["id"] = json!("1490000000000000011");
            order["sku"] = json!("bundle:1600000000000000001");
            order["item_ids"] = json!(["8", "7"]);
            order["status"] = json!("expired");
            order["paid_at"] = Value::Null;
            order["granted_at"] = Value::Null;
            json_response(order)
        }
        (Method::DELETE, path) if path.starts_with("/admin/shop/bundles/") => {
            StatusCode::NO_CONTENT.into_response()
        }
        (Method::PATCH | Method::PUT | Method::POST, path) if path.starts_with("/admin/shop") => {
            api.shop_writes.push(serde_json::from_slice(&body).unwrap());
            json_response(shop_admin(None))
        }
        _ => (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" }))).into_response(),
    }
}

fn json_response(value: Value) -> Response {
    Json(value).into_response()
}

// "now" is the API's own price; the page shows it and never prices anything itself.
fn shop_admin(health: Option<Value>) -> Value {
    json!({
        "settings": {
            "premium_sales_open": false,
            "item_sales_open": true,
            "premium_discount_percent": 30,
            "usd_to_azn_rate_micro": 1_700_000,
            "payriff_configured": true,
            "try_to_azn_rate_micro": null,
            "try_rate_date": null,
            "try_rate_fetched_at": null,
            "try_to_azn_rate_override_micro": null,
            "try_rate_override_at": null,
            "visionary_reward_item_ids": ["9"]
        },
        "bundles": [{
            "id": "1600000000000000001",
            "sku": "bundle:1600000000000000001",
            "name": "Gece Seti",
            "description": "Kuzgun with its nameplate",
            "item_ids": ["8", "7"]
        }, {
            "id": "1600000000000000002",
            "sku": "bundle:1600000000000000002",
            "name": XSS,
            "description": null,
            "item_ids": ["7", "1700000000000000010", "1700000000000000099"]
        }],
        "prices": [{
            "sku": "premium:1",
            "base_usd_cents": 500,
            "campaign_percent": null,
            "campaign_ends_at": null,
            "now": {
                "base_usd_cents": 500,
                "campaign_percent": null,
                "campaign_ends_at": null,
                "sale_usd_cents": 500,
                "premium_usd_cents": null
            }
        }, {
            "sku": "cosmetic:7",
            "base_usd_cents": 500,
            "campaign_percent": 20,
            "campaign_ends_at": "2026-10-05T20:59:00.000Z",
            "now": {
                "base_usd_cents": 500,
                "campaign_percent": 20,
                "campaign_ends_at": "2026-10-05T20:59:00.000Z",
                "sale_usd_cents": 400,
                "premium_usd_cents": 280
            }
        }, {
            "sku": "bundle:1600000000000000001",
            "base_usd_cents": 900,
            "campaign_percent": null,
            "campaign_ends_at": null,
            "now": {
                "base_usd_cents": 900,
                "campaign_percent": null,
                "campaign_ends_at": null,
                "sale_usd_cents": 900,
                "premium_usd_cents": 630
            }
        }, {
            "sku": "bundle:1600000000000000009",
            "base_usd_cents": 300,
            "campaign_percent": null,
            "campaign_ends_at": null,
            "now": {
                "base_usd_cents": 300,
                "campaign_percent": null,
                "campaign_ends_at": null,
                "sale_usd_cents": 300,
                "premium_usd_cents": 210
            }
        }],
        "health": health.unwrap_or_else(|| json!({
            "busy_refusals_last_hour": 0,
            "reconcile_lag_seconds": 0,
            "payriff_backing_off": false
        }))
    })
}

fn shop_order() -> Value {
    json!({
        "id": "1490000000000000009",
        "user_id": "1500000000000000002",
        "sku": "cosmetic:7",
        "status": "granted",
        "failure_reason": null,
        "base_usd_cents": 500,
        "campaign_percent": 20,
        "premium_percent": 30,
        "final_usd_cents": 280,
        "amount_azn_minor": 476,
        "usd_to_azn_rate": "1.7000",
        "currency": "AZN",
        "provider_order_id": "PRF-ORDER-42",
        "provider_status": "APPROVED",
        "check_count": 1,
        "created_at": "2026-10-01T10:00:00.000Z",
        "paid_at": "2026-10-01T10:02:00.000Z",
        "granted_at": "2026-10-01T10:02:01.000Z"
    })
}

fn feed_report(report_id: &str, report_type: i32) -> Value {
    json!({
        "report_id": report_id,
        "reporter_id": "1500000000000000000",
        "reporter_tag": "AdminUser#0001",
        "reported_at": "2026-09-24T12:00:00.000Z",
        "status": 0,
        "report_type": report_type,
        "category": "child_safety",
        "additional_info": null,
        "reported_user_id": "1500000000000000001",
        "reported_user_tag": "Author#0001",
        "message_context": [{
            "id": "1700000000000000001",
            "content": "Reported feed post",
            "timestamp": "2026-09-24T11:00:00.000Z",
            "author_id": "1500000000000000001",
            "author_username": "Author",
            "author_global_name": "Author",
            "author_discriminator": "0001",
            "author_avatar": null,
            "channel_id": "1700000000000000001",
            "attachments": [{
                "id": "1700000000000000005",
                "filename": "photo.png",
                "url": "https://media.example.test/attachments/1700000000000000001/1700000000000000005/photo.png",
                "content_type": "image/png",
                "size": 1024
            }]
        }]
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

fn instance_config(premium_mode: &str) -> Value {
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
        "policy": {"premium_mode": premium_mode, "single_community_guild_id": null}
    })
}

fn test_config(api_endpoint: String, self_hosted: bool) -> AdminConfig {
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
        self_hosted,
        proxy: ProxyConfig {
            trust_client_ip_header: false,
            client_ip_header_name: "x-forwarded-for".to_owned(),
        },
    }
}
