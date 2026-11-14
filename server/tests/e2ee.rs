//! DM-V1 server rules: identity keys, key backup, encrypted messages and sealed uploads.
use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use housecall_server::{app, AppState};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;
const SETUP: &str = "test-bootstrap-credential-32-characters";
const PW: &str = "test-password-long";

struct Reply {
    status: StatusCode,
    bytes: Vec<u8>,
}
impl Reply {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.bytes).unwrap_or(Value::Null)
    }
    fn error(&self) -> Value {
        self.json()["error"].clone()
    }
}
async fn call(app: &Router, method: &str, path: &str, auth: &Value, body: Value) -> Reply {
    let req = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json")
        .header(
            "authorization",
            format!("Bearer {}", auth["token"].as_str().unwrap()),
        )
        .header("x-device-key", auth["device_key"].as_str().unwrap())
        .body(Body::from(body.to_string()))
        .unwrap();
    let response = app.clone().oneshot(req).await.unwrap();
    let status = response.status();
    let bytes = response
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes()
        .to_vec();
    Reply { status, bytes }
}
async fn public(app: &Router, path: &str, body: Value) -> Value {
    let req = Request::builder()
        .method("POST")
        .uri(path)
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let response = app.clone().oneshot(req).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(status, StatusCode::OK, "{path}: {}", String::from_utf8_lossy(&bytes));
    serde_json::from_slice(&bytes).unwrap()
}
/// owner, alice and bob; all three are in the owner's server.
async fn fixture() -> (Router, AppState, Value, Value, Value) {
    let mut state = AppState::new(":memory:", SETUP).unwrap();
    state.public_auth_limit = 1000;
    let dir = tempfile::tempdir().unwrap();
    state.media = Some(std::sync::Arc::new(housecall_media::Store::new(dir.path(), [7; 32]).unwrap()));
    std::mem::forget(dir);
    let api = app(state.clone(), None);
    let owner = public(
        &api,
        "/api/setup",
        json!({"setup_token":SETUP,"username":"owner","password":PW,"device_name":"test"}),
    )
    .await;
    let mut people = Vec::new();
    for name in ["alice", "bob"] {
        let invite = call(
            &api,
            "POST",
            "/api/invites",
            &owner,
            json!({"expires_in_seconds":3600}),
        )
        .await
        .json();
        people.push(
            public(
                &api,
                "/api/invites/accept",
                json!({"token":invite["token"],"username":name,"password":PW,"device_name":"test"}),
            )
            .await,
        );
    }
    let bob = people.pop().unwrap();
    let alice = people.pop().unwrap();
    (api, state, owner, alice, bob)
}
fn uid(who: &Value) -> String {
    who["user"]["id"].as_str().unwrap().to_owned()
}
/// A well-formed identity key: version, agreement key, signing key. `n` makes it distinct.
fn key_bytes(n: u8) -> Vec<u8> {
    let mut k = vec![1u8];
    k.extend((0..32).map(|i| {
        if i == 31 {
            0x10
        } else {
            n.wrapping_add(i as u8 + 1)
        }
    }));
    k.extend((0..32).map(|i| n.wrapping_add(100 + i as u8)));
    k
}
fn key(n: u8) -> String {
    B64.encode(key_bytes(n))
}
fn backup(rev: u32, fill: u8) -> String {
    let mut b = vec![1u8];
    b.extend(rev.to_be_bytes());
    b.extend(vec![fill; 72]);
    assert_eq!(b.len(), 77);
    B64.encode(b)
}
async fn publish(api: &Router, who: &Value, n: u8) -> Reply {
    call(
        api,
        "PUT",
        "/api/me/keys",
        who,
        json!({"identity_key":key(n)}),
    )
    .await
}
async fn replace(api: &Router, who: &Value, n: u8, password: &str) -> Reply {
    call(
        api,
        "PUT",
        "/api/me/keys",
        who,
        json!({"identity_key":key(n),"password":password}),
    )
    .await
}

