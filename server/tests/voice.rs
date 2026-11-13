//! Voice channels, live voice state and stream previews. None of this needs the SFU: the
//! in-memory state is driven through the same functions the join and leave handlers call.
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

struct Reply {
    status: StatusCode,
    headers: axum::http::HeaderMap,
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
    let headers = response.headers().clone();
    let bytes = response
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes()
        .to_vec();
    Reply {
        status,
        headers,
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
/// Owner, alice (a member of the home server) and carol (a user who is not in any channel).
struct World {
    api: Router,
    state: AppState,
    owner: Value,
    alice: Value,
    carol: Value,
    owner_id: String,
    alice_id: String,
    carol_id: String,
    lounge: String,
}
async fn invited(api: &Router, owner: &Value, name: &str) -> Value {
    let invite = call(
        api,
        "POST",
        "/api/invites",
        owner,
        json!({"expires_in_seconds":3600}),
    )
    .await
    .json();
    public(
        api,
        "/api/invites/accept",
        json!({"token":invite["token"],"username":name,"password":"test-password-long","device_name":"test"}),
    )
    .await
}
async fn user_id(api: &Router, who: &Value) -> String {
    call(api, "GET", "/api/me", who, Value::Null).await.json()["user"]["id"]
        .as_str()
        .unwrap()
        .to_owned()
}
async fn channels_of(api: &Router, who: &Value) -> Vec<Value> {
    call(api, "GET", "/api/channels", who, Value::Null).await.json()["channels"]
        .as_array()
        .unwrap()
        .clone()
}
async fn world() -> World {
    let mut state = AppState::new(":memory:", SETUP).unwrap();
    state.public_auth_limit = 1000;
    let api = app(state.clone(), None);
    let owner = public(
        &api,
        "/api/setup",
        json!({"setup_token":SETUP,"username":"owner","password":"test-password-long","device_name":"test"}),
    )
    .await;
    let alice = invited(&api, &owner, "alice").await;
    let carol = invited(&api, &owner, "carol").await;
    let (owner_id, alice_id, carol_id) = (
        user_id(&api, &owner).await,
        user_id(&api, &alice).await,
        user_id(&api, &carol).await,
    );
    let lounge = channels_of(&api, &owner)
        .await
        .into_iter()
        .find(|c| c["kind"] == "voice")
        .expect("a fresh server has a voice channel")["id"]
        .as_str()
        .unwrap()
        .to_owned();
    World {
        api,
        state,
        owner,
        alice,
        carol,
        owner_id,
        alice_id,
        carol_id,
        lounge,
    }
}

// ---- B1: voice channel kind -------------------------------------------------------------

#[tokio::test]
async fn owner_creates_a_voice_channel_and_a_member_cannot() {
    let w = world().await;
    let made = call(
        &w.api,
        "POST",
        "/api/channels",
        &w.owner,
        json!({"name":"Game night","kind":"voice"}),
    )
    .await;
    assert_eq!(made.status, StatusCode::OK);
    assert_eq!(made.json()["kind"], "voice");
    assert_eq!(made.json()["server_id"], "home");
    let denied = call(
        &w.api,
        "POST",
        "/api/channels",
        &w.alice,
        json!({"name":"Mine","kind":"voice"}),
    )
    .await;
    assert_eq!(denied.status, StatusCode::FORBIDDEN);
}
#[tokio::test]
async fn a_new_voice_channel_includes_every_server_member() {
    let w = world().await;
    let made = call(
        &w.api,
        "POST",
        "/api/channels",
        &w.owner,
        json!({"name":"Game night","kind":"voice"}),
    )
    .await
    .json();
    for who in [&w.owner, &w.alice, &w.carol] {
        assert!(channels_of(&w.api, who)
            .await
            .iter()
            .any(|c| c["id"] == made["id"] && c["kind"] == "voice"));
    }
}
#[tokio::test]
async fn a_fresh_database_has_exactly_one_lounge_and_init_is_idempotent() {
    let w = world().await;
    let count = |state: &AppState| -> i64 {
        state
            .db
            .lock()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM channels WHERE kind='voice' AND name='Lounge'",
                [],
                |r| r.get(0),
            )
            .unwrap()
    };
    assert_eq!(count(&w.state), 1);
    {
        let db = w.state.db.lock().unwrap();
        housecall_server::servers::init(&db).unwrap();
        housecall_server::servers::init(&db).unwrap();
    }
    assert_eq!(count(&w.state), 1);
}
#[tokio::test]
async fn init_adds_a_lounge_to_an_existing_server_and_puts_every_member_in_it() {
    let w = world().await;
    {
        let db = w.state.db.lock().unwrap();
        db.execute("DELETE FROM members WHERE channel_id=?", [&w.lounge])
            .unwrap();
        db.execute("DELETE FROM channels WHERE id=?", [&w.lounge])
            .unwrap();
        housecall_server::servers::init(&db).unwrap();
    }
    for who in [&w.owner, &w.alice, &w.carol] {
        let lounges: Vec<_> = channels_of(&w.api, who)
            .await
            .into_iter()
            .filter(|c| c["kind"] == "voice" && c["name"] == "Lounge")
            .collect();
        assert_eq!(lounges.len(), 1);
    }
}
#[tokio::test]
async fn people_who_join_later_are_added_to_voice_channels() {
    let w = world().await;
    let extra = call(
        &w.api,
        "POST",
        "/api/channels",
        &w.owner,
        json!({"name":"Game night","kind":"voice"}),
    )
    .await
    .json();
    let dave = invited(&w.api, &w.owner, "dave").await;
    let seen = channels_of(&w.api, &dave).await;
    assert!(seen.iter().any(|c| c["id"] == w.lounge));
    assert!(seen.iter().any(|c| c["id"] == extra["id"]));
}
#[tokio::test]
async fn a_second_server_gets_its_own_lounge() {
    let w = world().await;
    let made = call(
        &w.api,
        "POST",
        "/api/servers",
        &w.owner,
        json!({"name":"Second"}),
    )
    .await
    .json();
    let sid = made["id"].as_str().unwrap();
    let voice: Vec<_> = channels_of(&w.api, &w.owner)
        .await
        .into_iter()
        .filter(|c| c["kind"] == "voice" && c["server_id"] == sid)
        .collect();
    assert_eq!(voice.len(), 1);
    assert_eq!(voice[0]["name"], "Lounge");
}
#[tokio::test]
async fn a_voice_channel_has_a_text_chat_that_works_like_any_channel() {
    let w = world().await;
    let sent = call(
        &w.api,
        "POST",
        &format!("/api/channels/{}/messages", w.lounge),
        &w.alice,
        json!({"body":"anyone here?"}),
    )
    .await;
    assert_eq!(sent.status, StatusCode::OK, "{:?}", sent.json());
    let listed = call(
        &w.api,
        "GET",
        &format!("/api/channels/{}/messages", w.lounge),
        &w.owner,
        Value::Null,
    )
    .await
    .json();
    assert!(listed.to_string().contains("anyone here?"));
    let found = call(
        &w.api,
        "GET",
        &format!("/api/channels/{}/messages?q=anyone", w.lounge),
        &w.owner,
        Value::Null,
    )
    .await
    .json();
    assert!(found.to_string().contains("anyone here?"));
}
