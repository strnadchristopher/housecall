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
    call(api, "GET", "/api/channels", who, Value::Null)
        .await
        .json()["channels"]
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

// ---- B2: live voice state and events ----------------------------------------------------

async fn events_of(w: &World, who: &Value, kind: &str) -> Vec<Value> {
    call(&w.api, "GET", "/api/events", who, Value::Null)
        .await
        .json()["events"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["kind"] == kind)
        .cloned()
        .collect()
}
fn state_path(w: &World) -> String {
    format!("/api/channels/{}/voice/state", w.lounge)
}
fn enter(w: &World, user: &str) {
    housecall_server::voice::peer_joined(&w.state, &w.lounge, user);
}
/// Carol leaves the channel's member list, so she is a stranger to it.
fn evict_carol(w: &World) {
    w.state
        .db
        .lock()
        .unwrap()
        .execute(
            "DELETE FROM members WHERE channel_id=? AND user_id=?",
            [&w.lounge, &w.carol_id],
        )
        .unwrap();
}

#[tokio::test]
async fn state_from_a_non_member_is_refused() {
    let w = world().await;
    evict_carol(&w);
    let r = call(
        &w.api,
        "PUT",
        &state_path(&w),
        &w.carol,
        json!({"muted":true,"deafened":false,"camera":false,"sharing":false}),
    )
    .await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
}
#[tokio::test]
async fn state_from_someone_not_in_the_room_is_a_conflict() {
    let w = world().await;
    let r = call(
        &w.api,
        "PUT",
        &state_path(&w),
        &w.alice,
        json!({"muted":true,"deafened":false,"camera":false,"sharing":false}),
    )
    .await;
    assert_eq!(r.status, StatusCode::CONFLICT);
}
#[tokio::test]
async fn joining_announces_defaults_and_state_changes_reach_members_only() {
    let w = world().await;
    evict_carol(&w);
    enter(&w, &w.alice_id);
    let joined = events_of(&w, &w.owner, "voice.joined").await;
    assert_eq!(joined.len(), 1);
    assert_eq!(joined[0]["channel_id"], w.lounge.as_str());
    let p = &joined[0]["payload"];
    assert_eq!(p["channel_id"], w.lounge.as_str());
    assert_eq!(p["user_id"], w.alice_id.as_str());
    for key in ["muted", "deafened", "camera", "sharing"] {
        assert_eq!(p[key], false, "{key}");
    }
    assert!(p["joined_at"].as_i64().unwrap() > 0);
    // Joining again from a second device does not announce a second time.
    enter(&w, &w.alice_id);
    assert_eq!(events_of(&w, &w.owner, "voice.joined").await.len(), 1);

    let r = call(
        &w.api,
        "PUT",
        &state_path(&w),
        &w.alice,
        json!({"muted":true,"deafened":true,"camera":false,"sharing":true}),
    )
    .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    let body = r.json();
    assert_eq!(body["user_id"], w.alice_id.as_str());
    assert_eq!(body["muted"], true);
    assert_eq!(body["sharing"], true);
    let changed = events_of(&w, &w.owner, "voice.state").await;
    assert_eq!(changed.len(), 1);
    assert_eq!(changed[0]["payload"]["deafened"], true);
    assert_eq!(changed[0]["payload"]["user_id"], w.alice_id.as_str());
    // Alice hears her own change too, so a second device of hers stays in sync.
    assert_eq!(events_of(&w, &w.alice, "voice.state").await.len(), 1);
    // Carol is not in the channel: she hears none of it.
    for kind in ["voice.joined", "voice.state", "voice.left"] {
        assert!(events_of(&w, &w.carol, kind).await.is_empty(), "{kind}");
    }
}
#[tokio::test]
async fn a_partial_update_keeps_the_other_flags() {
    let w = world().await;
    enter(&w, &w.alice_id);
    call(
        &w.api,
        "PUT",
        &state_path(&w),
        &w.alice,
        json!({"muted":true}),
    )
    .await;
    let r = call(
        &w.api,
        "PUT",
        &state_path(&w),
        &w.alice,
        json!({"camera":true}),
    )
    .await;
    assert_eq!(r.json()["muted"], true);
    assert_eq!(r.json()["camera"], true);
    assert_eq!(r.json()["sharing"], false);
}
#[tokio::test]
async fn leaving_and_timing_out_clear_state_and_announce_it() {
    let w = world().await;
    enter(&w, &w.alice_id);
    enter(&w, &w.owner_id);
    // Alice leaves through the handler path.
    {
        let db = w.state.db.lock().unwrap();
        housecall_server::voice::peer_left(&db, &w.state.live, &w.lounge, &w.alice_id);
    }
    let left = events_of(&w, &w.owner, "voice.left").await;
    assert_eq!(left.len(), 1);
    assert_eq!(left[0]["payload"]["user_id"], w.alice_id.as_str());
    let r = call(
        &w.api,
        "PUT",
        &state_path(&w),
        &w.alice,
        json!({"muted":true}),
    )
    .await;
    assert_eq!(r.status, StatusCode::CONFLICT, "state is gone after leave");
    // The owner's peer times out: the SFU no longer lists them.
    let later = housecall_server::now() + 60_000;
    housecall_server::voice::reconcile(&w.state, &[], later);
    let left = events_of(&w, &w.alice, "voice.left").await;
    assert!(left
        .iter()
        .any(|e| e["payload"]["user_id"] == w.owner_id.as_str()));
    let rooms = call(&w.api, "GET", "/api/voice/rooms", &w.alice, Value::Null)
        .await
        .json();
    assert_eq!(rooms["states"], json!({}));
}
#[tokio::test]
async fn a_peer_the_sfu_still_lists_is_not_reaped() {
    let w = world().await;
    enter(&w, &w.alice_id);
    let later = housecall_server::now() + 60_000;
    housecall_server::voice::reconcile(&w.state, &[(w.lounge.clone(), w.alice_id.clone())], later);
    assert!(events_of(&w, &w.owner, "voice.left").await.is_empty());
}
#[tokio::test]
async fn a_peer_that_only_just_joined_is_not_reaped_by_a_stale_snapshot() {
    let w = world().await;
    enter(&w, &w.alice_id);
    housecall_server::voice::reconcile(&w.state, &[], housecall_server::now());
    assert!(events_of(&w, &w.owner, "voice.left").await.is_empty());
}
#[tokio::test]
async fn rooms_keeps_its_old_shape_and_adds_states() {
    let w = world().await;
    enter(&w, &w.alice_id);
    call(
        &w.api,
        "PUT",
        &state_path(&w),
        &w.alice,
        json!({"muted":true}),
    )
    .await;
    // Without an SFU the call list is empty; the new key is still there.
    let r = call(&w.api, "GET", "/api/voice/rooms", &w.owner, Value::Null)
        .await
        .json();
    assert_eq!(r["rooms"], json!({}));
    let states = r["states"][&w.lounge].as_array().unwrap();
    assert_eq!(states.len(), 1);
    assert_eq!(states[0]["user_id"], w.alice_id.as_str());
    assert_eq!(states[0]["muted"], true);
    assert!(states[0]["joined_at"].as_i64().unwrap() > 0);
}
#[tokio::test]
async fn a_0_3_0_client_reading_only_rooms_sees_the_same_shape_as_before() {
    let w = world().await;
    enter(&w, &w.alice_id);
    enter(&w, &w.owner_id);
    let peers = vec![
        (w.lounge.clone(), w.alice_id.clone()),
        (w.lounge.clone(), w.alice_id.clone()), // a second device of the same person
        (w.lounge.clone(), w.owner_id.clone()),
        ("not-a-channel-alice-is-in".to_owned(), w.owner_id.clone()),
    ];
    let body = {
        let db = w.state.db.lock().unwrap();
        housecall_server::voice::rooms_json(&db, &w.state.live, &w.alice_id, &peers)
    };
    // Exactly what 0.3.0 produced: {"rooms": {channel_id: [user_id, ...]}}, one entry per person,
    // only for channels the caller belongs to.
    assert_eq!(
        body["rooms"],
        json!({ w.lounge.clone(): [w.alice_id.clone(), w.owner_id.clone()] })
    );
    let mut keys: Vec<_> = body.as_object().unwrap().keys().cloned().collect();
    keys.sort();
    assert_eq!(keys, ["rooms", "states"]);
    for users in body["rooms"].as_object().unwrap().values() {
        assert!(users.as_array().unwrap().iter().all(Value::is_string));
    }
    // States: one record per person.
    let states = body["states"][&w.lounge].as_array().unwrap();
    assert_eq!(states.len(), 2);
    for s in states {
        let mut k: Vec<_> = s.as_object().unwrap().keys().cloned().collect();
        k.sort();
        assert_eq!(
            k,
            [
                "camera",
                "deafened",
                "joined_at",
                "muted",
                "sharing",
                "user_id"
            ]
        );
    }
}
// ---- B3: stream preview -----------------------------------------------------------------