#[tokio::test]
async fn first_key_is_rev_one_and_same_key_is_unchanged() {
    let (api, _, _, alice, _) = fixture().await;
    let r = publish(&api, &alice, 1).await;
    assert_eq!((r.status, r.json()), (StatusCode::OK, json!({"key_rev":1})));
    let again = publish(&api, &alice, 1).await;
    assert_eq!(
        (again.status, again.json()),
        (StatusCode::OK, json!({"key_rev":1}))
    );
}
#[tokio::test]
async fn malformed_identity_keys_are_refused_without_spending_the_rate_limit() {
    let (api, _, _, alice, _) = fixture().await;
    let mut cases: Vec<(&str, String)> = Vec::new();
    let mut short = key_bytes(1);
    short.pop();
    cases.push(("short", B64.encode(&short)));
    let mut long = key_bytes(1);
    long.push(0);
    cases.push(("long", B64.encode(&long)));
    let mut version = key_bytes(1);
    version[0] = 2;
    cases.push(("version", B64.encode(&version)));
    let mut zero = key_bytes(1);
    zero[1..33].fill(0);
    cases.push(("all-zero agreement key", B64.encode(&zero)));
    let mut high = key_bytes(1);
    high[32] |= 0x80;
    cases.push(("bit 255", B64.encode(&high)));
    let mut at_p = key_bytes(1);
    at_p[1..33].fill(0xff);
    at_p[1] = 0xed;
    at_p[32] = 0x7f;
    cases.push(("u == p", B64.encode(&at_p)));
    let mut above_p = at_p.clone();
    above_p[1] = 0xff;
    cases.push(("u > p", B64.encode(&above_p)));
    cases.push(("padded", format!("{}=", key(1))));
    cases.push(("std alphabet", format!("{}+", key(1))));
    cases.push(("whitespace", format!(" {}", key(1))));
    cases.push(("empty", String::new()));
    for (name, value) in cases {
        let r = call(
            &api,
            "PUT",
            "/api/me/keys",
            &alice,
            json!({"identity_key":value}),
        )
        .await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{name}");
        assert_eq!(r.error(), "invalid identity key", "{name}");
    }
    let mut below_p = at_p.clone();
    below_p[1] = 0xec;
    let r = call(
        &api,
        "PUT",
        "/api/me/keys",
        &alice,
        json!({"identity_key":B64.encode(below_p)}),
    )
    .await;
    assert_eq!(r.status, StatusCode::OK, "u == p-1 is canonical");
}
#[tokio::test]
async fn replacing_a_key_needs_the_right_password_and_changes_nothing_without_it() {
    let (api, _, _, alice, _) = fixture().await;
    publish(&api, &alice, 1).await;
    let stored = call(
        &api,
        "PUT",
        "/api/me/key-backup",
        &alice,
        json!({"key_backup":backup(1, 7)}),
    )
    .await;
    assert_eq!(stored.status, StatusCode::OK);
    let none = publish(&api, &alice, 2).await;
    assert_eq!((none.status, none.error()), (StatusCode::FORBIDDEN, json!("password required")));
    let wrong = replace(&api, &alice, 2, "not the password").await;
    assert_eq!((wrong.status, wrong.error()), (StatusCode::FORBIDDEN, json!("password required")));
    let backup_now = call(&api, "GET", "/api/me/key-backup", &alice, Value::Null).await;
    assert_eq!(backup_now.json(), json!({"key_backup":backup(1, 7)}));
    let seen = call(&api, "GET", &format!("/api/users/{}/keys", uid(&alice)), &alice, Value::Null).await;
    assert_eq!(seen.json()["key_rev"], 1);
}
#[tokio::test]
async fn replacement_with_the_right_password_bumps_rev_clears_backup_and_keeps_history() {
    let (api, _, _, alice, bob) = fixture().await;
    publish(&api, &alice, 1).await;
    call(
        &api,
        "PUT",
        "/api/me/key-backup",
        &alice,
        json!({"key_backup":backup(1, 7)}),
    )
    .await;
    let ok = replace(&api, &alice, 2, PW).await;
    assert_eq!((ok.status, ok.json()), (StatusCode::OK, json!({"key_rev":2})));
    let backup_now = call(&api, "GET", "/api/me/key-backup", &alice, Value::Null).await;
    assert_eq!(backup_now.json(), json!({"key_backup":null}));
    let seen = call(&api, "GET", &format!("/api/users/{}/keys", uid(&alice)), &bob, Value::Null).await;
    assert_eq!(seen.status, StatusCode::OK);
    let j = seen.json();
    assert_eq!(j["user_id"], uid(&alice));
    assert_eq!(j["identity_key"], key(2));
    assert_eq!(j["key_rev"], 2);
    let history = j["history"].as_array().unwrap();
    assert_eq!(history.len(), 2);
    assert_eq!((history[0]["key_rev"].clone(), history[0]["identity_key"].clone()), (json!(1), json!(key(1))));
    assert_eq!((history[1]["key_rev"].clone(), history[1]["identity_key"].clone()), (json!(2), json!(key(2))));
    assert!(history[0]["created_at"].as_i64().unwrap() > 0);
}
#[tokio::test]
async fn a_superseded_key_cannot_come_back() {
    let (api, _, _, alice, _) = fixture().await;
    publish(&api, &alice, 1).await;
    assert_eq!(replace(&api, &alice, 2, PW).await.status, StatusCode::OK);
    let back = replace(&api, &alice, 1, PW).await;
    assert_eq!(back.status, StatusCode::CONFLICT);
    assert_eq!(back.error(), "this security key was replaced earlier");
}
#[tokio::test]
async fn the_replaced_key_check_comes_after_the_password() {
    let (api, _, _, alice, _) = fixture().await;
    publish(&api, &alice, 1).await;
    replace(&api, &alice, 2, PW).await;
    let r = publish(&api, &alice, 1).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "no password, no hint about history");
}
#[tokio::test]
async fn keys_read_shapes_and_not_found() {
    let (api, _, owner, alice, bob) = fixture().await;
    let none = call(&api, "GET", &format!("/api/users/{}/keys", uid(&alice)), &bob, Value::Null).await;
    assert_eq!(
        none.json(),
        json!({"user_id":uid(&alice),"identity_key":null,"key_rev":0,"history":[]})
    );
    let unknown = call(&api, "GET", "/api/users/nobody/keys", &bob, Value::Null).await;
    assert_eq!(unknown.status, StatusCode::NOT_FOUND);
    publish(&api, &alice, 1).await;
    let disable = call(&api, "POST", &format!("/api/users/{}/disable", uid(&alice)), &owner, json!({})).await;
    assert_eq!(disable.status, StatusCode::OK);
    let gone = call(&api, "GET", &format!("/api/users/{}/keys", uid(&alice)), &bob, Value::Null).await;
    assert_eq!(gone.status, StatusCode::NOT_FOUND);
}
#[tokio::test]
async fn keys_publish_is_limited_to_three_a_minute() {
    let (api, _, _, alice, _) = fixture().await;
    for _ in 0..3 {
        assert_eq!(publish(&api, &alice, 1).await.status, StatusCode::OK);
    }
    assert_eq!(publish(&api, &alice, 1).await.status, StatusCode::TOO_MANY_REQUESTS);
}
#[tokio::test]
async fn key_backup_rules() {
    let (api, _, _, alice, bob) = fixture().await;
    let early = call(&api, "PUT", "/api/me/key-backup", &alice, json!({"key_backup":backup(1, 1)})).await;
    assert_eq!((early.status, early.error()), (StatusCode::CONFLICT, json!("publish keys first")));
    publish(&api, &alice, 1).await;
    let mut bad_len = vec![1u8; 76];
    bad_len[1..5].copy_from_slice(&1u32.to_be_bytes());
    let mut bad_version = B64.decode(backup(1, 1)).unwrap();
    bad_version[0] = 2;
    for (name, v) in [
        ("length", B64.encode(bad_len)),
        ("version", B64.encode(bad_version)),
        ("recovery_rev 0", backup(0, 1)),
        ("not b64u", "AAAA=".to_string()),
    ] {
        let r = call(&api, "PUT", "/api/me/key-backup", &alice, json!({"key_backup":v})).await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{name}");
        assert_eq!(r.error(), "invalid key backup", "{name}");
    }
    let first = call(&api, "PUT", "/api/me/key-backup", &alice, json!({"key_backup":backup(2, 1)})).await;
    assert_eq!((first.status, first.json()), (StatusCode::OK, json!({"recovery_rev":2})));
    let older = call(&api, "PUT", "/api/me/key-backup", &alice, json!({"key_backup":backup(1, 1)})).await;
    assert_eq!((older.status, older.error()), (StatusCode::CONFLICT, json!("a newer recovery key exists")));
    let reseal = call(&api, "PUT", "/api/me/key-backup", &alice, json!({"key_backup":backup(2, 9)})).await;
    assert_eq!(reseal.status, StatusCode::OK);
    let got = call(&api, "GET", "/api/me/key-backup", &alice, Value::Null).await;
    assert_eq!(got.json(), json!({"key_backup":backup(2, 9)}));
    let other = call(&api, "GET", "/api/me/key-backup", &bob, Value::Null).await;
    assert_eq!(other.json(), json!({"key_backup":null}), "each account is served only its own backup");
}
#[tokio::test]
async fn key_rev_is_on_members_and_me() {
    let (api, _, _, alice, bob) = fixture().await;
    publish(&api, &alice, 1).await;
    let members = call(&api, "GET", "/api/members", &bob, Value::Null).await.json();
    let rev = |name: &str| {
        members["members"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["username"] == name)
            .unwrap()["key_rev"]
            .clone()
    };
    assert_eq!((rev("alice"), rev("bob")), (json!(1), json!(0)));
    let me = call(&api, "GET", "/api/me", &alice, Value::Null).await.json();
    assert_eq!(me["user"]["key_rev"], 1);
}
#[tokio::test]
async fn password_check_and_key_exposure() {
    let (api, _, _, alice, _) = fixture().await;
    let ok = call(&api, "POST", "/api/me/password-check", &alice, json!({"password":PW})).await;
    assert_eq!((ok.status, ok.json()), (StatusCode::OK, json!({"ok":true})));
    let no = call(&api, "POST", "/api/me/password-check", &alice, json!({"password":"wrong password here"})).await;
    assert_eq!((no.status, no.error()), (StatusCode::FORBIDDEN, json!("password required")));
    let bad_kind = call(&api, "POST", "/api/me/key-exposure", &alice, json!({"kind":"phone"})).await;
    assert_eq!(bad_kind.status, StatusCode::BAD_REQUEST);
    let rec = call(&api, "POST", "/api/me/key-exposure", &alice, json!({"kind":"browser"})).await;
    assert_eq!((rec.status, rec.json()), (StatusCode::OK, json!({})));
    let list = call(&api, "GET", "/api/me/key-exposure", &alice, Value::Null).await.json();
    let rows = list["exposures"].as_array().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!((rows[0]["kind"].clone(), rows[0]["device_name"].clone()), (json!("browser"), json!("test")));
    assert!(rows[0]["created_at"].as_i64().unwrap() > 0);
}
#[tokio::test]
async fn keys_changed_event_reaches_own_devices_and_dm_peers() {
    let (api, _, owner, alice, bob) = fixture().await;
    let dm = call(&api, "POST", "/api/channels", &alice, json!({"name":"dm","kind":"dm","member_ids":[uid(&bob)]})).await;
    assert_eq!(dm.status, StatusCode::OK, "{:?}", dm.json());
    publish(&api, &alice, 1).await;
    for (who, name) in [(&alice, "alice"), (&bob, "bob")] {
        let events = call(&api, "GET", "/api/events?after=0", who, Value::Null).await.json();
        let found = events["events"].as_array().unwrap().iter().find(|e| e["kind"] == "keys.changed").unwrap_or_else(|| panic!("{name} got no keys.changed"));
        assert_eq!(found["payload"], json!({"user_id":uid(&alice),"key_rev":1,"device_name":"test"}));
    }
    let events = call(&api, "GET", "/api/events?after=0", &owner, Value::Null).await.json();
    assert!(events["events"].as_array().unwrap().iter().all(|e| e["kind"] != "keys.changed"), "strangers get nothing");
}

