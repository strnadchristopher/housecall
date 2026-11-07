use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use chriscord_server::{app, AppState};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;
const SETUP: &str = "test-bootstrap-credential-32-characters";
async fn call(
    app: &Router,
    method: &str,
    path: &str,
    auth: Option<&Value>,
    body: Value,
) -> (StatusCode, Value) {
    let mut req = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    if let Some(a) = auth {
        req = req
            .header(
                "authorization",
                format!("Bearer {}", a["token"].as_str().unwrap()),
            )
            .header("x-device-key", a["device_key"].as_str().unwrap());
    }
    let response = app
        .clone()
        .oneshot(req.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    assert!(response.headers().contains_key("content-security-policy"));
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, value)
}
async fn fixture() -> (Router, AppState, Value, Value, Value) {
    let mut state = AppState::new(":memory:", SETUP).unwrap();
    state.public_auth_limit = 1000;
    let api = app(state.clone(), None);
    let(status,a)=call(&api,"POST","/api/setup",None,json!({"setup_token":SETUP,"username":"owner","password":"test-password-long","device_name":"test"})).await;
    assert_eq!(status, StatusCode::OK, "{a}");
    let b = join(&api, &a, "alice").await;
    let c = join(&api, &a, "bob").await;
    (api, state, a, b, c)
}
async fn join(api: &Router, owner: &Value, name: &str) -> Value {
    let (s, v) = call(
        api,
        "POST",
        "/api/invites",
        Some(owner),
        json!({"expires_in_seconds":3600}),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    let(s,u)=call(api,"POST","/api/invites/accept",None,json!({"token":v["token"],"username":name,"password":"test-password-long","device_name":"test"})).await;
    assert_eq!(s, StatusCode::OK, "{u}");
    u
}
#[tokio::test]
async fn all_private_endpoints_reject_unauthenticated() {
    let api = app(AppState::new(":memory:", SETUP).unwrap(), None);
    let routes = [
        ("GET", "/api/me"),
        ("GET", "/api/giphy/search?q=x"),
        ("GET", "/api/giphy/media/id"),
        ("POST", "/api/invites"),
        ("GET", "/api/invites"),
        ("DELETE", "/api/invites/id"),
        ("DELETE", "/api/users/id/sessions"),
        ("GET", "/api/devices"),
        ("DELETE", "/api/devices/id"),
        ("GET", "/api/channels"),
        ("POST", "/api/channels"),
        ("GET", "/api/members"),
        ("GET", "/api/channels/id/messages"),
        ("POST", "/api/channels/id/messages"),
        ("PATCH", "/api/messages/id"),
        ("DELETE", "/api/messages/id"),
        ("POST", "/api/messages/id/reactions"),
        ("POST", "/api/messages/id/pin"),
        ("POST", "/api/channels/id/read"),
        ("POST", "/api/channels/id/typing"),
        ("GET", "/api/notifications"),
        ("GET", "/api/events"),
        ("POST", "/api/reports"),
        ("GET", "/api/reports"),
        ("GET", "/api/reports/id/screenshot"),
        ("PATCH", "/api/reports/id"),
    ];
    for (method, path) in routes {
        assert_eq!(
            call(&api, method, path, None, json!({})).await.0,
            StatusCode::UNAUTHORIZED,
            "{method} {path}"
        )
    }
}
#[tokio::test]
async fn membership_and_owner_authorization_matrix() {
    let (api, _, a, b, c) = fixture().await;
    let (s, dm) = call(
        &api,
        "POST",
        "/api/channels",
        Some(&a),
        json!({"name":"private","kind":"dm","member_ids":[b["user"]["id"]]}),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    let cid = dm["id"].as_str().unwrap();
    let path = format!("/api/channels/{cid}/messages");
    let (s, msg) = call(
        &api,
        "POST",
        &path,
        Some(&a),
        json!({"body":"private secret","mention_ids":[b["user"]["id"]]}),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    let mid = msg["id"].as_str().unwrap();
    for (method, path, body) in [
        ("GET", path.clone(), json!({})),
        ("POST", path.clone(), json!({"body":"intrusion"})),
        (
            "PATCH",
            format!("/api/messages/{mid}"),
            json!({"body":"stolen","revision":1}),
        ),
        ("DELETE", format!("/api/messages/{mid}"), json!({})),
        (
            "POST",
            format!("/api/messages/{mid}/reactions"),
            json!({"emoji":"x"}),
        ),
        (
            "POST",
            format!("/api/messages/{mid}/pin"),
            json!({"pinned":true}),
        ),
        (
            "POST",
            format!("/api/channels/{cid}/read"),
            json!({"message_id":mid}),
        ),
        (
            "POST",
            format!("/api/channels/{cid}/typing"),
            json!({"active":true}),
        ),
    ] {
        assert_eq!(
            call(&api, method, &path, Some(&c), body).await.0,
            StatusCode::FORBIDDEN,
            "{method} {path}"
        )
    }
    assert_eq!(
        call(
            &api,
            "PATCH",
            &format!("/api/messages/{mid}"),
            Some(&b),
            json!({"body":"not mine","revision":1})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(
            &api,
            "DELETE",
            &format!("/api/messages/{mid}"),
            Some(&b),
            json!({})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    for (method, path, body) in [
        ("POST", "/api/invites", json!({"expires_in_seconds":60})),
        (
            "POST",
            "/api/channels",
            json!({"name":"oops","kind":"channel"}),
        ),
        ("GET", "/api/reports", json!({})),
        ("GET", "/api/reports/id/screenshot", json!({})),
        ("PATCH", "/api/reports/id", json!({"status":"resolved"})),
    ] {
        assert_eq!(
            call(&api, method, path, Some(&b), body).await.0,
            StatusCode::FORBIDDEN
        )
    }
    let (_, c_channels) = call(&api, "GET", "/api/channels", Some(&c), json!({})).await;
    assert!(!c_channels.to_string().contains(cid));
    let (_, events) = call(&api, "GET", "/api/events?after=0", Some(&c), json!({})).await;
    assert!(!events.to_string().contains(mid));
    let (_, notes) = call(&api, "GET", "/api/notifications", Some(&c), json!({})).await;
    assert!(notes["notifications"].as_array().unwrap().is_empty());
    let (_, adev) = call(&api, "GET", "/api/devices", Some(&a), json!({})).await;
    let aid = adev["devices"][0]["id"].as_str().unwrap();
    assert_eq!(
        call(
            &api,
            "DELETE",
            &format!("/api/devices/{aid}"),
            Some(&b),
            json!({})
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
}
#[tokio::test]
async fn unsend_purges_content_notifications_reactions_pins_and_search() {
    let (api, state, a, b, _) = fixture().await;
    let (_, msg) = call(
        &api,
        "POST",
        "/api/channels/general/messages",
        Some(&a),
        json!({"body":"secret-needle","mention_ids":[b["user"]["id"]]}),
    )
    .await;
    let id = msg["id"].as_str().unwrap();
    assert_eq!(
        call(
            &api,
            "POST",
            &format!("/api/messages/{id}/reactions"),
            Some(&b),
            json!({"emoji":"👍"})
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            &api,
            "POST",
            &format!("/api/messages/{id}/pin"),
            Some(&b),
            json!({"pinned":true})
        )
        .await
        .0,
        StatusCode::OK
    );
    let (_, notes) = call(&api, "GET", "/api/notifications", Some(&b), json!({})).await;
    assert_eq!(notes["notifications"].as_array().unwrap().len(), 1);
    assert_eq!(
        call(
            &api,
            "DELETE",
            &format!("/api/messages/{id}"),
            Some(&a),
            json!({})
        )
        .await
        .0,
        StatusCode::OK
    );
    for path in [
        "/api/channels/general/messages?q=secret-needle",
        "/api/channels/general/messages?pinned=true",
        "/api/notifications",
    ] {
        let (_, v) = call(&api, "GET", path, Some(&b), json!({})).await;
        assert!(!v.to_string().contains(id));
    }
    let (_, v) = call(&api, "GET", "/api/events?after=0", Some(&b), json!({})).await;
    assert!(v["events"]
        .as_array()
        .unwrap()
        .iter()
        .any(|e| e["kind"] == "message.deleted" && e["payload"]["message_id"] == id));
    assert!(!v.to_string().contains("secret-needle"));
    let db = state.db.lock().unwrap();
    for table in ["messages", "reactions", "notifications"] {
        assert_eq!(
            db.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        )
    }
}
#[tokio::test]
async fn invite_single_use_race_expiry_and_transaction_rollback() {
    let (api, state, a, _, _) = fixture().await;
    let (_, invite) = call(
        &api,
        "POST",
        "/api/invites",
        Some(&a),
        json!({"expires_in_seconds":60}),
    )
    .await;
    let body = |name| json!({"token":invite["token"],"username":name,"password":"test-password-long","device_name":"test"});
    let (one, two) = tokio::join!(
        call(&api, "POST", "/api/invites/accept", None, body("race1")),
        call(&api, "POST", "/api/invites/accept", None, body("race2"))
    );
    assert_eq!(
        [one.0, two.0]
            .iter()
            .filter(|s| **s == StatusCode::OK)
            .count(),
        1
    );
    assert_eq!(
        call(&api, "POST", "/api/invites/accept", None, body("reuse"))
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    let (_, invite) = call(
        &api,
        "POST",
        "/api/invites",
        Some(&a),
        json!({"expires_in_seconds":60}),
    )
    .await;
    let body = |name| json!({"token":invite["token"],"username":name,"password":"test-password-long","device_name":"test"});
    assert_eq!(
        call(&api, "POST", "/api/invites/accept", None, body("owner"))
            .await
            .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        call(&api, "POST", "/api/invites/accept", None, body("unique"))
            .await
            .0,
        StatusCode::OK
    );
    let (_, invite) = call(
        &api,
        "POST",
        "/api/invites",
        Some(&a),
        json!({"expires_in_seconds":60}),
    )
    .await;
    state
        .db
        .lock()
        .unwrap()
        .execute("UPDATE invites SET expires_at=0", [])
        .unwrap();
    assert_eq!(call(&api,"POST","/api/invites/accept",None,json!({"token":invite["token"],"username":"expired","password":"test-password-long","device_name":"test"})).await.0,StatusCode::BAD_REQUEST);
}
#[tokio::test]
async fn session_binding_revocation_login_and_setup_guard() {
    let (api, _, a, b, _) = fixture().await;
    let mut stolen = a.clone();
    stolen["device_key"] = b["device_key"].clone();
    assert_eq!(
        call(&api, "GET", "/api/me", Some(&stolen), json!({}))
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    let (_, me) = call(&api, "GET", "/api/me", Some(&a), json!({})).await;
    assert_eq!(
        call(
            &api,
            "DELETE",
            &format!("/api/devices/{}", me["session_id"].as_str().unwrap()),
            Some(&a),
            json!({})
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(&api, "GET", "/api/me", Some(&a), json!({})).await.0,
        StatusCode::UNAUTHORIZED
    );
    let (s, login) = call(
        &api,
        "POST",
        "/api/login",
        None,
        json!({"username":"owner","password":"test-password-long","device_name":"new"}),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert_ne!(a["token"], login["token"]);
    assert_eq!(call(&api,"POST","/api/setup",None,json!({"setup_token":SETUP,"username":"owner2","password":"test-password-long","device_name":"new"})).await.0,StatusCode::CONFLICT);
    assert_eq!(
        call(
            &api,
            "POST",
            "/api/login",
            None,
            json!({"username":"owner","password":"wrong-password-long","device_name":"new"})
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
}
#[tokio::test]
async fn consent_limits_edits_and_read_state() {
    let (api, _, a, b, _) = fixture().await;
    assert_eq!(
        call(
            &api,
            "POST",
            "/api/reports",
            Some(&b),
            json!({"kind":"bug","body":"test","logs":"Authorization: private"})
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let(s,report)=call(&api,"POST","/api/reports",Some(&b),json!({"kind":"bug","body":"test","logs":"Authorization: private\nnormal","logs_consent":true})).await;
    assert_eq!(s, StatusCode::OK);
    let (_, reports) = call(&api, "GET", "/api/reports", Some(&a), json!({})).await;
    assert!(!reports.to_string().contains("private"));
    assert_eq!(
        call(
            &api,
            "PATCH",
            &format!("/api/reports/{}", report["id"].as_str().unwrap()),
            Some(&a),
            json!({"status":"resolved"})
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            &api,
            "POST",
            "/api/channels/general/messages",
            Some(&b),
            json!({"body":"@everyone spam"})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (_, msg) = call(
        &api,
        "POST",
        "/api/channels/general/messages",
        Some(&a),
        json!({"body":"@everyone hi"}),
    )
    .await;
    let id = msg["id"].as_str().unwrap();
    assert_eq!(
        call(
            &api,
            "PATCH",
            &format!("/api/messages/{id}"),
            Some(&a),
            json!({"body":"edited","revision":1})
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            &api,
            "PATCH",
            &format!("/api/messages/{id}"),
            Some(&a),
            json!({"body":"lost update","revision":1})
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        call(
            &api,
            "POST",
            "/api/channels/general/read",
            Some(&b),
            json!({"message_id":id})
        )
        .await
        .0,
        StatusCode::OK
    );
    let (_, v) = call(&api, "GET", "/api/notifications", Some(&b), json!({})).await;
    assert!(v["notifications"].as_array().unwrap().is_empty());
    assert_eq!(
        call(
            &api,
            "POST",
            "/api/channels/general/messages",
            Some(&b),
            json!({"body":"x".repeat(16385)})
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
}
#[tokio::test]
async fn rate_limits_and_no_remote_embed_fetch() {
    let mut s = AppState::new(":memory:", SETUP).unwrap();
    s.public_auth_limit = 1;
    let api = app(s, None);
    assert_eq!(
        call(
            &api,
            "POST",
            "/api/login",
            None,
            json!({"username":"x","password":"x","device_name":"x"})
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        call(&api, "POST", "/api/login", None, json!({})).await.0,
        StatusCode::TOO_MANY_REQUESTS
    );
    let (api, _, a, _, _) = fixture().await;
    let (s, m) = call(
        &api,
        "POST",
        "/api/channels/general/messages",
        Some(&a),
        json!({"body":"http://169.254.169.254/latest/meta-data/ <script>alert(1)</script>"}),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert!(m["body"].as_str().unwrap().contains("169.254"));
    assert!(m.get("embed").is_none());
}
proptest::proptest! {#[test]fn username_parser_is_total(s in ".{0,512}"){let valid=chriscord_server::valid_username(&s);if valid{proptest::prop_assert!((2..=32).contains(&s.len()));proptest::prop_assert!(s.is_ascii());}let redacted=chriscord_server::redact_logs(&s);proptest::prop_assert!(redacted.len()<=s.len()+40);}}

#[tokio::test]
async fn owner_invite_and_user_session_revocation() {
    let (api, _, a, b, _) = fixture().await;
    for (method, path) in [
        ("GET", "/api/invites"),
        ("DELETE", "/api/invites/id"),
        ("DELETE", "/api/users/id/sessions"),
    ] {
        assert_eq!(
            call(&api, method, path, Some(&b), json!({})).await.0,
            StatusCode::FORBIDDEN
        )
    }
    let (_, invite) = call(
        &api,
        "POST",
        "/api/invites",
        Some(&a),
        json!({"expires_in_seconds":60}),
    )
    .await;
    let (_, list) = call(&api, "GET", "/api/invites", Some(&a), json!({})).await;
    assert!(!list.to_string().contains(invite["token"].as_str().unwrap()));
    assert_eq!(
        call(
            &api,
            "DELETE",
            &format!("/api/invites/{}", invite["id"].as_str().unwrap()),
            Some(&a),
            json!({})
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(call(&api,"POST","/api/invites/accept",None,json!({"token":invite["token"],"username":"revoked","password":"test-password-long","device_name":"test"})).await.0,StatusCode::BAD_REQUEST);
    assert_eq!(
        call(
            &api,
            "DELETE",
            &format!("/api/users/{}/sessions", b["user"]["id"].as_str().unwrap()),
            Some(&a),
            json!({})
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(&api, "GET", "/api/me", Some(&b), json!({})).await.0,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn credential_burst_has_bounded_memory_and_fails_fast() {
    let state = AppState::new(":memory:", SETUP).unwrap();
    let _permits = state
        .auth_slots
        .clone()
        .acquire_many_owned(2)
        .await
        .unwrap();
    let api = app(state, None);
    for (path, payload) in [
        (
            "/api/setup",
            json!({"setup_token":SETUP,"username":"owner","password":"test-password-long","device_name":"test"}),
        ),
        (
            "/api/login",
            json!({"username":"owner","password":"test-password-long","device_name":"test"}),
        ),
        (
            "/api/invites/accept",
            json!({"token":"a".repeat(64),"username":"owner","password":"test-password-long","device_name":"test"}),
        ),
    ] {
        assert_eq!(
            call(&api, "POST", path, None, payload).await.0,
            StatusCode::TOO_MANY_REQUESTS,
            "{path}"
        );
    }
}

#[tokio::test]
async fn server_namespaces_role_mentions_and_threads_are_scoped() {
    let (api, _, owner, alice, bob) = fixture().await;
    for (method, path) in [
        ("GET", "/api/servers"),
        ("POST", "/api/servers"),
        ("GET", "/api/servers/id/members"),
        ("POST", "/api/servers/id/members"),
        ("GET", "/api/servers/id/roles"),
        ("POST", "/api/servers/id/roles"),
        ("POST", "/api/roles/id/members"),
        ("DELETE", "/api/roles/id/members/user"),
        ("DELETE", "/api/roles/id"),
    ] {
        assert_eq!(
            call(&api, method, path, None, json!({})).await.0,
            StatusCode::UNAUTHORIZED,
            "{method} {path}"
        )
    }
    assert_eq!(
        call(
            &api,
            "POST",
            "/api/servers",
            Some(&alice),
            json!({"name":"unauthorized"})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (status, server) = call(
        &api,
        "POST",
        "/api/servers",
        Some(&owner),
        json!({"name":"Cinema"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let sid = server["id"].as_str().unwrap();
    let cid = server["general_channel_id"].as_str().unwrap();
    let members = format!("/api/servers/{sid}/members");
    let roles = format!("/api/servers/{sid}/roles");
    for path in [&members, &roles] {
        assert_eq!(
            call(&api, "GET", path, Some(&bob), json!({})).await.0,
            StatusCode::FORBIDDEN
        )
    }
    assert_eq!(
        call(
            &api,
            "POST",
            &members,
            Some(&alice),
            json!({"user_id":bob["user"]["id"]})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(
            &api,
            "POST",
            &members,
            Some(&owner),
            json!({"user_id":alice["user"]["id"]})
        )
        .await
        .0,
        StatusCode::OK
    );
    let (status, role) = call(
        &api,
        "POST",
        &roles,
        Some(&owner),
        json!({"name":"Movie fans"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let rid = role["id"].as_str().unwrap();
    let assign = format!("/api/roles/{rid}/members");
    assert_eq!(
        call(
            &api,
            "POST",
            &assign,
            Some(&alice),
            json!({"user_id":alice["user"]["id"]})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(
            &api,
            "POST",
            &assign,
            Some(&owner),
            json!({"user_id":bob["user"]["id"]})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(
            &api,
            "POST",
            &assign,
            Some(&owner),
            json!({"user_id":alice["user"]["id"]})
        )
        .await
        .0,
        StatusCode::OK
    );
    let (status, parent) = call(
        &api,
        "POST",
        &format!("/api/channels/{cid}/messages"),
        Some(&owner),
        json!({"body":"Movie night","role_mention_ids":[rid]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(parent["mention_ids"], json!([alice["user"]["id"]]));
    let (_, notes) = call(&api, "GET", "/api/notifications", Some(&alice), json!({})).await;
    assert_eq!(notes["notifications"].as_array().unwrap().len(), 1);
    assert_eq!(
        call(
            &api,
            "POST",
            "/api/channels/general/messages",
            Some(&owner),
            json!({"body":"wrong server","role_mention_ids":[rid]})
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let (_, private) = call(
        &api,
        "POST",
        "/api/channels",
        Some(&owner),
        json!({"name":"secret","kind":"channel","server_id":sid}),
    )
    .await;
    let (_, msg) = call(
        &api,
        "POST",
        &format!("/api/channels/{}/messages", private["id"].as_str().unwrap()),
        Some(&owner),
        json!({"body":"private role mention","role_mention_ids":[rid]}),
    )
    .await;
    assert_eq!(msg["mention_ids"], json!([]));
    let mid = parent["id"].as_str().unwrap();
    let (status, reply) = call(
        &api,
        "POST",
        &format!("/api/channels/{cid}/messages"),
        Some(&alice),
        json!({"body":"I'm in","reply_to":mid}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (_, thread) = call(
        &api,
        "GET",
        &format!("/api/channels/{cid}/messages?reply_to={mid}"),
        Some(&alice),
        json!({}),
    )
    .await;
    assert_eq!(thread["messages"].as_array().unwrap().len(), 1);
    assert_eq!(thread["messages"][0]["id"], reply["id"]);
    let (_, invite) = call(
        &api,
        "POST",
        "/api/invites",
        Some(&owner),
        json!({"expires_in_seconds":60,"server_id":sid}),
    )
    .await;
    let(status,dave)=call(&api,"POST","/api/invites/accept",None,json!({"token":invite["token"],"username":"dave","password":"test-password-long","device_name":"test"})).await;
    assert_eq!(status, StatusCode::OK);
    let (_, joined) = call(&api, "GET", "/api/servers", Some(&dave), json!({})).await;
    assert_eq!(joined["servers"].as_array().unwrap().len(), 1);
    assert_eq!(joined["servers"][0]["id"], sid);
    assert_eq!(
        call(
            &api,
            "GET",
            "/api/channels/general/messages",
            Some(&dave),
            json!({})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    for path in [
        format!(
            "/api/roles/{rid}/members/{}",
            alice["user"]["id"].as_str().unwrap()
        ),
        format!("/api/roles/{rid}"),
    ] {
        assert_eq!(
            call(&api, "DELETE", &path, Some(&alice), json!({})).await.0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            call(&api, "DELETE", &path, Some(&owner), json!({})).await.0,
            StatusCode::OK
        )
    }
}
