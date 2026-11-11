//! 1:1 calls through the server: ring and decline in a direct conversation.
use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use housecall_server::{app, AppState};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;

const SETUP: &str = "bootstrap-long-enough-for-test-secret";

async fn call(
    api: &Router,
    method: &str,
    path: &str,
    auth: Option<&Value>,
    body: Value,
) -> (StatusCode, Value) {
    let mut b = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    if let Some(a) = auth {
        b = b
            .header(
                "authorization",
                format!("Bearer {}", a["token"].as_str().unwrap()),
            )
            .header("x-device-key", a["device_key"].as_str().unwrap());
    }
    let response = api
        .clone()
        .oneshot(b.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

struct World {
    api: Router,
    state: AppState,
    owner: Value,
    alice: Value,
    bob: Value,
    carol: Value,
    /// Direct conversation between Alice and Bob.
    dm: String,
}
async fn join(api: &Router, owner: &Value, name: &str) -> Value {
    let invite = call(
        api,
        "POST",
        "/api/invites",
        Some(owner),
        json!({"email":format!("{name}@example.test"),"expires_in_seconds":60}),
    )
    .await
    .1;
    call(
        api,
        "POST",
        "/api/invites/accept",
        None,
        json!({"token":invite["token"],"username":name,"password":"password-long-enough","device_name":"test"}),
    )
    .await
    .1
}
async fn world() -> World {
    let mut state = AppState::new(":memory:", SETUP).unwrap();
    state.public_auth_limit = 1000;
    let api = app(state.clone(), None);
    let owner = call(
        &api,
        "POST",
        "/api/setup",
        None,
        json!({"setup_token":SETUP,"username":"owner","password":"password-long-enough","device_name":"test"}),
    )
    .await
    .1;
    let alice = join(&api, &owner, "alice").await;
    let bob = join(&api, &owner, "bob").await;
    let carol = join(&api, &owner, "carol").await;
    let dm = call(
        &api,
        "POST",
        "/api/channels",
        Some(&alice),
        json!({"name":"alice and bob","kind":"dm","member_ids":[bob["user"]["id"]]}),
    )
    .await
    .1["id"]
        .as_str()
        .unwrap()
        .to_owned();
    World {
        api,
        state,
        owner,
        alice,
        bob,
        carol,
        dm,
    }
}
/// Event kinds a user has been sent (the whole log).
async fn kinds(w: &World, who: &Value) -> Vec<(String, Value)> {
    let (status, body) = call(&w.api, "GET", "/api/events?after=0", Some(who), json!(null)).await;
    assert_eq!(status, StatusCode::OK);
    body["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| (e["kind"].as_str().unwrap().to_owned(), e.clone()))
        .collect()
}
fn count(events: &[(String, Value)], kind: &str) -> usize {
    events.iter().filter(|(k, _)| k == kind).count()
}
fn ring_path(channel: &str) -> String {
    format!("/api/channels/{channel}/ring")
}

#[tokio::test]
async fn ring_reaches_only_the_other_member_with_who_and_where() {
    let w = world().await;
    w.state
        .db
        .lock()
        .unwrap()
        .execute(
            "UPDATE users SET display_name='Alice Example' WHERE username='alice'",
            [],
        )
        .unwrap();
    let (status, body) = call(&w.api, "POST", &ring_path(&w.dm), Some(&w.alice), json!({})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["ringing"], true);
    let bob = kinds(&w, &w.bob).await;
    let rings: Vec<_> = bob.iter().filter(|(k, _)| k == "call.ring").collect();
    assert_eq!(rings.len(), 1);
    let ring = &rings[0].1;
    assert_eq!(ring["channel_id"], w.dm);
    assert_eq!(ring["payload"]["channel_id"], w.dm);
    assert_eq!(ring["payload"]["from"], w.alice["user"]["id"]);
    assert_eq!(ring["payload"]["from_name"], "Alice Example");
    // The caller and everyone else get nothing, including the owner and a stranger.
    for other in [&w.alice, &w.owner, &w.carol] {
        assert_eq!(count(&kinds(&w, other).await, "call.ring"), 0);
    }
}

#[tokio::test]
async fn only_a_two_person_direct_conversation_can_be_rung() {
    let w = world().await;
    let channel = call(
        &w.api,
        "POST",
        "/api/channels",
        Some(&w.owner),
        json!({"name":"lounge","kind":"channel","member_ids":[w.alice["user"]["id"],w.bob["user"]["id"]]}),
    )
    .await
    .1["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let group = call(
        &w.api,
        "POST",
        "/api/channels",
        Some(&w.alice),
        json!({"name":"three","kind":"group_dm","member_ids":[w.bob["user"]["id"],w.carol["user"]["id"]]}),
    )
    .await
    .1["id"]
        .as_str()
        .unwrap()
        .to_owned();
    for target in [&channel, &group] {
        assert_eq!(
            call(
                &w.api,
                "POST",
                &ring_path(target),
                Some(&w.alice),
                json!({})
            )
            .await
            .0,
            StatusCode::BAD_REQUEST,
            "{target}"
        );
        assert_eq!(
            call(
                &w.api,
                "POST",
                &format!("{}/decline", ring_path(target)),
                Some(&w.alice),
                json!({})
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
    }
    for who in [&w.alice, &w.bob, &w.carol] {
        assert_eq!(count(&kinds(&w, who).await, "call.ring"), 0);
    }
}

#[tokio::test]
async fn a_non_member_and_a_missing_conversation_are_forbidden() {
    let w = world().await;
    for path in [
        ring_path(&w.dm),
        format!("{}/decline", ring_path(&w.dm)),
        ring_path("no-such-conversation"),
    ] {
        assert_eq!(
            call(&w.api, "POST", &path, Some(&w.carol), json!({}))
                .await
                .0,
            StatusCode::FORBIDDEN,
            "{path}"
        );
        assert_eq!(
            call(&w.api, "POST", &path, None, json!({})).await.0,
            StatusCode::UNAUTHORIZED
        );
    }
    for who in [&w.alice, &w.bob] {
        let log = kinds(&w, who).await;
        assert_eq!(count(&log, "call.ring"), 0);
        assert_eq!(count(&log, "call.declined"), 0);
    }
}

#[tokio::test]
async fn a_second_ring_within_ten_seconds_is_refused_per_conversation() {
    let w = world().await;
    let first = call(&w.api, "POST", &ring_path(&w.dm), Some(&w.alice), json!({})).await;
    assert_eq!(first.0, StatusCode::OK);
    // The same caller ringing again inside the window is refused.
    assert_eq!(
        call(&w.api, "POST", &ring_path(&w.dm), Some(&w.alice), json!({}))
            .await
            .0,
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(count(&kinds(&w, &w.bob).await, "call.ring"), 1);
    assert_eq!(count(&kinds(&w, &w.alice).await, "call.ring"), 0);
    // Another conversation is not held up by this one.
    let other = call(
        &w.api,
        "POST",
        "/api/channels",
        Some(&w.alice),
        json!({"name":"alice and carol","kind":"dm","member_ids":[w.carol["user"]["id"]]}),
    )
    .await
    .1["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        call(
            &w.api,
            "POST",
            &ring_path(&other),
            Some(&w.alice),
            json!({})
        )
        .await
        .0,
        StatusCode::OK
    );
    // Once the window has passed the same caller can ring again.
    w.state.rings.lock().unwrap().insert(
        format!("{}:{}", w.dm, w.alice["user"]["id"].as_str().unwrap()),
        housecall_server::now() - 10_001,
    );
    assert_eq!(
        call(&w.api, "POST", &ring_path(&w.dm), Some(&w.alice), json!({}))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(count(&kinds(&w, &w.bob).await, "call.ring"), 2);
}

#[tokio::test]
async fn declining_lets_the_callee_ring_back_at_once_and_a_cancel_lets_the_caller_retry() {
    let w = world().await;
    let decline = format!("{}/decline", ring_path(&w.dm));
    assert_eq!(
        call(&w.api, "POST", &ring_path(&w.dm), Some(&w.alice), json!({}))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        call(&w.api, "POST", &decline, Some(&w.bob), json!({}))
            .await
            .0,
        StatusCode::OK
    );
    // Bob calls Alice back straight after declining: she is rung.
    assert_eq!(
        call(&w.api, "POST", &ring_path(&w.dm), Some(&w.bob), json!({}))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(count(&kinds(&w, &w.alice).await, "call.ring"), 1);
    // Alice cancels and rings again at once.
    assert_eq!(
        call(&w.api, "POST", &decline, Some(&w.alice), json!({}))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        call(&w.api, "POST", &ring_path(&w.dm), Some(&w.alice), json!({}))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(count(&kinds(&w, &w.bob).await, "call.ring"), 2);
}

#[tokio::test]
async fn decline_goes_to_the_other_member_only_and_is_not_rate_limited_like_a_ring() {
    let w = world().await;
    let path = format!("{}/decline", ring_path(&w.dm));
    for _ in 0..2 {
        let (status, body) = call(&w.api, "POST", &path, Some(&w.bob), json!({})).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["declined"], true);
    }
    let alice = kinds(&w, &w.alice).await;
    let declined: Vec<_> = alice.iter().filter(|(k, _)| k == "call.declined").collect();
    assert_eq!(declined.len(), 2);
    assert_eq!(declined[0].1["payload"]["from"], w.bob["user"]["id"]);
    assert_eq!(declined[0].1["channel_id"], w.dm);
    for other in [&w.bob, &w.owner, &w.carol] {
        assert_eq!(count(&kinds(&w, other).await, "call.declined"), 0);
    }
}

#[tokio::test]
async fn channel_list_names_the_peer_of_a_direct_conversation_and_events_carry_server_time() {
    let w = world().await;
    for (who, peer) in [(&w.alice, &w.bob), (&w.bob, &w.alice)] {
        let (_, list) = call(&w.api, "GET", "/api/channels", Some(who), json!(null)).await;
        let channels = list["channels"].as_array().unwrap();
        let dm = channels.iter().find(|c| c["id"] == w.dm).unwrap();
        assert_eq!(dm["peer_id"], peer["user"]["id"]);
        let general = channels.iter().find(|c| c["kind"] == "channel").unwrap();
        assert!(general["peer_id"].is_null());
    }
    let before = housecall_server::now();
    let (_, events) = call(
        &w.api,
        "GET",
        "/api/events?after=0",
        Some(&w.bob),
        json!(null),
    )
    .await;
    let at = events["now"].as_i64().unwrap();
    assert!(at >= before && at <= housecall_server::now());
}
