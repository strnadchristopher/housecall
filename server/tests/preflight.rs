use axum::{body::Body, http::{Request, StatusCode}};
use housecall_server::{app, AppState};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;

async fn call(api: &axum::Router, method: &str, path: &str, headers: &[(&str, &str)], body: Value) -> (StatusCode, String) {
    let mut req = Request::builder().method(method).uri(path).header("content-type", "application/json");
    for (k, v) in headers { req = req.header(*k, *v); }
    let r = api.clone().oneshot(req.body(Body::from(body.to_string())).unwrap()).await.unwrap();
    let status = r.status();
    let bytes = r.into_body().collect().await.unwrap().to_bytes();
    (status, String::from_utf8_lossy(&bytes).into_owned())
}

#[tokio::test]
async fn preflight_reports_booleans_before_an_owner_exists_then_404s() {
    let secret = "preflight-bootstrap-secret-at-least-32-chars";
    let api = app(AppState::new(":memory:", secret).unwrap(), None);
    let (status, body) = call(&api, "GET", "/api/preflight", &[("x-forwarded-proto", "https")], Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    let v: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v["https"]["ok"], true);
    assert_eq!(v["storage"]["ok"], true);
    assert_eq!(v["call_port"]["ok"], false);
    assert_eq!(v["call_port"]["reason"], "voice_off");
    assert!(!body.contains('/') && !body.contains("version") && !body.contains("127.0.0.1"));

    let (_, plain) = call(&api, "GET", "/api/preflight", &[], Value::Null).await;
    let v: Value = serde_json::from_str(&plain).unwrap();
    if std::env::var("HOUSECALL_PUBLIC_URL").is_err() {
        assert_eq!(v["https"]["reason"], "plain_http");
    }

    let (status, _) = call(&api, "POST", "/api/setup", &[], json!({"setup_token":secret,"username":"first","password":"long fixture password123","device_name":"t"})).await;
    assert_eq!(status, StatusCode::OK);
    let (status, body) = call(&api, "GET", "/api/preflight", &[], Value::Null).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(!body.contains("https"));
}
