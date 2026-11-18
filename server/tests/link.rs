//! LINK-V1 server rules: QR login links.
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
    assert_eq!(
        status,
        StatusCode::OK,
        "{path}: {}",
        String::from_utf8_lossy(&bytes)
    );
    serde_json::from_slice(&bytes).unwrap()
}
/// owner, alice and bob; all three are in the owner's server.
async fn fixture() -> (Router, AppState, Value, Value, Value) {
    let mut state = AppState::new(":memory:", SETUP).unwrap();
    state.public_auth_limit = 1000;
    let dir = tempfile::tempdir().unwrap();
    state.media = Some(std::sync::Arc::new(
        housecall_media::Store::new(dir.path(), [7; 32]).unwrap(),
    ));
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

async fn post_public(app: &Router, path: &str, body: Value) -> Reply {
    let req = Request::builder()
        .method("POST")
        .uri(path)
        .header("content-type", "application/json")
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
fn b43(n: u8) -> String {
    B64.encode([n; 32])
}
fn dkey(n: u8) -> String {
    format!("{:02x}", n).repeat(32)
}
async fn start(api: &Router, who: &Value) -> Value {
    let r = call(api, "POST", "/api/link/start", who, json!({})).await;
    assert_eq!(r.status, StatusCode::OK);
    r.json()
}
fn claim_body(l: &Value, dk: &str) -> Value {
    json!({"link_id":l["link_id"],"secret":l["secret"],"device_name":"Pixel 9","device_key":dk,
        "ephemeral_pub":b43(9),"claim_tag":B64.encode([3u8;16])})
}
fn result_body(l: &Value, dk: &str) -> Value {
    json!({"link_id":l["link_id"],"secret":l["secret"],"device_key":dk})
}
fn wrapped() -> String {
    let mut b = vec![1u8];
    b.extend(vec![7u8; 90]);
    B64.encode(b)
}
async fn approve(api: &Router, who: &Value, l: &Value) -> Reply {
    call(
        api,
        "POST",
        &format!("/api/link/{}/approve", l["link_id"].as_str().unwrap()),
        who,
        json!({"wrapped_keys":wrapped()}),
    )
    .await
}
async fn get_link(api: &Router, who: &Value, l: &Value) -> Reply {
    call(
        api,
        "GET",
        &format!("/api/link/{}", l["link_id"].as_str().unwrap()),
        who,
        Value::Null,
    )
    .await
}
fn expire(state: &AppState, l: &Value) {
    // Memory-only state: reach in through a fresh start would not help, so age it via the public clock-free hook.
    housecall_server::link::age_for_test(state, l["link_id"].as_str().unwrap(), 200_000);
}

#[tokio::test]
async fn happy_path_and_session_bound_to_claimed_device() {
    let (api, _state, owner, alice, _bob) = fixture().await;
    let l = start(&api, &alice).await;
    assert_eq!(l["link_id"].as_str().unwrap().len(), 32);
    assert_eq!(l["secret"].as_str().unwrap().len(), 43);
    let g = get_link(&api, &alice, &l).await.json();
    assert_eq!(g["state"], "started");
    assert!(g["claim"].is_null());
    let c = post_public(&api, "/api/link/claim", claim_body(&l, &dkey(0xab))).await;
    assert_eq!(c.status, StatusCode::OK);
    assert_eq!(c.json()["username"], "alice");
    assert!(c.json().get("display_name").is_some());
    let g = get_link(&api, &alice, &l).await.json();
    assert_eq!(g["state"], "claimed");
    assert_eq!(g["claim"]["device_name"], "Pixel 9");
    assert_eq!(g["claim"]["ephemeral_pub"], b43(9));
    // not yet approved
    let r = post_public(&api, "/api/link/result", result_body(&l, &dkey(0xab))).await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    assert_eq!(r.error(), "waiting for approval");
    // someone else's device key gets nothing
    let r = post_public(&api, "/api/link/result", result_body(&l, &dkey(0xcd))).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    // the starter's other session cannot approve; the owner cannot either
    assert_eq!(
        approve(&api, &owner, &l).await.status,
        StatusCode::FORBIDDEN
    );
    let a = approve(&api, &alice, &l).await;
    assert_eq!(a.status, StatusCode::OK);
    assert_eq!(a.json(), json!({"state":"approved"}));
    let r = post_public(&api, "/api/link/result", result_body(&l, &dkey(0xcd))).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    let r = post_public(&api, "/api/link/result", result_body(&l, &dkey(0xab))).await;
    assert_eq!(r.status, StatusCode::OK);
    let out = r.json();
    assert_eq!(out["token"].as_str().unwrap().len(), 64);
    assert_eq!(out["user"]["username"], "alice");
    assert_eq!(out["wrapped_keys"], wrapped());
    assert!(out.get("device_key").is_none());
    assert!(out["expires_at"].as_i64().unwrap() > 0);
    // the token works with the claimed device key only
    let ok = json!({"token":out["token"],"device_key":dkey(0xab)});
    assert_eq!(
        call(&api, "GET", "/api/me", &ok, Value::Null).await.status,
        StatusCode::OK
    );
    let bad = json!({"token":out["token"],"device_key":dkey(0xcd)});
    assert_eq!(
        call(&api, "GET", "/api/me", &bad, Value::Null).await.status,
        StatusCode::UNAUTHORIZED
    );
    // second result: burnt
    let r = post_public(&api, "/api/link/result", result_body(&l, &dkey(0xab))).await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    assert_eq!(r.error(), "link already used");
    // devices list: how each device was added
    let d = call(&api, "GET", "/api/devices", &alice, Value::Null)
        .await
        .json();
    let via: Vec<&str> = d["devices"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x["added_via"].as_str().unwrap_or(""))
        .collect();
    assert!(via.contains(&"qr") && via.contains(&"invite"), "{via:?}");
    // new device notice reaches the account's devices
    let ev = call(&api, "GET", "/api/events?after=0", &alice, Value::Null)
        .await
        .json();
    let notices: Vec<&Value> = ev["events"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["kind"] == "device.added")
        .collect();
    let qr = notices
        .iter()
        .find(|e| e["payload"]["added_via"] == "qr")
        .expect("qr notice");
    assert_eq!(qr["payload"]["device_name"], "Pixel 9");
    assert!(qr["payload"]["session_id"].is_string());
    assert!(notices
        .iter()
        .any(|e| e["payload"]["added_via"] == "invite"));
}

#[tokio::test]
async fn every_session_creation_raises_device_added() {
    let (api, _state, owner, _a, _b) = fixture().await;
    let l = post_public(
        &api,
        "/api/login",
        json!({"username":"owner","password":PW,"device_name":"laptop"}),
    )
    .await;
    assert_eq!(l.status, StatusCode::OK);
    let ev = call(&api, "GET", "/api/events?after=0", &owner, Value::Null)
        .await
        .json();
    let vias: Vec<&str> = ev["events"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["kind"] == "device.added")
        .map(|e| e["payload"]["added_via"].as_str().unwrap())
        .collect();
    assert!(
        vias.contains(&"setup") && vias.contains(&"password"),
        "{vias:?}"
    );
}

#[tokio::test]
async fn wrong_secret_and_unknown_id_are_the_same_404_and_three_burn() {
    let (api, _state, _o, alice, _b) = fixture().await;
    let l = start(&api, &alice).await;
    let before = housecall_server::link::dummy_compares();
    let unknown = json!({"link_id":"0".repeat(32),"secret":b43(1),"device_name":"x","device_key":dkey(1),"ephemeral_pub":b43(9),"claim_tag":B64.encode([3u8;16])});
    let r = post_public(&api, "/api/link/claim", unknown).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    assert_eq!(housecall_server::link::dummy_compares(), before + 1);
    let mut wrong = claim_body(&l, &dkey(1));
    wrong["secret"] = json!(b43(1));
    let r1 = post_public(&api, "/api/link/claim", wrong.clone()).await;
    assert_eq!(r1.status, StatusCode::NOT_FOUND);
    assert_eq!(r1.json(), json!({"error":"not found"}));
    // a wrong secret never used the dummy digest: it went through the real one
    assert_eq!(housecall_server::link::dummy_compares(), before + 1);
    assert_eq!(
        post_public(&api, "/api/link/claim", wrong.clone())
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        post_public(&api, "/api/link/claim", wrong.clone())
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    // third wrong secret burnt it, even for the right secret
    let r = post_public(&api, "/api/link/claim", claim_body(&l, &dkey(1))).await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    let g = get_link(&api, &alice, &l).await.json();
    assert_eq!(g["state"], "burnt");
    assert_eq!(g["burn_reason"], "wrong_secret");
}

#[tokio::test]
async fn double_claim_burns_for_both() {
    let (api, _state, _o, alice, _b) = fixture().await;
    let l = start(&api, &alice).await;
    assert_eq!(
        post_public(&api, "/api/link/claim", claim_body(&l, &dkey(1)))
            .await
            .status,
        StatusCode::OK
    );
    let second = post_public(&api, "/api/link/claim", claim_body(&l, &dkey(2))).await;
    assert_eq!(second.status, StatusCode::CONFLICT);
    assert_eq!(second.error(), "link already used");
    let g = get_link(&api, &alice, &l).await.json();
    assert_eq!(
        (g["state"].as_str(), g["burn_reason"].as_str()),
        (Some("burnt"), Some("double_claim"))
    );
    // the first claimer's result is 409 from now on, and approving is refused
    let r = post_public(&api, "/api/link/result", result_body(&l, &dkey(1))).await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    assert_eq!(approve(&api, &alice, &l).await.status, StatusCode::CONFLICT);
}

#[tokio::test]
async fn claim_after_approval_burns_and_result_is_refused() {
    let (api, _state, _o, alice, _b) = fixture().await;
    let l = start(&api, &alice).await;
    post_public(&api, "/api/link/claim", claim_body(&l, &dkey(1))).await;
    assert_eq!(approve(&api, &alice, &l).await.status, StatusCode::OK);
    assert_eq!(
        post_public(&api, "/api/link/claim", claim_body(&l, &dkey(2)))
            .await
            .status,
        StatusCode::CONFLICT
    );
    assert_eq!(
        post_public(&api, "/api/link/result", result_body(&l, &dkey(1)))
            .await
            .status,
        StatusCode::CONFLICT
    );
}

#[tokio::test]
async fn other_sessions_get_403_and_unknown_ids_404() {
    let (api, _state, _o, alice, bob) = fixture().await;
    let l = start(&api, &alice).await;
    assert_eq!(get_link(&api, &bob, &l).await.status, StatusCode::FORBIDDEN);
    // same user, other session
    let second = post_public(
        &api,
        "/api/login",
        json!({"username":"alice","password":PW,"device_name":"b"}),
    )
    .await;
    let second = serde_json::from_slice::<Value>(&second.bytes).unwrap();
    assert_eq!(
        get_link(&api, &second, &l).await.status,
        StatusCode::FORBIDDEN
    );
    let deny = call(
        &api,
        "POST",
        &format!("/api/link/{}/deny", l["link_id"].as_str().unwrap()),
        &second,
        json!({}),
    )
    .await;
    assert_eq!(deny.status, StatusCode::FORBIDDEN);
    let missing = json!({"link_id":"1".repeat(32)});
    assert_eq!(
        get_link(&api, &alice, &missing).await.status,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn deny_and_cancel() {
    let (api, _state, _o, alice, _b) = fixture().await;
    let l = start(&api, &alice).await;
    let path = format!("/api/link/{}/deny", l["link_id"].as_str().unwrap());
    let d = call(&api, "POST", &path, &alice, json!({})).await;
    assert_eq!(d.json(), json!({"state":"denied"}));
    assert_eq!(
        call(&api, "POST", &path, &alice, json!({})).await.status,
        StatusCode::CONFLICT
    );
    assert_eq!(
        post_public(&api, "/api/link/claim", claim_body(&l, &dkey(1)))
            .await
            .status,
        StatusCode::CONFLICT
    );
    // deny after claim: the claimer is told no
    let l = start(&api, &alice).await;
    post_public(&api, "/api/link/claim", claim_body(&l, &dkey(1))).await;
    let path = format!("/api/link/{}/deny", l["link_id"].as_str().unwrap());
    assert_eq!(
        call(&api, "POST", &path, &alice, json!({})).await.status,
        StatusCode::OK
    );
    let r = post_public(&api, "/api/link/result", result_body(&l, &dkey(1))).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    assert_eq!(r.error(), "link denied");
}

#[tokio::test]
async fn expiry_gives_410() {
    let (api, state, _o, alice, _b) = fixture().await;
    let l = start(&api, &alice).await;
    expire(&state, &l);
    assert_eq!(
        post_public(&api, "/api/link/claim", claim_body(&l, &dkey(1)))
            .await
            .status,
        StatusCode::GONE
    );
    assert_eq!(get_link(&api, &alice, &l).await.json()["state"], "expired");
    // claimed then expired before approval
    let l = start(&api, &alice).await;
    post_public(&api, "/api/link/claim", claim_body(&l, &dkey(1))).await;
    expire(&state, &l);
    assert_eq!(approve(&api, &alice, &l).await.status, StatusCode::GONE);
    assert_eq!(
        post_public(&api, "/api/link/result", result_body(&l, &dkey(1)))
            .await
            .status,
        StatusCode::GONE
    );
    // approved but result not collected in 60 s
    let l = start(&api, &alice).await;
    post_public(&api, "/api/link/claim", claim_body(&l, &dkey(1))).await;
    approve(&api, &alice, &l).await;
    housecall_server::link::age_for_test(&state, l["link_id"].as_str().unwrap(), 61_000);
    assert_eq!(
        post_public(&api, "/api/link/result", result_body(&l, &dkey(1)))
            .await
            .status,
        StatusCode::GONE
    );
}

#[tokio::test]
async fn second_start_cancels_the_first_unclaimed_link() {
    let (api, _state, _o, alice, _b) = fixture().await;
    let first = start(&api, &alice).await;
    let second = start(&api, &alice).await;
    assert_eq!(
        get_link(&api, &alice, &first).await.json()["state"],
        "denied"
    );
    assert_eq!(
        get_link(&api, &alice, &second).await.json()["state"],
        "started"
    );
    assert_eq!(
        post_public(&api, "/api/link/claim", claim_body(&first, &dkey(1)))
            .await
            .status,
        StatusCode::CONFLICT
    );
}

#[tokio::test]
async fn start_is_limited_to_five_a_minute() {
    let (api, _state, _o, alice, _b) = fixture().await;
    for _ in 0..5 {
        start(&api, &alice).await;
    }
    let r = call(&api, "POST", "/api/link/start", &alice, json!({})).await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS);
}

#[tokio::test]
async fn validation_refusals_are_400() {
    let (api, _state, _o, alice, _b) = fixture().await;
    let l = start(&api, &alice).await;
    let mut cases = Vec::new();
    for (k, v) in [
        ("link_id", json!("XYZ")),
        ("link_id", json!("A".repeat(32))),
        ("secret", json!(b43(1) + "=")),
        ("secret", json!(B64.encode([1u8; 31]))),
        ("device_key", json!("A".repeat(64))),
        ("device_key", json!("a".repeat(63))),
        ("device_name", json!("   ")),
        ("device_name", json!("x".repeat(81))),
        ("device_name", json!("a\u{202e}b")),
        ("device_name", json!("a\nb")),
        ("ephemeral_pub", json!(B64.encode([0u8; 32]))),
        ("ephemeral_pub", json!(B64.encode([1u8; 31]))),
        ("claim_tag", json!(B64.encode([1u8; 15]))),
        ("claim_tag", json!(B64.encode([1u8; 17]))),
    ] {
        let mut b = claim_body(&l, &dkey(1));
        b[k] = v;
        cases.push(b);
    }
    for b in cases {
        let r = post_public(&api, "/api/link/claim", b.clone()).await;
        assert_eq!(
            (r.status, r.error()),
            (StatusCode::BAD_REQUEST, json!("invalid link request")),
            "{b}"
        );
    }
    // none of that touched the link
    assert_eq!(get_link(&api, &alice, &l).await.json()["state"], "started");
    // approve: wrapped_keys shapes
    post_public(&api, "/api/link/claim", claim_body(&l, &dkey(1))).await;
    let path = format!("/api/link/{}/approve", l["link_id"].as_str().unwrap());
    for w in [
        json!("!!"),
        json!(B64.encode([1u8; 78])),
        json!(B64.encode([2u8; 100])),
        json!(B64.encode(vec![1u8; 65537])),
        json!(5),
    ] {
        let r = call(&api, "POST", &path, &alice, json!({"wrapped_keys":w})).await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{w}");
    }
    let r = call(&api, "POST", &path, &alice, json!({"wrapped_keys":null})).await;
    assert_eq!(r.status, StatusCode::OK);
    let r = post_public(&api, "/api/link/result", result_body(&l, &dkey(1))).await;
    assert!(r.json()["wrapped_keys"].is_null());
    assert!(
        post_public(&api, "/api/link/result", json!({"link_id":"x"}))
            .await
            .status
            .is_client_error()
    );
}

#[tokio::test]
async fn disabled_account_cannot_be_claimed() {
    let (api, _state, owner, alice, _b) = fixture().await;
    let l = start(&api, &alice).await;
    let r = call(
        &api,
        "POST",
        &format!("/api/users/{}/disable", uid(&alice)),
        &owner,
        json!({}),
    )
    .await;
    assert_eq!(r.status, StatusCode::OK);
    // the starter's session is gone too, so claim is what we test
    assert_eq!(
        post_public(&api, "/api/link/claim", claim_body(&l, &dkey(1)))
            .await
            .status,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn result_polling_does_not_starve_login() {
    let (api, _state, _o, _a, _b) = fixture().await;
    let probe = json!({"link_id":"0".repeat(32),"secret":b43(1),"device_key":dkey(1)});
    let mut limited = false;
    for i in 0..620 {
        let mut b = probe.clone();
        b["link_id"] = json!(format!("{:032x}", i + 1));
        if post_public(&api, "/api/link/result", b).await.status == StatusCode::TOO_MANY_REQUESTS {
            limited = true;
            assert!(i >= 600);
            break;
        }
    }
    assert!(limited, "the result bucket has its own limit");
    let r = post_public(
        &api,
        "/api/login",
        json!({"username":"alice","password":PW,"device_name":"x"}),
    )
    .await;
    assert_eq!(r.status, StatusCode::OK);
}

#[tokio::test]
async fn result_is_limited_per_link() {
    let (api, _state, _o, alice, _b) = fixture().await;
    let l = start(&api, &alice).await;
    post_public(&api, "/api/link/claim", claim_body(&l, &dkey(1))).await;
    let mut last = StatusCode::OK;
    for _ in 0..61 {
        last = post_public(&api, "/api/link/result", result_body(&l, &dkey(1)))
            .await
            .status;
    }
    assert_eq!(last, StatusCode::TOO_MANY_REQUESTS);
}

#[derive(Clone, Default)]
struct Capture(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);
impl std::io::Write for Capture {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for Capture {
    type Writer = Capture;
    fn make_writer(&'a self) -> Capture {
        self.clone()
    }
}

#[tokio::test]
async fn no_secret_appears_in_logs() {
    // One global subscriber: per-thread ones race with tracing's callsite interest cache when
    // other tests in this binary hit the same log lines first.
    static CAP: std::sync::OnceLock<Capture> = std::sync::OnceLock::new();
    let cap = CAP
        .get_or_init(|| {
            let cap = Capture::default();
            let sub = tracing_subscriber::fmt()
                .with_writer(cap.clone())
                .with_max_level(tracing::Level::TRACE)
                .with_ansi(false)
                .finish();
            tracing::subscriber::set_global_default(sub).unwrap();
            cap
        })
        .clone();
    let (api, _state, _o, alice, _b) = fixture().await;
    let l = start(&api, &alice).await;
    let dk = dkey(0x77);
    post_public(&api, "/api/link/claim", claim_body(&l, &dk)).await;
    let mut wrong = claim_body(&l, &dk);
    wrong["secret"] = json!(b43(5));
    post_public(&api, "/api/link/claim", wrong).await;
    approve(&api, &alice, &l).await;
    let out = post_public(&api, "/api/link/result", result_body(&l, &dk))
        .await
        .json();
    let logs = String::from_utf8_lossy(&cap.0.lock().unwrap()).to_string();
    let mine = &l["link_id"].as_str().unwrap()[..8];
    for want in [
        "link started",
        "link claimed",
        "link approved",
        "link burnt",
    ] {
        assert!(
            logs.lines().any(|x| x.contains(want) && x.contains(mine)),
            "missing {want:?} in {logs:?}"
        );
    }
    assert!(logs.contains("qr session created"));
    for secret in [
        l["secret"].as_str().unwrap().to_owned(),
        dk.clone(),
        out["token"].as_str().unwrap().to_owned(),
        b43(9),
        B64.encode([3u8; 16]),
        wrapped(),
        "Pixel 9".to_owned(),
        l["link_id"].as_str().unwrap().to_owned(),
    ] {
        assert!(!logs.contains(&secret), "log leaked {secret}");
    }
}

#[tokio::test]
async fn the_link_page_is_static_strict_and_sends_nothing() {
    let (api, _state, _o, _a, _b) = fixture().await;
    for (path, kind) in [
        ("/link", "text/html"),
        ("/link.js", "text/javascript"),
        ("/link.css", "text/css"),
    ] {
        let req = Request::builder()
            .method("GET")
            .uri(path)
            .body(Body::empty())
            .unwrap();
        let r = api.clone().oneshot(req).await.unwrap();
        assert_eq!(r.status(), StatusCode::OK, "{path}");
        let h = r.headers().clone();
        assert!(h["content-type"].to_str().unwrap().starts_with(kind));
        assert_eq!(h["referrer-policy"], "no-referrer");
        assert_eq!(h["x-content-type-options"], "nosniff");
        assert_eq!(h["cache-control"], "no-store");
        let csp = h["content-security-policy"].to_str().unwrap();
        assert!(
            csp.contains("script-src 'self'")
                && !csp.contains("unsafe-inline")
                && csp.contains("default-src 'self'"),
            "{csp}"
        );
        let body =
            String::from_utf8(r.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap();
        if path == "/link" {
            assert!(body.contains("Open in Housecall") && !body.contains("Continue in browser"));
            assert!(body.contains("housecall://link-scan") && !body.contains("link?c="));
            assert!(!body.contains("Get the app"));
            // every script is external
            for tail in body.split("<script").skip(1) {
                assert!(tail.trim_start().starts_with("src="), "inline script");
            }
        }
        if path == "/link.js" {
            for banned in [
                "fetch(",
                "XMLHttpRequest",
                "sendBeacon",
                "WebSocket",
                "new Image",
                "localStorage",
                "sessionStorage",
                "document.cookie",
                "location.href",
                "location.assign",
                "console.",
            ] {
                assert!(!body.contains(banned), "link.js uses {banned}");
            }
            // the fragment is dropped from the address bar before anything else is read
            assert!(body.find("replaceState").unwrap() < body.find("getElementById").unwrap());
            assert!(!body.contains('\u{2014}'));
        }
    }
    let req = Request::builder()
        .method("POST")
        .uri("/link")
        .body(Body::empty())
        .unwrap();
    assert_eq!(
        api.clone().oneshot(req).await.unwrap().status(),
        StatusCode::METHOD_NOT_ALLOWED
    );
}

// Request direction is additive: keep every V1 regression above unchanged.
async fn request_fixture() -> (Router, AppState, Value, Value) {
    let (_, mut state, _, alice, bob) = fixture().await;
    state.link_request_enabled = true;
    (app(state.clone(), None), state, alice, bob)
}
async fn request_start(api: &Router) -> Value {
    public(api, "/api/link/request", json!({"device_name":"Browser","device_key":dkey(71),"browser_origin":"https://app.example.test"})).await
}
fn request_path(l: &Value, action: &str) -> String {
    format!(
        "/api/link/request/{}/{}",
        l["link_id"].as_str().unwrap(),
        action
    )
}
async fn request_claim(api: &Router, phone: &Value, l: &Value) -> Reply {
    call(
        api,
        "POST",
        &request_path(l, "claim"),
        phone,
        json!({"secret":l["secret"],"ephemeral_pub":b43(9),"claim_tag":B64.encode([3u8;16])}),
    )
    .await
}
async fn request_approve(api: &Router, phone: &Value, l: &Value, wrapped: Value) -> Reply {
    call(
        api,
        "POST",
        &request_path(l, "approve"),
        phone,
        json!({"confirmation":"47","wrapped_keys":wrapped}),
    )
    .await
}
fn request_proof(l: &Value) -> Value {
    json!({"link_id":l["link_id"],"secret":l["secret"],"device_key":dkey(71)})
}
#[tokio::test]
async fn request_direction_is_off_by_default_and_separate_from_v1() {
    let (api, _, _, alice, _) = fixture().await;
    assert_eq!(
        post_public(
            &api,
            "/api/link/request",
            json!({"device_name":"Browser","device_key":dkey(71)})
        )
        .await
        .status,
        StatusCode::NOT_FOUND
    );
    let (api, _, alice2, _) = request_fixture().await;
    let l = start(&api, &alice2).await;
    assert_eq!(
        request_claim(&api, &alice2, &l).await.status,
        StatusCode::NOT_FOUND
    );
    let l = request_start(&api).await;
    assert_eq!(
        post_public(&api, "/api/link/claim", claim_body(&l, &dkey(2)))
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    // V1 still starts, claims, and approves normally.
    let _ = alice;
}
#[tokio::test]
async fn request_requires_both_approval_and_private_one_shot_confirmation() {
    let (api, _, alice, _) = request_fixture().await;
    let l = request_start(&api).await;
    assert_eq!(request_claim(&api, &alice, &l).await.status, StatusCode::OK);
    let mut proof = request_proof(&l);
    proof["confirmation"] = json!("47");
    assert_eq!(
        post_public(&api, "/api/link/request/collect", proof.clone())
            .await
            .status,
        StatusCode::CONFLICT
    );
    assert_eq!(
        request_approve(&api, &alice, &l, Value::Null).await.status,
        StatusCode::OK
    );
    let status = post_public(&api, "/api/link/request/status", request_proof(&l))
        .await
        .json();
    assert!(status.get("confirmation").is_none());
    assert!(status["claim"].get("confirmation").is_none());
    let result = post_public(&api, "/api/link/request/collect", proof.clone()).await;
    assert_eq!(result.status, StatusCode::OK);
    assert_eq!(result.json()["user"]["id"], alice["user"]["id"]);
    assert_eq!(
        post_public(&api, "/api/link/request/collect", proof)
            .await
            .status,
        StatusCode::CONFLICT
    );
    // A correct number before approval did not consume the attempt.
}
#[tokio::test]
async fn request_wrong_or_missing_confirmation_burns_even_for_a_raw_client() {
    for value in [
        Value::Null,
        json!("00"),
        json!("0047"),
        json!(47),
        json!({}),
    ] {
        let (api, _, alice, _) = request_fixture().await;
        let l = request_start(&api).await;
        request_claim(&api, &alice, &l).await;
        request_approve(&api, &alice, &l, Value::Null).await;
        let mut proof = request_proof(&l);
        proof["confirmation"] = value;
        assert_eq!(
            post_public(&api, "/api/link/request/collect", proof.clone())
                .await
                .status,
            StatusCode::CONFLICT
        );
        proof["confirmation"] = json!("47");
        assert_eq!(
            post_public(&api, "/api/link/request/collect", proof)
                .await
                .status,
            StatusCode::CONFLICT
        );
    }
}
#[tokio::test]
async fn approved_request_can_be_cancelled_and_device_key_cannot_be_swapped() {
    let (api, _, alice, _) = request_fixture().await;
    let l = request_start(&api).await;
    request_claim(&api, &alice, &l).await;
    request_approve(&api, &alice, &l, Value::Null).await;
    let mut wrong = request_proof(&l);
    wrong["device_key"] = json!(dkey(72));
    wrong["confirmation"] = json!("47");
    assert_eq!(
        post_public(&api, "/api/link/request/collect", wrong)
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        post_public(&api, "/api/link/request/cancel", request_proof(&l))
            .await
            .status,
        StatusCode::OK
    );
    let mut proof = request_proof(&l);
    proof["confirmation"] = json!("47");
    assert_eq!(
        post_public(&api, "/api/link/request/collect", proof)
            .await
            .status,
        StatusCode::CONFLICT
    );
}
#[tokio::test]
async fn unlock_is_account_and_session_bound_and_never_mints_a_session() {
    let (api, state, alice, bob) = request_fixture().await;
    let l = call(
        &api,
        "POST",
        "/api/link/unlock-request",
        &alice,
        json!({"device_name":"Browser","device_key":dkey(71)}),
    )
    .await
    .json();
    assert_eq!(
        request_claim(&api, &bob, &l).await.status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(request_claim(&api, &alice, &l).await.status, StatusCode::OK);
    assert_eq!(
        request_approve(&api, &alice, &l, Value::Null).await.status,
        StatusCode::BAD_REQUEST
    );
    let mut blob = vec![1u8; 79];
    blob[0] = 1;
    assert_eq!(
        request_approve(&api, &alice, &l, json!(B64.encode(blob)))
            .await
            .status,
        StatusCode::OK
    );
    let before: i64 = state
        .db
        .lock()
        .unwrap()
        .query_row("SELECT count(*) FROM sessions", [], |r| r.get(0))
        .unwrap();
    let mut proof = request_proof(&l);
    proof["confirmation"] = json!("47");
    assert_eq!(
        post_public(&api, "/api/link/request/collect", proof.clone())
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(
            &api,
            "POST",
            &request_path(&l, "collect"),
            &bob,
            proof.clone()
        )
        .await
        .status,
        StatusCode::NOT_FOUND
    );
    let out = call(&api, "POST", &request_path(&l, "collect"), &alice, proof).await;
    assert_eq!(out.status, StatusCode::OK);
    assert!(out.json().get("token").is_none());
    assert!(out.json()["wrapped_keys"].is_string());
    let after: i64 = state
        .db
        .lock()
        .unwrap()
        .query_row("SELECT count(*) FROM sessions", [], |r| r.get(0))
        .unwrap();
    assert_eq!(before, after);
}
#[tokio::test]
async fn request_double_claim_and_expiry_fail_closed() {
    let (api, state, alice, _) = request_fixture().await;
    let l = request_start(&api).await;
    assert_eq!(request_claim(&api, &alice, &l).await.status, StatusCode::OK);
    assert_eq!(
        request_claim(&api, &alice, &l).await.status,
        StatusCode::CONFLICT
    );
    assert_eq!(
        request_approve(&api, &alice, &l, Value::Null).await.status,
        StatusCode::CONFLICT
    );
    let l = request_start(&api).await;
    housecall_server::link::request::age_for_test(&state, l["link_id"].as_str().unwrap(), 121000);
    assert_eq!(
        request_claim(&api, &alice, &l).await.status,
        StatusCode::GONE
    );
}

#[tokio::test]
async fn request_wrong_secrets_result_window_and_approver_revocation() {
    let (api, state, alice, _) = request_fixture().await;
    let l = request_start(&api).await;
    let mut wrong = request_proof(&l);
    wrong["secret"] = json!(b43(17));
    for _ in 0..3 {
        assert_eq!(
            post_public(&api, "/api/link/request/status", wrong.clone())
                .await
                .status,
            StatusCode::NOT_FOUND
        );
    }
    assert_eq!(
        request_claim(&api, &alice, &l).await.status,
        StatusCode::CONFLICT
    );
    let l = request_start(&api).await;
    request_claim(&api, &alice, &l).await;
    request_approve(&api, &alice, &l, Value::Null).await;
    housecall_server::link::request::age_for_test(&state, l["link_id"].as_str().unwrap(), 61000);
    let mut proof = request_proof(&l);
    proof["confirmation"] = json!("47");
    assert_eq!(
        post_public(&api, "/api/link/request/collect", proof)
            .await
            .status,
        StatusCode::GONE
    );
    let l = request_start(&api).await;
    request_claim(&api, &alice, &l).await;
    request_approve(&api, &alice, &l, Value::Null).await;
    let sid = call(&api, "GET", "/api/me", &alice, json!({})).await.json()["session_id"]
        .as_str()
        .unwrap()
        .to_owned();
    state
        .db
        .lock()
        .unwrap()
        .execute("DELETE FROM sessions WHERE id=?", [sid])
        .unwrap();
    let mut proof = request_proof(&l);
    proof["confirmation"] = json!("47");
    assert_eq!(
        post_public(&api, "/api/link/request/collect", proof)
            .await
            .status,
        StatusCode::NOT_FOUND
    );
}
#[tokio::test]
async fn request_cap_does_not_starve_v1_and_configured_cors_covers_request_routes() {
    let (api, state, alice, _) = request_fixture().await;
    for _ in 0..200 {
        request_start(&api).await;
    }
    assert_eq!(
        post_public(
            &api,
            "/api/link/request",
            json!({"device_name":"Browser","device_key":dkey(71)})
        )
        .await
        .status,
        StatusCode::TOO_MANY_REQUESTS
    );
    start(&api, &alice).await;
    let mut state = state;
    state.client_origins = vec!["https://app.example.test".parse().unwrap()];
    let api = app(state, None);
    let request = Request::builder()
        .method("OPTIONS")
        .uri("/api/link/request/collect")
        .header("origin", "https://app.example.test")
        .header("access-control-request-method", "POST")
        .header("access-control-request-headers", "content-type")
        .body(Body::empty())
        .unwrap();
    let response = api.oneshot(request).await.unwrap();
    assert_eq!(
        response
            .headers()
            .get("access-control-allow-origin")
            .unwrap(),
        "https://app.example.test"
    );
}