// ---- task 2: encrypted messages ----
fn envelope(sender: u32, recipient: u32, blocks: usize) -> String {
    let mut e = vec![1u8];
    e.extend(sender.to_be_bytes());
    e.extend(recipient.to_be_bytes());
    e.extend(vec![7u8; 24 + 256 * blocks + 16]);
    B64.encode(e)
}
async fn dm(api: &Router, a: &Value, b: &Value) -> String {
    let r = call(api, "POST", "/api/channels", a, json!({"name":"dm","kind":"dm","member_ids":[uid(b)]})).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    r.json()["id"].as_str().unwrap().to_owned()
}
async fn keyed_dm() -> (Router, AppState, Value, Value, Value, String) {
    let (api, st, owner, alice, bob) = fixture().await;
    publish(&api, &alice, 1).await;
    publish(&api, &bob, 2).await;
    let c = dm(&api, &alice, &bob).await;
    (api, st, owner, alice, bob, c)
}
async fn send(api: &Router, who: &Value, c: &str, body: Value) -> Reply {
    call(api, "POST", &format!("/api/channels/{c}/messages"), who, body).await
}

#[tokio::test]
async fn plaintext_is_refused_in_an_encrypted_dm_but_allowed_if_one_side_has_no_keys() {
    let (api, _, _, alice, bob, c) = keyed_dm().await;
    let r = send(&api, &alice, &c, json!({"body":"hi"})).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(r.error(), "this conversation is end-to-end encrypted; update Housecall to send");
    let r = send(&api, &alice, &c, json!({"body":"hi","enc":0})).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    let _ = bob;
    let (api, _, owner, alice, _) = fixture().await;
    publish(&api, &alice, 1).await;
    let c = dm(&api, &alice, &owner).await;
    assert_eq!(send(&api, &alice, &c, json!({"body":"hi"})).await.status, StatusCode::OK);
    let r = send(&api, &alice, &c, json!({"enc":1,"envelope":envelope(1,1,1)})).await;
    assert_eq!((r.status, r.error()), (StatusCode::UNPROCESSABLE_ENTITY, json!("encryption is not available in this conversation")));
}
#[tokio::test]
async fn encrypted_is_refused_outside_dms() {
    let (api, _, owner, alice, _) = fixture().await;
    publish(&api, &alice, 1).await;
    let ch = call(&api, "POST", "/api/channels", &owner, json!({"name":"room","kind":"channel"})).await.json()["id"].as_str().unwrap().to_owned();
    let r = send(&api, &owner, &ch, json!({"enc":1,"envelope":envelope(1,1,1)})).await;
    assert_eq!((r.status, r.error()), (StatusCode::UNPROCESSABLE_ENTITY, json!("encryption is not available in this conversation")));
}
#[tokio::test]
async fn envelope_shape_is_validated() {
    let (api, _, _, alice, bob, c) = keyed_dm().await;
    let good = envelope(1, 1, 1);
    let mut cases: Vec<(&str, Value)> = vec![
        ("missing", json!({"enc":1})),
        ("padded", json!({"enc":1,"envelope":format!("{good}=")})),
        ("std alphabet", json!({"enc":1,"envelope":format!("{good}+")})),
        ("too short", json!({"enc":1,"envelope":B64.encode(vec![1u8; 304])})),
        ("not a block", json!({"enc":1,"envelope":B64.encode(vec![1u8; 306])})),
        ("66 blocks", json!({"enc":1,"envelope":envelope(1,1,66)})),
        ("zero sender rev", json!({"enc":1,"envelope":envelope(0,1,1)})),
        ("zero recipient rev", json!({"enc":1,"envelope":envelope(1,0,1)})),
        ("body present", json!({"enc":1,"envelope":good,"body":"x"})),
        ("view once", json!({"enc":1,"envelope":good,"view_once":true})),
        ("role mention", json!({"enc":1,"envelope":good,"role_mention_ids":["r"]})),
        ("mention self", json!({"enc":1,"envelope":good,"mention_ids":[uid(&alice)]})),
    ];
    let mut bad_version = B64.decode(&good).unwrap();
    bad_version[0] = 2;
    cases.push(("version", json!({"enc":1,"envelope":B64.encode(bad_version)})));
    for (name, body) in cases {
        let r = send(&api, &alice, &c, body).await;
        assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{name}");
        assert_eq!(r.error(), "invalid encrypted message", "{name}");
    }
    let r = send(&api, &alice, &c, json!({"enc":1,"envelope":envelope(1,1,65)})).await;
    assert_eq!(r.status, StatusCode::OK);
    let _ = bob;
}
#[tokio::test]
async fn stale_key_revisions_are_409() {
    let (api, _, _, alice, bob, c) = keyed_dm().await;
    for e in [envelope(2, 1, 1), envelope(1, 2, 1), envelope(1, 3, 1)] {
        let r = send(&api, &alice, &c, json!({"enc":1,"envelope":e})).await;
        assert_eq!((r.status, r.error()), (StatusCode::CONFLICT, json!("security key changed; reload keys")));
    }
    // bob sends: sender rev is his (1), recipient alice (1)
    assert_eq!(send(&api, &bob, &c, json!({"enc":1,"envelope":envelope(1,1,1)})).await.status, StatusCode::OK);
}
#[tokio::test]
async fn sealed_message_is_stored_without_body_searched_never_and_read_back_with_envelope() {
    let (api, st, _, alice, bob, c) = keyed_dm().await;
    let e = envelope(1, 1, 2);
    let m = send(&api, &alice, &c, json!({"enc":1,"envelope":e,"mention_ids":[uid(&bob)]})).await;
    assert_eq!(m.status, StatusCode::OK);
    let m = m.json();
    assert_eq!((m["enc"].clone(), m["envelope"].clone()), (json!(1), json!(e)));
    assert_eq!(m["body"], "Encrypted message. Update Housecall to read it.");
    let stored: (String, i64) = st.db.lock().unwrap().query_row("SELECT body,enc FROM messages WHERE id=?", [m["id"].as_str().unwrap()], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
    assert_eq!(stored, (String::new(), 1));
    for q in ["Encrypted", "message", "update"] {
        let r = call(&api, "GET", &format!("/api/channels/{c}/messages?q={q}"), &bob, Value::Null).await;
        assert_eq!(r.json()["messages"].as_array().unwrap().len(), 0, "search for {q} must not find a sealed message");
    }
    let r = call(&api, "GET", &format!("/api/channels/{c}/messages"), &bob, Value::Null).await;
    assert_eq!(r.json()["messages"][0]["envelope"], json!(e));
}
#[tokio::test]
async fn edits_keep_enc_and_unsend_works() {
    let (api, _, _, alice, bob, c) = keyed_dm().await;
    let m = send(&api, &alice, &c, json!({"enc":1,"envelope":envelope(1,1,1)})).await.json();
    let mid = m["id"].as_str().unwrap();
    let path = format!("/api/messages/{mid}");
    let e2 = envelope(1, 1, 3);
    let r = call(&api, "PATCH", &path, &alice, json!({"enc":1,"envelope":e2,"revision":1})).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    assert_eq!((r.json()["envelope"].clone(), r.json()["revision"].clone()), (json!(e2), json!(2)));
    for (name, body) in [
        ("plaintext edit of a sealed message", json!({"body":"x","revision":2})),
        ("enc 0 with envelope", json!({"enc":0,"envelope":e2,"revision":2})),
        ("bad envelope", json!({"enc":1,"envelope":"AAAA","revision":2})),
        ("body present", json!({"enc":1,"envelope":e2,"body":"x","revision":2})),
    ] {
        let r = call(&api, "PATCH", &path, &alice, body).await;
        assert!(r.status == StatusCode::UNPROCESSABLE_ENTITY || r.status == StatusCode::BAD_REQUEST, "{name}");
    }
    let r = call(&api, "PATCH", &path, &alice, json!({"enc":1,"envelope":envelope(2,1,1),"revision":2})).await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    assert_eq!(call(&api, "PATCH", &path, &bob, json!({"enc":1,"envelope":e2,"revision":2})).await.status, StatusCode::FORBIDDEN);
    assert_eq!(call(&api, "DELETE", &path, &alice, Value::Null).await.status, StatusCode::OK);
}
#[tokio::test]
async fn old_plaintext_cannot_be_edited_after_keys_but_can_be_deleted() {
    let (api, _, _, alice, bob) = fixture().await;
    let c = dm(&api, &alice, &bob).await;
    let m = send(&api, &alice, &c, json!({"body":"old"})).await.json();
    publish(&api, &alice, 1).await;
    publish(&api, &bob, 2).await;
    let path = format!("/api/messages/{}", m["id"].as_str().unwrap());
    let r = call(&api, "PATCH", &path, &alice, json!({"body":"new","revision":0})).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    let r = call(&api, "PATCH", &path, &alice, json!({"enc":1,"envelope":envelope(1,1,1),"revision":0})).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "enc cannot be changed");
    assert_eq!(call(&api, "DELETE", &path, &alice, Value::Null).await.status, StatusCode::OK);
}
#[tokio::test]
async fn sealed_message_events_carry_ids_only() {
    let (api, st, _, alice, _, c) = keyed_dm().await;
    send(&api, &alice, &c, json!({"enc":1,"envelope":envelope(1,1,1)})).await;
    let payloads: Vec<String> = {
        let db = st.db.lock().unwrap();
        let mut q = db.prepare("SELECT payload FROM events WHERE kind='message.created'").unwrap();
        q.query_map([], |r| r.get(0)).unwrap().map(|x| x.unwrap()).collect()
    };
    assert!(!payloads.is_empty());
    assert!(payloads.iter().all(|p| !p.contains("envelope") && !p.contains(&envelope(1, 1, 1))));
}

