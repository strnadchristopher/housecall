//! Request access: public request, owner approval/decline, and the open/closed toggle.
use axum::{body::Body, http::{Request, StatusCode}, Router};
use housecall_server::{app, AppState};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;

const SETUP: &str = "test-bootstrap-credential-32-characters";
const PW: &str = "test-password-long";

async fn call(api: &Router, method: &str, path: &str, auth: Option<&Value>, body: Value) -> (StatusCode, Value) {
    let mut req = Request::builder().method(method).uri(path).header("content-type", "application/json");
    if let Some(a) = auth {
        req = req
            .header("authorization", format!("Bearer {}", a["token"].as_str().unwrap()))
            .header("x-device-key", a["device_key"].as_str().unwrap());
    }
    let response = api.clone().oneshot(req.body(Body::from(body.to_string())).unwrap()).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}
async fn owner() -> (Router, Value) {
    let mut state = AppState::new(":memory:", SETUP).unwrap();
    state.public_auth_limit = 10_000;
    let api = app(state, None);
    let (s, a) = call(&api, "POST", "/api/setup", None, json!({"setup_token":SETUP,"username":"owner","password":PW,"device_name":"test"})).await;
    assert_eq!(s, StatusCode::OK, "{a}");
    (api, a)
}
async fn request(api: &Router, name: &str) -> (StatusCode, Value) {
    call(api, "POST", "/api/access-requests", None, json!({"username":name,"password":PW,"device_name":"phone","message":"hi, it is me"})).await
}
async fn login(api: &Router, name: &str) -> (StatusCode, Value) {
    call(api, "POST", "/api/login", None, json!({"username":name,"password":PW,"device_name":"phone"})).await
}

#[tokio::test]
async fn instance_is_public_and_reports_name_and_openness() {
    let (api, a) = owner().await;
    let (s, v) = call(&api, "GET", "/api/instance", None, Value::Null).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["name"], json!("Housecall"));
    assert_eq!(v["requests_open"], json!(true));
    let (s, _) = call(&api, "PATCH", "/api/instance", Some(&a), json!({"requests_open":false})).await;
    assert_eq!(s, StatusCode::OK);
    let (_, v) = call(&api, "GET", "/api/instance", None, Value::Null).await;
    assert_eq!(v["requests_open"], json!(false));
}

