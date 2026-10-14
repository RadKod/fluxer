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

const SECRET_KEY: &str = "micup-admin-voice-room-test-secret";
const ACTION: &str = "/instance-config?action=update_voice_room";
const GAMES_NEED_ROOMS: &str = "Turn 3D rooms on and save before enabling table games.";
const CAMERAS_NEED_ROOMS: &str = "Turn 3D rooms on and save before enabling room cameras.";
const CAMERAS: &str = "voice_room_room_cameras_enabled";
const DEFAULT_THEME: &str = "voice_room_default_room_theme";

struct MockApi {
    voice_room: Option<Value>,
    patches: Vec<Value>,
}

type Shared = Arc<Mutex<MockApi>>;

struct TestApp {
    router: Router,
    session_cookie: String,
    api: Shared,
}

async fn setup(voice_room: Option<Value>) -> TestApp {
    let api: Shared = Arc::new(Mutex::new(MockApi {
        voice_room,
        patches: Vec::new(),
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

async fn get_page(app: &TestApp) -> (StatusCode, HeaderMap, String) {
    let request = Request::builder()
        .method(Method::GET)
        .uri("/instance-config")
        .header(header::COOKIE, &app.session_cookie)
        .body(Body::empty())
        .unwrap();
    send(app, request).await
}

async fn post_voice_room(app: &TestApp, form: &str) -> (StatusCode, HeaderMap, String) {
    let (_, headers, page) = get_page(app).await;
    let token = csrf_cookie(&headers).unwrap_or_else(|| panic!("no csrf cookie\n{page}"));
    let request = Request::builder()
        .method(Method::POST)
        .uri(ACTION)
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

/// The markup of the voice room form, from its action to its closing tag.
fn voice_room_form(page: &str) -> &str {
    let start = page
        .find(&format!(r#"action="{ACTION}""#))
        .unwrap_or_else(|| panic!("missing voice room form\n{page}"));
    let tail = &page[start..];
    &tail[..tail.find("</form>").expect("unclosed voice room form")]
}

fn input_tag<'a>(form: &'a str, name: &str) -> &'a str {
    let at = form
        .find(&format!(r#"name="{name}""#))
        .unwrap_or_else(|| panic!("missing input {name}\n{form}"));
    let start = form[..at].rfind("<input").expect("input start");
    let end = at + form[at..].find('>').expect("input end");
    &form[start..=end]
}

fn is_checked(form: &str, name: &str) -> bool {
    input_tag(form, name).contains(" checked")
}

fn is_disabled(form: &str, name: &str) -> bool {
    input_tag(form, name).contains(" disabled")
}

#[tokio::test]
async fn instance_config_page_shows_the_3d_room_and_table_games_switches_off_by_default() {
    let app = setup(switches(false, false)).await;
    let (status, headers, page) = get_page(&app).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert!(page.contains("3D Voice Rooms and Table Games"), "{page}");
    let form = voice_room_form(&page);
    let token = csrf_cookie(&headers).expect("csrf cookie");
    assert!(
        form.contains(&format!(r#"name="_csrf" value="{token}""#)),
        "{form}"
    );
    assert!(!is_checked(form, "voice_room_rooms_enabled"), "{form}");
    assert!(!is_checked(form, "voice_room_games_enabled"), "{form}");
}

#[tokio::test]
async fn update_voice_room_posts_rooms_enabled_and_games_enabled() {
    let app = setup(switches(false, false)).await;
    let cases = [
        (
            "voice_room_rooms_enabled=true&voice_room_games_enabled=true",
            voice_room_patch(true, true, false),
        ),
        (
            "voice_room_rooms_enabled=true",
            voice_room_patch(true, false, false),
        ),
        // Games only run inside rooms, so switching rooms off switches games off too.
        (
            "voice_room_games_enabled=true",
            voice_room_patch(false, false, false),
        ),
        ("", voice_room_patch(false, false, false)),
    ];
    for (form, expected) in cases {
        app.api.lock().unwrap().patches.clear();
        let (status, headers, body) = post_voice_room(&app, form).await;
        assert_eq!(status, StatusCode::SEE_OTHER, "{form}: {body}");
        assert_eq!(app.api.lock().unwrap().patches, vec![expected], "{form}");
        let flash = flash(&headers).expect("flash");
        assert_eq!(flash.flash_type, "success", "{form}");
        assert_eq!(flash.message, "Instance config updated", "{form}");
    }
}

#[tokio::test]
async fn games_checkbox_is_disabled_while_rooms_is_off() {
    let app = setup(switches(false, false)).await;
    let (_, _, page) = get_page(&app).await;
    let form = voice_room_form(&page);
    assert!(!is_disabled(form, "voice_room_rooms_enabled"), "{form}");
    assert!(is_disabled(form, "voice_room_games_enabled"), "{form}");
    assert!(form.contains(GAMES_NEED_ROOMS), "{form}");

    let app = setup(switches(true, true)).await;
    let (_, _, page) = get_page(&app).await;
    let form = voice_room_form(&page);
    assert!(is_checked(form, "voice_room_rooms_enabled"), "{form}");
    assert!(is_checked(form, "voice_room_games_enabled"), "{form}");
    assert!(!is_disabled(form, "voice_room_games_enabled"), "{form}");
    assert!(!form.contains(GAMES_NEED_ROOMS), "{form}");
}

#[tokio::test]
async fn page_renders_when_the_api_omits_voice_room() {
    let app = setup(None).await;
    let (status, _, page) = get_page(&app).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert!(
        !page.contains("Failed to load instance configuration"),
        "{page}"
    );
    let form = voice_room_form(&page);
    assert!(!is_checked(form, "voice_room_rooms_enabled"), "{form}");
    assert!(!is_checked(form, "voice_room_games_enabled"), "{form}");
    assert!(is_disabled(form, "voice_room_games_enabled"), "{form}");
}

#[tokio::test]
async fn voice_room_section_shows_the_room_cameras_switch_off_by_default() {
    let app = setup(room_switches(true, false, false)).await;
    let (status, _, page) = get_page(&app).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    let form = voice_room_form(&page);
    assert!(!is_checked(form, CAMERAS), "{form}");
    assert!(!is_disabled(form, CAMERAS), "{form}");

    let app = setup(room_switches(true, false, true)).await;
    let (_, _, page) = get_page(&app).await;
    assert!(is_checked(voice_room_form(&page), CAMERAS), "{page}");
}

#[tokio::test]
async fn update_voice_room_posts_room_cameras_enabled() {
    let app = setup(room_switches(true, false, false)).await;
    let cases = [
        (
            "voice_room_rooms_enabled=true&voice_room_room_cameras_enabled=true",
            voice_room_patch(true, false, true),
        ),
        (
            "voice_room_rooms_enabled=true&voice_room_games_enabled=true&voice_room_room_cameras_enabled=true",
            voice_room_patch(true, true, true),
        ),
        // Room cameras only show inside rooms, so switching rooms off switches cameras off too.
        (
            "voice_room_room_cameras_enabled=true",
            voice_room_patch(false, false, false),
        ),
    ];
    for (form, expected) in cases {
        app.api.lock().unwrap().patches.clear();
        let (status, headers, body) = post_voice_room(&app, form).await;
        assert_eq!(status, StatusCode::SEE_OTHER, "{form}: {body}");
        assert_eq!(app.api.lock().unwrap().patches, vec![expected], "{form}");
        assert_eq!(
            flash(&headers).expect("flash").flash_type,
            "success",
            "{form}"
        );
    }
}

#[tokio::test]
async fn cameras_checkbox_is_disabled_while_rooms_is_off() {
    let app = setup(room_switches(false, false, true)).await;
    let (_, _, page) = get_page(&app).await;
    let form = voice_room_form(&page);
    assert!(is_disabled(form, CAMERAS), "{form}");
    assert!(form.contains(CAMERAS_NEED_ROOMS), "{form}");

    let app = setup(room_switches(true, false, false)).await;
    let (_, _, page) = get_page(&app).await;
    let form = voice_room_form(&page);
    assert!(!is_disabled(form, CAMERAS), "{form}");
    assert!(!form.contains(CAMERAS_NEED_ROOMS), "{form}");
}

#[tokio::test]
async fn page_renders_when_the_api_omits_room_cameras_enabled() {
    // An API from before the camera switch sends only the two older fields.
    let app = setup(switches(true, true)).await;
    let (status, _, page) = get_page(&app).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert!(
        !page.contains("Failed to load instance configuration"),
        "{page}"
    );
    let form = voice_room_form(&page);
    assert!(is_checked(form, "voice_room_rooms_enabled"), "{form}");
    assert!(!is_checked(form, CAMERAS), "{form}");
    assert!(!is_disabled(form, CAMERAS), "{form}");
}

#[tokio::test]
async fn default_room_theme_dropdown_defaults_disabled_and_selects_configured_theme() {
    for theme in [None, Some("kahvehane")] {
        let app = setup(Some(
            json!({"rooms_enabled": true, "default_room_theme": theme}),
        ))
        .await;
        let (status, _, page) = get_page(&app).await;
        assert_eq!(status, StatusCode::OK, "{page}");
        let form = voice_room_form(&page);
        assert!(
            form.contains(&format!(r#"name="{DEFAULT_THEME}""#)),
            "{form}"
        );
        assert!(form.contains("Default room theme"), "{form}");
        for id in ["", "gece-lounge", "kahvehane", "oyun-odasi"] {
            let selected = if theme.unwrap_or("") == id {
                " selected"
            } else {
                ""
            };
            assert!(
                form.contains(&format!(r#"<option value="{id}"{selected}>"#)),
                "{form}"
            );
        }
    }
}

#[tokio::test]
async fn default_room_theme_patch_selects_and_clears_even_with_rooms_off() {
    let app = setup(Some(json!({"default_room_theme": "kahvehane"}))).await;
    for theme in ["gece-lounge", "kahvehane", "oyun-odasi", ""] {
        app.api.lock().unwrap().patches.clear();
        let (status, headers, body) =
            post_voice_room(&app, &format!("{DEFAULT_THEME}={theme}")).await;
        assert_eq!(status, StatusCode::SEE_OTHER, "{body}");
        let mut expected = voice_room_patch(false, false, false);
        expected["voice_room"]["default_room_theme"] = if theme.is_empty() {
            Value::Null
        } else {
            json!(theme)
        };
        assert_eq!(app.api.lock().unwrap().patches, vec![expected]);
        assert_eq!(flash(&headers).unwrap().flash_type, "success");
    }
}

#[tokio::test]
async fn default_room_theme_patch_rejects_none_and_unknown_ids() {
    let app = setup(None).await;
    for theme in ["none", "unknown"] {
        let (_, headers, _) = post_voice_room(&app, &format!("{DEFAULT_THEME}={theme}")).await;
        assert!(app.api.lock().unwrap().patches.is_empty());
        assert_eq!(flash(&headers).unwrap().flash_type, "error");
    }
}

async fn mock_api(State(api): State<Shared>, method: Method, uri: Uri, body: Bytes) -> Response {
    let mut api = api.lock().unwrap();
    match (method, uri.path()) {
        (Method::GET, "/admin/users/@me") => Json(json!({ "user": admin_user() })).into_response(),
        (Method::GET, "/admin/instance/config") => {
            Json(instance_config(api.voice_room.clone())).into_response()
        }
        (Method::PATCH, "/admin/instance/config") => {
            api.patches
                .push(serde_json::from_slice(&body).unwrap_or(Value::Null));
            Json(instance_config(api.voice_room.clone())).into_response()
        }
        _ => (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" }))).into_response(),
    }
}

fn switches(rooms_enabled: bool, games_enabled: bool) -> Option<Value> {
    Some(json!({"rooms_enabled": rooms_enabled, "games_enabled": games_enabled}))
}

fn room_switches(rooms: bool, games: bool, cameras: bool) -> Option<Value> {
    Some(json!({"rooms_enabled": rooms, "games_enabled": games, "room_cameras_enabled": cameras}))
}

fn voice_room_patch(rooms: bool, games: bool, cameras: bool) -> Value {
    json!({"voice_room": {
        "rooms_enabled": rooms,
        "games_enabled": games,
        "room_cameras_enabled": cameras
    }})
}

fn instance_config(voice_room: Option<Value>) -> Value {
    let mut config = json!({
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
        "self_hosted": false
    });
    if let Some(voice_room) = voice_room {
        config["voice_room"] = voice_room;
    }
    config
}

fn admin_user() -> Value {
    json!({
        "id": "1500000000000000000",
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
        "acls": ["*"],
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
        self_hosted: false,
        proxy: ProxyConfig {
            trust_client_ip_header: false,
            client_ip_header_name: "x-forwarded-for".to_owned(),
        },
    }
}