// ---- task 3: sealed uploads ----
async fn raw(api: &Router, method: &str, path: &str, who: &Value, bytes: Vec<u8>, offset: Option<&str>) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
    let mut b = Request::builder().method(method).uri(path)
        .header("authorization", format!("Bearer {}", who["token"].as_str().unwrap()))
        .header("x-device-key", who["device_key"].as_str().unwrap())
        .header("content-type", if method == "PATCH" { "application/octet-stream" } else { "application/json" });
    if let Some(o) = offset { b = b.header("upload-offset", o); }
    let r = api.clone().oneshot(b.body(Body::from(bytes)).unwrap()).await.unwrap();
    let (status, headers) = (r.status(), r.headers().clone());
    (status, headers, r.into_body().collect().await.unwrap().to_bytes().to_vec())
}
async fn sealed_upload(api: &Router, who: &Value, c: &str, data: &[u8]) -> String {
    let r = call(api, "POST", "/api/uploads", who, json!({"channel_id":c,"filename":"sealed","length":data.len().to_string(),"class":"sealed"})).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    let id = r.json()["id"].as_str().unwrap().to_owned();
    let (st, _, _) = raw(api, "PATCH", &format!("/api/uploads/{id}"), who, data.to_vec(), Some("0")).await;
    assert_eq!(st, StatusCode::OK);
    let r = call(api, "POST", &format!("/api/uploads/{id}/complete"), who, Value::Null).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    assert_eq!(r.json()["status"], "ready");
    assert_eq!(r.json()["scan"], Value::Null);
    id
}
#[tokio::test]
async fn sealed_upload_rules() {
    let (api, _, owner, alice, bob, c) = keyed_dm().await;
    let mk = |filename: &str, length: &str, class: &str| json!({"channel_id":c,"filename":filename,"length":length,"class":class});
    let r = call(&api, "POST", "/api/uploads", &alice, mk("photo.png", "10", "sealed")).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    let r = call(&api, "POST", "/api/uploads", &alice, mk("sealed", "104883221", "sealed")).await;
    assert_eq!(r.status, StatusCode::PAYLOAD_TOO_LARGE);
    let r = call(&api, "POST", "/api/uploads", &alice, mk("sealed", "104883220", "sealed")).await;
    assert_eq!(r.status, StatusCode::OK);
    let r = call(&api, "POST", "/api/uploads", &alice, mk("sealed", "10", "other")).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    // outside an encrypted DM
    let ch = call(&api, "POST", "/api/channels", &owner, json!({"name":"room","kind":"channel"})).await.json()["id"].as_str().unwrap().to_owned();
    let r = call(&api, "POST", "/api/uploads", &owner, json!({"channel_id":ch,"filename":"sealed","length":"10","class":"sealed"})).await;
    assert_eq!((r.status, r.error()), (StatusCode::UNPROCESSABLE_ENTITY, json!("encryption is not available in this conversation")));
    let _ = bob;
}
#[tokio::test]
async fn sealed_upload_is_unscanned_untranscoded_attached_and_served_as_a_download() {
    let (api, st, _, alice, bob, c) = keyed_dm().await;
    let data = vec![0x42u8; 5000];
    let id = sealed_upload(&api, &alice, &c, &data).await;
    // a plaintext message cannot take it; an encrypted one can, once
    let r = send(&api, &alice, &c, json!({"enc":0,"body":"x","attachment_ids":[id]})).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    let m = send(&api, &alice, &c, json!({"enc":1,"envelope":envelope(1,1,1),"attachment_ids":[id]})).await;
    assert_eq!(m.status, StatusCode::OK, "{:?}", m.json());
    assert_eq!(m.json()["attachments"][0]["kind"], "sealed");
    assert_eq!(m.json()["attachments"][0]["filename"], "sealed");
    assert!(m.json()["attachments"][0].get("video_path").is_none());
    assert!(m.json()["attachments"][0].get("thumbnail_path").is_none());
    let again = send(&api, &alice, &c, json!({"enc":1,"envelope":envelope(1,1,1),"attachment_ids":[id]})).await;
    assert_eq!(again.status, StatusCode::CONFLICT);
    // transcoding is refused and no job exists
    let (status, _, _) = raw(&api, "POST", &format!("/api/uploads/{id}/transcode"), &alice, vec![], None).await;
    assert_ne!(status, StatusCode::OK);
    let jobs: i64 = st.db.lock().unwrap().query_row("SELECT COUNT(*) FROM media_jobs", [], |r| r.get(0)).unwrap();
    assert_eq!(jobs, 0);
    // download
    let (status, h, body) = raw(&api, "GET", &format!("/api/media/{id}"), &bob, vec![], None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(h["content-type"], "application/octet-stream");
    assert_eq!(h["content-disposition"], "attachment");
    assert_eq!(h["x-content-type-options"], "nosniff");
    assert_eq!(body, data);
    // deleting the message deletes the bytes
    let mid = m.json()["id"].as_str().unwrap().to_owned();
    assert_eq!(call(&api, "DELETE", &format!("/api/messages/{mid}"), &alice, Value::Null).await.status, StatusCode::OK);
    let (status, _, _) = raw(&api, "GET", &format!("/api/media/{id}"), &bob, vec![], None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}
#[tokio::test]
async fn plain_upload_cannot_be_attached_to_an_encrypted_message() {
    let (api, _, _, alice, _, c) = keyed_dm().await;
    let r = call(&api, "POST", "/api/uploads", &alice, json!({"channel_id":c,"filename":"a.txt","length":"1"})).await;
    let id = r.json()["id"].as_str().unwrap().to_owned();
    raw(&api, "PATCH", &format!("/api/uploads/{id}"), &alice, vec![1], Some("0")).await;
    let r = call(&api, "POST", &format!("/api/uploads/{id}/complete"), &alice, Value::Null).await;
    // the default scanner rejects everything; a non-ready upload is refused either way
    let _ = r;
    let m = send(&api, &alice, &c, json!({"enc":1,"envelope":envelope(1,1,1),"attachment_ids":[id]})).await;
    assert_eq!(m.status, StatusCode::BAD_REQUEST);
}