#[tokio::test]
async fn toggle_is_owner_only() {
    let (api, a) = owner().await;
    let (_, inv) = call(&api, "POST", "/api/invites", Some(&a), json!({"expires_in_seconds":3600})).await;
    let (_, bob) = call(&api, "POST", "/api/invites/accept", None, json!({"token":inv["token"],"username":"bob","password":PW,"device_name":"t"})).await;
    assert_eq!(call(&api, "PATCH", "/api/instance", Some(&bob), json!({"requests_open":false})).await.0, StatusCode::FORBIDDEN);
    assert_eq!(call(&api, "GET", "/api/access-requests", Some(&bob), Value::Null).await.0, StatusCode::FORBIDDEN);
    assert_eq!(call(&api, "PATCH", "/api/instance", None, json!({"requests_open":false})).await.0, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn request_then_approve_lets_the_person_log_in_and_join_general() {
    let (api, a) = owner().await;
    let (s, r) = request(&api, "casey").await;
    assert_eq!(s, StatusCode::OK, "{r}");
    assert_eq!(r["status"], json!("pending"));
    let id = r["id"].as_str().unwrap().to_owned();
    assert_eq!(id.len(), 64);
    let (s, st) = call(&api, "GET", &format!("/api/access-requests/{id}/status"), None, Value::Null).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(st, json!({"status":"pending"}));

    let (s, e) = login(&api, "casey").await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    assert_eq!(e["error"], json!("access request pending"));
    assert_eq!(login(&api, "nobody").await.0, StatusCode::UNAUTHORIZED);
    let (s, _) = call(&api, "POST", "/api/login", None, json!({"username":"casey","password":"wrong-password-long","device_name":"x"})).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);

    let (s, list) = call(&api, "GET", "/api/access-requests", Some(&a), Value::Null).await;
    assert_eq!(s, StatusCode::OK);
    let row = &list["requests"][0];
    assert_eq!(row["id"], json!(id));
    assert_eq!(row["username"], json!("casey"));
    assert_eq!(row["message"], json!("hi, it is me"));
    assert_eq!(row["status"], json!("pending"));

    // Pending people are not visible as members to anyone.
    let (_, members) = call(&api, "GET", "/api/members", Some(&a), Value::Null).await;
    assert!(!members.to_string().contains("casey"));

    let (s, _) = call(&api, "POST", &format!("/api/access-requests/{id}/approve"), Some(&a), json!({})).await;
    assert_eq!(s, StatusCode::OK);
    let (_, st) = call(&api, "GET", &format!("/api/access-requests/{id}/status"), None, Value::Null).await;
    assert_eq!(st["status"], json!("approved"));
    let (s, casey) = login(&api, "casey").await;
    assert_eq!(s, StatusCode::OK, "{casey}");
    let (_, servers) = call(&api, "GET", "/api/servers", Some(&casey), Value::Null).await;
    assert!(servers["servers"].as_array().unwrap().iter().any(|s| s["id"] == json!("home")));
    // A decided request can't be decided again.
    assert_eq!(call(&api, "POST", &format!("/api/access-requests/{id}/decline"), Some(&a), json!({})).await.0, StatusCode::CONFLICT);
}

#[tokio::test]
async fn decline_frees_the_username_and_blocks_login() {
    let (api, a) = owner().await;
    let (_, r) = request(&api, "casey").await;
    let id = r["id"].as_str().unwrap().to_owned();
    assert_eq!(request(&api, "casey").await.0, StatusCode::CONFLICT);
    let (s, _) = call(&api, "POST", &format!("/api/access-requests/{id}/decline"), Some(&a), json!({})).await;
    assert_eq!(s, StatusCode::OK);
    let (_, st) = call(&api, "GET", &format!("/api/access-requests/{id}/status"), None, Value::Null).await;
    assert_eq!(st["status"], json!("declined"));
    assert_eq!(login(&api, "casey").await.0, StatusCode::UNAUTHORIZED);
    assert_eq!(request(&api, "casey").await.0, StatusCode::OK);
}

#[tokio::test]
async fn closed_instance_refuses_requests() {
    let (api, a) = owner().await;
    call(&api, "PATCH", "/api/instance", Some(&a), json!({"requests_open":false})).await;
    assert_eq!(request(&api, "casey").await.0, StatusCode::FORBIDDEN);
    call(&api, "PATCH", "/api/instance", Some(&a), json!({"requests_open":true})).await;
    assert_eq!(request(&api, "casey").await.0, StatusCode::OK);
}

#[tokio::test]
async fn validation_unknown_ids_and_pending_cap() {
    let (api, a) = owner().await;
    assert_eq!(call(&api, "POST", "/api/access-requests", None, json!({"username":"x","password":PW,"device_name":"p"})).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(call(&api, "POST", "/api/access-requests", None, json!({"username":"okname","password":"short","device_name":"p"})).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(call(&api, "POST", "/api/access-requests", None, json!({"username":"okname","password":PW,"device_name":"p","message":"x".repeat(501)})).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(request(&api, "owner").await.0, StatusCode::CONFLICT);
    let fake = "ab".repeat(32);
    assert_eq!(call(&api, "GET", &format!("/api/access-requests/{fake}/status"), None, Value::Null).await.0, StatusCode::NOT_FOUND);
    assert_eq!(call(&api, "POST", &format!("/api/access-requests/{fake}/approve"), Some(&a), json!({})).await.0, StatusCode::NOT_FOUND);
    for i in 0..50 {
        assert_eq!(request(&api, &format!("person{i}")).await.0, StatusCode::OK, "{i}");
    }
    assert_eq!(request(&api, "onetoomany").await.0, StatusCode::TOO_MANY_REQUESTS);
}
