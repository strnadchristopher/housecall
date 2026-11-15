use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use housecall_server::{app, AppState};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;
const SETUP: &str = "test-bootstrap-credential-32-characters";
const PNG: [u8; 12] = [0x89, b'P', b'N', b'G', 13, 10, 26, 10, 1, 2, 3, 4];

struct Reply {
    status: StatusCode,
    content_type: Option<String>,
    cache: Option<String>,
    bytes: Vec<u8>,
}
impl Reply {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.bytes).unwrap_or(Value::Null)
    }
}
async fn raw(
    app: &Router,
    method: &str,
    path: &str,
    auth: &Value,
    content_type: &str,
    body: Vec<u8>,
) -> Reply {
    let req = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", content_type)
        .header(
            "authorization",
            format!("Bearer {}", auth["token"].as_str().unwrap()),
        )
        .header("x-device-key", auth["device_key"].as_str().unwrap())
        .body(Body::from(body))
        .unwrap();
    let response = app.clone().oneshot(req).await.unwrap();
    let status = response.status();
    let header = |name: &str| {
        response
            .headers()
            .get(name)
            .map(|v| v.to_str().unwrap().to_owned())
    };
    let (content_type, cache) = (header("content-type"), header("cache-control"));
    let bytes = response
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes()
        .to_vec();
    Reply {
        status,
        content_type,
        cache,
        bytes,
    }
}
async fn call(app: &Router, method: &str, path: &str, auth: &Value, body: Value) -> Reply {
    raw(
        app,
        method,
        path,
        auth,
        "application/json",
        body.to_string().into_bytes(),
    )
    .await
}
async fn public(app: &Router, path: &str, body: Value) -> Value {
    let req = Request::builder()
        .method("POST")
        .uri(path)
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let response = app.clone().oneshot(req).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
}
async fn fixture() -> (Router, AppState, Value, Value) {
    let mut state = AppState::new(":memory:", SETUP).unwrap();
    state.public_auth_limit = 1000;
    let api = app(state.clone(), None);
    let owner = public(
        &api,
        "/api/setup",
        json!({"setup_token":SETUP,"username":"owner","password":"test-password-long","device_name":"test"}),
    )
    .await;
    let invite = call(
        &api,
        "POST",
        "/api/invites",
        &owner,
        json!({"expires_in_seconds":3600}),
    )
    .await
    .json();
    let alice = public(
        &api,
        "/api/invites/accept",
        json!({"token":invite["token"],"username":"alice","password":"test-password-long","device_name":"test"}),
    )
    .await;
    (api, state, owner, alice)
}