fn jpeg(len: usize) -> Vec<u8> {
    let mut bytes = vec![0xFF, 0xD8, 0xFF, 0xE0];
    bytes.resize(len - 2, 7);
    bytes.extend_from_slice(&[0xFF, 0xD9]);
    bytes
}
fn preview_path(w: &World) -> String {
    format!("/api/channels/{}/voice/preview", w.lounge)
}
async fn put_preview(w: &World, who: &Value, body: Vec<u8>) -> Reply {
    raw(&w.api, "PUT", &preview_path(w), who, "image/jpeg", body).await
}
async fn get_preview(w: &World, who: &Value, of: &str) -> Reply {
    call(
        &w.api,
        "GET",
        &format!("{}/{of}", preview_path(w)),
        who,
        Value::Null,
    )
    .await
}
/// Alice is in the call and sharing her screen.
async fn sharing(w: &World) {
    enter(w, &w.alice_id);
    let r = call(
        &w.api,
        "PUT",
        &state_path(w),
        &w.alice,
        json!({"sharing":true}),
    )
    .await;
    assert_eq!(r.status, StatusCode::OK);
}
/// Pretend the last preview was stored long ago, so the rate limit has passed.
fn age_preview(w: &World) {
    for p in w.state.live.previews.lock().unwrap().values_mut() {
        p.stored_at -= 11_000;
    }
}
#[tokio::test]
async fn a_preview_round_trips_with_safe_headers_to_members() {
    let w = world().await;
    sharing(&w).await;
    let image = jpeg(5_000);
    let put = put_preview(&w, &w.alice, image.clone()).await;
    assert_eq!(put.status, StatusCode::OK, "{:?}", put.json());
    let got = get_preview(&w, &w.owner, &w.alice_id).await;
    assert_eq!(got.status, StatusCode::OK);
    assert_eq!(got.bytes, image);
    assert_eq!(got.headers["content-type"], "image/jpeg");
    assert_eq!(got.headers["cache-control"], "no-store");
    assert_eq!(got.headers["x-content-type-options"], "nosniff");
}
#[tokio::test]
async fn a_preview_needs_an_active_share() {
    let w = world().await;
    // Not in the call at all.
    assert_eq!(
        put_preview(&w, &w.alice, jpeg(500)).await.status,
        StatusCode::CONFLICT
    );
    // In the call but not sharing.
    enter(&w, &w.alice_id);
    assert_eq!(
        put_preview(&w, &w.alice, jpeg(500)).await.status,
        StatusCode::CONFLICT
    );
}
#[tokio::test]
async fn preview_size_limit_is_64_kilobytes() {
    let w = world().await;
    sharing(&w).await;
    assert_eq!(
        put_preview(&w, &w.alice, jpeg(64 * 1024 + 1)).await.status,
        StatusCode::PAYLOAD_TOO_LARGE
    );
    assert_eq!(
        put_preview(&w, &w.alice, jpeg(64 * 1024)).await.status,
        StatusCode::OK
    );
}
#[tokio::test]
async fn previews_are_limited_to_one_per_ten_seconds() {
    let w = world().await;
    sharing(&w).await;
    assert_eq!(
        put_preview(&w, &w.alice, jpeg(500)).await.status,
        StatusCode::OK
    );
    assert_eq!(
        put_preview(&w, &w.alice, jpeg(600)).await.status,
        StatusCode::TOO_MANY_REQUESTS
    );
    // The refused one did not replace the stored image.
    assert_eq!(
        get_preview(&w, &w.owner, &w.alice_id).await.bytes.len(),
        500
    );
    age_preview(&w);
    assert_eq!(
        put_preview(&w, &w.alice, jpeg(600)).await.status,
        StatusCode::OK
    );
    assert_eq!(
        get_preview(&w, &w.owner, &w.alice_id).await.bytes.len(),
        600
    );
}
#[tokio::test]
async fn only_jpeg_is_accepted() {
    let w = world().await;
    sharing(&w).await;
    let wrong_type = raw(
        &w.api,
        "PUT",
        &preview_path(&w),
        &w.alice,
        "image/svg+xml",
        jpeg(500),
    )
    .await;
    assert_eq!(wrong_type.status, StatusCode::UNSUPPORTED_MEDIA_TYPE);
    let not_jpeg = raw(
        &w.api,
        "PUT",
        &preview_path(&w),
        &w.alice,
        "image/jpeg",
        b"<svg xmlns='http://www.w3.org/2000/svg'></svg>".to_vec(),
    )
    .await;
    assert_eq!(not_jpeg.status, StatusCode::UNSUPPORTED_MEDIA_TYPE);
}
#[tokio::test]
async fn non_members_can_neither_read_nor_write_previews() {
    let w = world().await;
    sharing(&w).await;
    put_preview(&w, &w.alice, jpeg(500)).await;
    evict_carol(&w);
    assert_eq!(
        get_preview(&w, &w.carol, &w.alice_id).await.status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        put_preview(&w, &w.carol, jpeg(500)).await.status,
        StatusCode::FORBIDDEN
    );
}
#[tokio::test]
async fn no_preview_is_a_404() {
    let w = world().await;
    sharing(&w).await;
    assert_eq!(
        get_preview(&w, &w.owner, &w.alice_id).await.status,
        StatusCode::NOT_FOUND
    );
}
#[tokio::test]
async fn stopping_the_share_clears_the_preview() {
    let w = world().await;
    sharing(&w).await;
    put_preview(&w, &w.alice, jpeg(500)).await;
    call(
        &w.api,
        "PUT",
        &state_path(&w),
        &w.alice,
        json!({"sharing":false}),
    )
    .await;
    assert_eq!(
        get_preview(&w, &w.owner, &w.alice_id).await.status,
        StatusCode::NOT_FOUND
    );
}
#[tokio::test]
async fn leaving_clears_the_preview_and_a_late_one_is_refused() {
    let w = world().await;
    sharing(&w).await;
    put_preview(&w, &w.alice, jpeg(500)).await;
    {
        let db = w.state.db.lock().unwrap();
        housecall_server::voice::peer_left(&db, &w.state.live, &w.lounge, &w.alice_id);
    }
    assert_eq!(
        get_preview(&w, &w.owner, &w.alice_id).await.status,
        StatusCode::NOT_FOUND
    );
    age_preview(&w);
    assert_eq!(
        put_preview(&w, &w.alice, jpeg(500)).await.status,
        StatusCode::CONFLICT
    );
}
#[tokio::test]
async fn a_peer_timeout_clears_the_preview() {
    let w = world().await;
    sharing(&w).await;
    put_preview(&w, &w.alice, jpeg(500)).await;
    housecall_server::voice::reconcile(&w.state, &[], housecall_server::now() + 60_000);
    assert_eq!(
        get_preview(&w, &w.owner, &w.alice_id).await.status,
        StatusCode::NOT_FOUND
    );
}
#[tokio::test]
async fn rooms_and_states_hide_channels_the_caller_is_not_in() {
    let w = world().await;
    enter(&w, &w.alice_id);
    evict_carol(&w);
    let r = call(&w.api, "GET", "/api/voice/rooms", &w.carol, Value::Null)
        .await
        .json();
    assert_eq!(r["states"], json!({}));
}
