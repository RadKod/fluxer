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
use tokio::net::TcpListener;
use tower::ServiceExt;

const SECRET: &str = "username-moderation-test-secret";
const ADMIN_ID: &str = "1500000000000000000";
const USER_ID: &str = "1500000000000000042";

#[derive(Clone, Debug)]
struct Write {
    method: Method,
    path: String,
    reason: Option<String>,
    body: Value,
}

struct MockApi {
    acls: Vec<String>,
    writes: Vec<Write>,
    refuse: bool,
}

type Shared = Arc<Mutex<MockApi>>;

struct App {
    router: Router,
    cookie: String,
    api: Shared,
}

#[tokio::test]
async fn username_controls_require_the_username_update_acl() {
    for (acls, visible) in [
        (vec!["admin:authenticate", "user:lookup"], false),
        (
            vec!["admin:authenticate", "user:lookup", "username:reserve"],
            false,
        ),
        (
            vec!["admin:authenticate", "user:lookup", "user:update:username"],
            true,
        ),
        (vec!["*"], true),
    ] {
        let app = setup(&acls).await;
        for (tab, action) in [
            ("account", "change_username"),
            ("moderation", "force_username_reselect"),
        ] {
            let (status, _, page) = get(&app, tab).await;
            assert_eq!(status, StatusCode::OK, "{page}");
            assert_eq!(
                page.contains(&format!("action={action}")),
                visible,
                "{page}"
            );
            if visible {
                assert!(page.contains(r#"name="audit_log_reason""#), "{page}");
                if tab == "moderation" {
                    assert!(page.contains(r#"name="ban_name""#), "{page}");
                }
            }
        }
    }
}

#[tokio::test]
async fn forced_reselection_sends_the_ban_option_and_audit_reason() {
    let app = setup(&["*"]).await;
    for (field, expected) in [("", false), ("&ban_name=true", true)] {
        app.api.lock().unwrap().writes.clear();
        let (status, headers, _) = post(
            &app,
            "force_username_reselect",
            &format!("audit_log_reason=Rule%20violation&confirm=true{field}"),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::SEE_OTHER);
        assert_eq!(flash_type(&headers).as_deref(), Some("success"));
        let writes = &app.api.lock().unwrap().writes;
        assert_eq!(writes.len(), 1, "{writes:?}");
        assert_eq!(writes[0].method, Method::POST);
        assert_eq!(
            writes[0].path,
            format!("/admin/users/{USER_ID}/username/reselect")
        );
        assert_eq!(writes[0].reason.as_deref(), Some("Rule violation"));
        assert_eq!(writes[0].body, json!({"ban_name": expected}));
    }
}

#[tokio::test]
async fn rename_reuses_the_ownership_aware_endpoint_with_a_reason() {
    let app = setup(&["*"]).await;
    let (status, headers, _) = post(
        &app,
        "change_username",
        "username=newname&audit_log_reason=Staff%20assignment",
        true,
    )
    .await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    assert_eq!(flash_type(&headers).as_deref(), Some("success"));
    let writes = &app.api.lock().unwrap().writes;
    assert_eq!(writes.len(), 1, "{writes:?}");
    assert_eq!(writes[0].method, Method::PATCH);
    assert_eq!(writes[0].path, format!("/admin/users/{USER_ID}/username"));
    assert_eq!(writes[0].reason.as_deref(), Some("Staff assignment"));
    assert_eq!(writes[0].body["username"], "newname");
    assert!(
        writes[0]
            .body
            .get("discriminator")
            .is_none_or(Value::is_null)
    );
}

#[tokio::test]
async fn username_writes_reject_missing_and_invalid_reasons_before_the_api() {
    let app = setup(&["*"]).await;
    for reason in [
        "".to_owned(),
        "%20%20".to_owned(),
        "line%0Abreak".to_owned(),
        "x".repeat(513),
    ] {
        for action in ["change_username", "force_username_reselect"] {
            let (status, headers, _) = post(
                &app,
                action,
                &format!("username=newname&confirm=true&audit_log_reason={reason}"),
                true,
            )
            .await;
            assert_eq!(status, StatusCode::SEE_OTHER);
            assert_eq!(flash_type(&headers).as_deref(), Some("error"));
        }
    }
    assert!(app.api.lock().unwrap().writes.is_empty());
}

#[tokio::test]
async fn forced_reselection_requires_confirmation_before_the_api() {
    let app = setup(&["*"]).await;
    let (status, headers, _) = post(
        &app,
        "force_username_reselect",
        "audit_log_reason=Review",
        true,
    )
    .await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    assert_eq!(flash_type(&headers).as_deref(), Some("error"));
    assert!(app.api.lock().unwrap().writes.is_empty());
}

#[tokio::test]
async fn username_writes_preserve_turkish_audit_reasons() {
    let app = setup(&["*"]).await;
    let reason = "Kural ihlali: kullanıcı adı değiştirildi";
    for action in ["change_username", "force_username_reselect"] {
        app.api.lock().unwrap().writes.clear();
        let fields = format!(
            "username=newname&confirm=true&audit_log_reason={}",
            urlencoding::encode(reason)
        );
        let (status, headers, _) = post(&app, action, &fields, true).await;
        assert_eq!(status, StatusCode::SEE_OTHER);
        assert_eq!(flash_type(&headers).as_deref(), Some("success"));
        assert_eq!(
            app.api.lock().unwrap().writes[0].reason.as_deref(),
            Some(reason)
        );
    }
}

#[tokio::test]
async fn username_writes_are_denied_without_acl_or_csrf() {
    for allowed in [false, true] {
        let acls = if allowed {
            vec!["*"]
        } else {
            vec!["admin:authenticate", "user:lookup", "username:reserve"]
        };
        let app = setup(&acls).await;
        for action in ["change_username", "force_username_reselect"] {
            let (status, _, _) = post(
                &app,
                action,
                "username=newname&confirm=true&audit_log_reason=Review",
                !allowed,
            )
            .await;
            assert_eq!(status, StatusCode::FORBIDDEN);
        }
        assert!(app.api.lock().unwrap().writes.is_empty());
    }
}

#[tokio::test]
async fn upstream_refusal_is_an_error_flash_not_a_success() {
    let app = setup(&["*"]).await;
    app.api.lock().unwrap().refuse = true;
    for action in ["change_username", "force_username_reselect"] {
        let (status, headers, _) = post(
            &app,
            action,
            "username=newname&confirm=true&audit_log_reason=Review",
            true,
        )
        .await;
        assert_eq!(status, StatusCode::SEE_OTHER);
        assert_eq!(flash_type(&headers).as_deref(), Some("error"));
    }
}

async fn setup(acls: &[&str]) -> App {
    let api = Arc::new(Mutex::new(MockApi {
        acls: acls.iter().map(|acl| (*acl).to_owned()).collect(),
        writes: Vec::new(),
        refuse: false,
    }));
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let address = listener.local_addr().unwrap();
    let mock = Router::new().fallback(mock_api).with_state(api.clone());
    tokio::spawn(async move { axum::serve(listener, mock).await.unwrap() });
    App {
        router: build_router(config(format!("http://{address}"))),
        cookie: format!(
            "{}={}",
            session::SESSION_COOKIE_NAME,
            session::create_session(ADMIN_ID, "test-token", SECRET)
        ),
        api,
    }
}

async fn send(app: &App, request: Request<Body>) -> (StatusCode, HeaderMap, String) {
    let response = app.router.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, headers, String::from_utf8(body.to_vec()).unwrap())
}

async fn get(app: &App, tab: &str) -> (StatusCode, HeaderMap, String) {
    send(
        app,
        Request::builder()
            .uri(format!("/users/{USER_ID}?tab={tab}"))
            .header(header::COOKIE, &app.cookie)
            .body(Body::empty())
            .unwrap(),
    )
    .await
}

async fn post(
    app: &App,
    action: &str,
    fields: &str,
    valid_csrf: bool,
) -> (StatusCode, HeaderMap, String) {
    let (_, headers, _) = get(app, "account").await;
    let token = headers
        .get_all(header::SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .find_map(|value| {
            let pair = value.split(';').next()?;
            pair.strip_prefix("csrf_token=")
                .or_else(|| pair.strip_prefix("__Host-csrf_token="))
        })
        .expect("csrf cookie");
    let cookie = format!("{}; csrf_token={token}", app.cookie);
    let body = if valid_csrf {
        format!("_csrf={token}&{fields}")
    } else {
        fields.to_owned()
    };
    send(
        app,
        Request::builder()
            .method(Method::POST)
            .uri(format!("/users/{USER_ID}?action={action}"))
            .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
            .header(header::COOKIE, cookie)
            .body(Body::from(body))
            .unwrap(),
    )
    .await
}

fn flash_type(headers: &HeaderMap) -> Option<String> {
    headers
        .get_all(header::SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .find_map(|value| parse_flash(value.split(';').next()?.strip_prefix("flash=")?))
        .map(|flash| flash.flash_type)
}

async fn mock_api(
    State(api): State<Shared>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    request: Request<Body>,
) -> Response {
    let fixture: Value =
        serde_json::from_str(include_str!("parity/fixtures/api/lookup_user.json")).unwrap();
    let mut user = fixture["users"][0].clone();
    user["id"] = json!(USER_ID);
    if method == Method::GET {
        return match uri.path() {
            "/admin/users/@me" => {
                user["id"] = json!(ADMIN_ID);
                user["acls"] = json!(api.lock().unwrap().acls);
                Json(json!({"user": user})).into_response()
            }
            "/.well-known/fluxer" => Json(json!({"features": {
                "account_identity": "email", "tag_style": "none", "premium_enabled": false
            }}))
            .into_response(),
            p if p == format!("/admin/users/{USER_ID}") => {
                Json(json!({"users": [user]})).into_response()
            }
            p if p.ends_with("/sessions") => Json(json!({"sessions": []})).into_response(),
            p if p.ends_with("/webauthn-credentials") => Json(json!([])).into_response(),
            _ => StatusCode::NOT_FOUND.into_response(),
        };
    }
    let bytes = to_bytes(request.into_body(), usize::MAX).await.unwrap();
    let reason = headers
        .get("x-audit-log-reason")
        .and_then(|value| std::str::from_utf8(value.as_bytes()).ok())
        .map(ToOwned::to_owned);
    let mut api = api.lock().unwrap();
    api.writes.push(Write {
        method: method.clone(),
        path: uri.path().to_owned(),
        reason,
        body: serde_json::from_slice(&bytes).unwrap(),
    });
    if api.refuse {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"code": "USERNAME_UNAVAILABLE", "message": "Unavailable"})),
        )
            .into_response();
    }
    if method == Method::POST && uri.path().ends_with("/username/reselect") {
        StatusCode::NO_CONTENT.into_response()
    } else if method == Method::PATCH && uri.path().ends_with("/username") {
        Json(json!({"user": user})).into_response()
    } else {
        StatusCode::NOT_FOUND.into_response()
    }
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