#[test]
fn migration_is_idempotent() {
    let state = AppState::new(":memory:", SETUP).unwrap();
    let db = state.db.lock().unwrap();
    housecall_server::servers::init(&db).unwrap();
    housecall_server::servers::init(&db).unwrap();
}
#[tokio::test]
async fn rename_succeeds_and_is_listed() {
    let (api, _, _, alice) = fixture().await;
    let r = call(
        &api,
        "PATCH",
        "/api/me",
        &alice,
        json!({"display_name":"  Alice A.  "}),
    )
    .await;
    assert_eq!(r.status, StatusCode::OK);
    let members = call(&api, "GET", "/api/members", &alice, Value::Null)
        .await
        .json();
    let row = members["members"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["username"] == "alice")
        .unwrap();
    assert_eq!(row["display_name"], "Alice A.");
    assert_eq!(row["username"], "alice");
    let me = call(&api, "GET", "/api/me", &alice, Value::Null)
        .await
        .json();
    assert_eq!(me["user"]["display_name"], "Alice A.");
    let cleared = call(
        &api,
        "PATCH",
        "/api/me",
        &alice,
        json!({"display_name":null}),
    )
    .await;
    assert_eq!(cleared.status, StatusCode::OK);
    let me = call(&api, "GET", "/api/me", &alice, Value::Null)
        .await
        .json();
    assert!(me["user"]["display_name"].is_null());
}
#[tokio::test]
async fn server_member_list_carries_display_name_and_avatar_rev() {
    let (api, _, _, alice) = fixture().await;
    call(
        &api,
        "PATCH",
        "/api/me",
        &alice,
        json!({"display_name":"Ali"}),
    )
    .await;
    let members = call(
        &api,
        "GET",
        "/api/servers/home/members",
        &alice,
        Value::Null,
    )
    .await
    .json();
    let row = members["members"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["username"] == "alice")
        .unwrap();
    assert_eq!(row["display_name"], "Ali");
    assert_eq!(row["avatar_rev"], 0);
}
#[tokio::test]
async fn rename_emits_member_updated_to_peers() {
    let (api, _, owner, alice) = fixture().await;
    call(
        &api,
        "PATCH",
        "/api/me",
        &alice,
        json!({"display_name":"Ali"}),
    )
    .await;
    let events = call(&api, "GET", "/api/events", &owner, Value::Null)
        .await
        .json();
    assert!(events["events"].to_string().contains("member.updated"));
}
#[tokio::test]
async fn long_or_control_names_are_rejected() {
    let (api, _, _, alice) = fixture().await;
    for name in [
        "x".repeat(33),
        "   ".to_owned(),
        "a\u{7}b".to_owned(),
        "a\u{202E}b".to_owned(),
        "a\u{200B}b".to_owned(),
        "\u{FEFF}ab".to_owned(),
    ] {
        let r = call(
            &api,
            "PATCH",
            "/api/me",
            &alice,
            json!({"display_name":name}),
        )
        .await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{name:?}");
    }
}
#[tokio::test]
async fn svg_avatar_is_rejected() {
    let (api, _, _, alice) = fixture().await;
    let r = raw(
        &api,
        "PUT",
        "/api/me/avatar",
        &alice,
        "image/svg+xml",
        b"<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>".to_vec(),
    )
    .await;
    assert_eq!(r.status, StatusCode::UNSUPPORTED_MEDIA_TYPE);
}
#[tokio::test]
async fn avatar_round_trips_exact_bytes_and_clears() {
    let (api, _, owner, alice) = fixture().await;
    let id = call(&api, "GET", "/api/me", &alice, Value::Null)
        .await
        .json()["user"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let path = format!("/api/users/{id}/avatar");
    assert_eq!(
        call(&api, "GET", &path, &alice, Value::Null).await.status,
        StatusCode::NOT_FOUND
    );
    let put = raw(
        &api,
        "PUT",
        "/api/me/avatar",
        &alice,
        "image/png",
        PNG.to_vec(),
    )
    .await;
    assert_eq!(put.status, StatusCode::OK);
    assert_eq!(put.json()["avatar_rev"], 1);
    // Another member can read it.
    let got = call(&api, "GET", &path, &owner, Value::Null).await;
    assert_eq!(got.status, StatusCode::OK);
    assert_eq!(got.bytes, PNG);
    assert_eq!(got.content_type.as_deref(), Some("image/png"));
    assert!(got.cache.unwrap().contains("immutable"));
    let del = call(&api, "DELETE", "/api/me/avatar", &alice, Value::Null).await;
    assert_eq!(del.status, StatusCode::OK);
    assert_eq!(
        call(&api, "GET", &path, &owner, Value::Null).await.status,
        StatusCode::NOT_FOUND
    );
}
#[tokio::test]
async fn oversized_avatar_is_rejected() {
    let (api, _, _, alice) = fixture().await;
    let mut big = PNG.to_vec();
    big.resize(512 * 1024 + 10, 0);
    let r = raw(&api, "PUT", "/api/me/avatar", &alice, "image/png", big).await;
    assert_eq!(r.status, StatusCode::PAYLOAD_TOO_LARGE);
}
fn gif(width: u16, height: u16, len: usize) -> Vec<u8> {
    let mut bytes = b"GIF89a".to_vec();
    bytes.extend_from_slice(&width.to_le_bytes());
    bytes.extend_from_slice(&height.to_le_bytes());
    bytes.resize(len, 0);
    bytes
}
#[tokio::test]
async fn a_large_gif_uploads_as_avatar_and_server_icon_and_keeps_its_type() {
    let (api, _, owner, alice) = fixture().await;
    let animated = gif(64, 64, 1_500_000);
    let put = raw(
        &api,
        "PUT",
        "/api/me/avatar",
        &alice,
        "image/gif",
        animated.clone(),
    )
    .await;
    assert_eq!(put.status, StatusCode::OK);
    let id = call(&api, "GET", "/api/me", &alice, Value::Null)
        .await
        .json()["user"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let got = call(
        &api,
        "GET",
        &format!("/api/users/{id}/avatar"),
        &owner,
        Value::Null,
    )
    .await;
    assert_eq!(got.content_type.as_deref(), Some("image/gif"));
    assert_eq!(got.bytes, animated);
    let icon = raw(
        &api,
        "PUT",
        "/api/servers/home/icon",
        &owner,
        "image/gif",
        animated.clone(),
    )
    .await;
    assert_eq!(icon.status, StatusCode::OK);
    let got = call(&api, "GET", "/api/servers/home/icon", &alice, Value::Null).await;
    assert_eq!(got.content_type.as_deref(), Some("image/gif"));
    assert_eq!(got.bytes, animated);
}
#[tokio::test]
async fn a_gif_over_two_megabytes_is_rejected_by_the_route() {
    let (api, _, _, alice) = fixture().await;
    let r = raw(
        &api,
        "PUT",
        "/api/me/avatar",
        &alice,
        "image/gif",
        gif(64, 64, 2 * 1024 * 1024 + 1),
    )
    .await;
    assert_eq!(r.status, StatusCode::PAYLOAD_TOO_LARGE);
}
#[tokio::test]
async fn non_owner_cannot_change_the_server() {
    let (api, _, _, alice) = fixture().await;
    let r = call(
        &api,
        "PATCH",
        "/api/servers/home",
        &alice,
        json!({"name":"Mine"}),
    )
    .await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    let icon = raw(
        &api,
        "PUT",
        "/api/servers/home/icon",
        &alice,
        "image/png",
        PNG.to_vec(),
    )
    .await;
    assert_eq!(icon.status, StatusCode::FORBIDDEN);
}
#[tokio::test]
async fn owner_renames_server_and_sets_icon() {
    let (api, _, owner, alice) = fixture().await;
    let r = call(
        &api,
        "PATCH",
        "/api/servers/home",
        &owner,
        json!({"name":"Block Party"}),
    )
    .await;
    assert_eq!(r.status, StatusCode::OK);
    let too_long = call(
        &api,
        "PATCH",
        "/api/servers/home",
        &owner,
        json!({"name":"x".repeat(49)}),
    )
    .await;
    assert_eq!(too_long.status, StatusCode::BAD_REQUEST);
    let put = raw(
        &api,
        "PUT",
        "/api/servers/home/icon",
        &owner,
        "image/png",
        PNG.to_vec(),
    )
    .await;
    assert_eq!(put.status, StatusCode::OK);
    let got = call(&api, "GET", "/api/servers/home/icon", &alice, Value::Null).await;
    assert_eq!(got.status, StatusCode::OK);
    assert_eq!(got.bytes, PNG);
    let list = call(&api, "GET", "/api/servers", &alice, Value::Null)
        .await
        .json();
    let home = &list["servers"][0];
    assert_eq!(home["name"], "Block Party");
    assert_eq!(home["icon_rev"], 1);
    let events = call(&api, "GET", "/api/events", &alice, Value::Null)
        .await
        .json();
    assert!(events["events"].to_string().contains("server.updated"));
}
#[tokio::test]
async fn icon_is_hidden_from_non_members() {
    let (api, state, owner, alice) = fixture().await;
    let made = call(
        &api,
        "POST",
        "/api/servers",
        &owner,
        json!({"name":"Private"}),
    )
    .await
    .json();
    let sid = made["id"].as_str().unwrap();
    raw(
        &api,
        "PUT",
        &format!("/api/servers/{sid}/icon"),
        &owner,
        "image/png",
        PNG.to_vec(),
    )
    .await;
    let got = call(
        &api,
        "GET",
        &format!("/api/servers/{sid}/icon"),
        &alice,
        Value::Null,
    )
    .await;
    assert_eq!(got.status, StatusCode::FORBIDDEN);
    drop(state);
}
fn person<'a>(list: &'a Value, name: &str) -> &'a Value {
    list["members"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["username"] == name)
        .unwrap()
}
#[tokio::test]
async fn bio_round_trips_through_me_and_members_and_emits_member_updated() {
    let (api, _, owner, alice) = fixture().await;
    let bio = "b".repeat(190);
    let r = call(
        &api,
        "PATCH",
        "/api/me",
        &alice,
        json!({"bio":format!("  {bio}  ")}),
    )
    .await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json()["bio"], bio);
    let me = call(&api, "GET", "/api/me", &alice, Value::Null)
        .await
        .json();
    assert_eq!(me["user"]["bio"], bio);
    let members = call(&api, "GET", "/api/members", &owner, Value::Null)
        .await
        .json();
    assert_eq!(person(&members, "alice")["bio"], bio);
    let scoped = call(
        &api,
        "GET",
        "/api/servers/home/members",
        &owner,
        Value::Null,
    )
    .await
    .json();
    assert_eq!(person(&scoped, "alice")["bio"], bio);
    let events = call(&api, "GET", "/api/events", &owner, Value::Null)
        .await
        .json();
    let updated = events["events"]
        .as_array()
        .unwrap()
        .iter()
        .rfind(|e| e.to_string().contains("member.updated"))
        .unwrap()
        .to_string();
    assert!(updated.contains(&bio), "{updated}");
}
#[tokio::test]
async fn bio_without_a_name_leaves_the_name_alone_and_empty_clears_the_bio() {
    let (api, _, _, alice) = fixture().await;
    call(
        &api,
        "PATCH",
        "/api/me",
        &alice,
        json!({"display_name":"Ali"}),
    )
    .await;
    call(&api, "PATCH", "/api/me", &alice, json!({"bio":"hello"})).await;
    let me = call(&api, "GET", "/api/me", &alice, Value::Null)
        .await
        .json();
    assert_eq!(me["user"]["display_name"], "Ali");
    assert_eq!(me["user"]["bio"], "hello");
    let r = call(&api, "PATCH", "/api/me", &alice, json!({"bio":""})).await;
    assert_eq!(r.status, StatusCode::OK);
    let me = call(&api, "GET", "/api/me", &alice, Value::Null)
        .await
        .json();
    assert_eq!(me["user"]["display_name"], "Ali");
    assert!(me["user"]["bio"].is_null());
}
#[tokio::test]
async fn bad_bios_are_rejected() {
    let (api, _, _, alice) = fixture().await;
    for bio in [
        "x".repeat(191),
        "a\u{202E}b".to_owned(),
        "a\u{7}b".to_owned(),
    ] {
        let r = call(&api, "PATCH", "/api/me", &alice, json!({"bio":bio})).await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{bio:?}");
    }
    let r = call(&api, "PATCH", "/api/me", &alice, json!({"bio":"one\ntwo"})).await;
    assert_eq!(r.status, StatusCode::OK);
}
