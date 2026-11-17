//! Authorization is exercised against the real router without opening any sockets.
use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use housecall_server::{app, AppState};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;
async fn call(
    api: &Router,
    method: &str,
    path: &str,
    auth: Option<&Value>,
    value: Value,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    if let Some(auth) = auth {
        request = request
            .header(
                "authorization",
                format!("Bearer {}", auth["token"].as_str().unwrap()),
            )
            .header("x-device-key", auth["device_key"].as_str().unwrap());
    }
    let reply = api
        .clone()
        .oneshot(request.body(Body::from(value.to_string())).unwrap())
        .await
        .unwrap();
    let status = reply.status();
    let bytes = reply.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}
#[tokio::test]
async fn directory_is_private_by_default_and_owner_only() {
    std::env::remove_var("HOUSECALL_DIRECTORY_ENABLED");
    let api = app(
        AppState::new(":memory:", "synthetic-setup-at-least-32-characters").unwrap(),
        None,
    );
    let (status, owner) = call(&api, "POST", "/api/setup", None, json!({"setup_token":"synthetic-setup-at-least-32-characters","username":"fixture_owner","password":"synthetic fixture password","device_name":"fixture"})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        call(&api, "GET", "/api/directory", None, Value::Null)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(&api, "GET", "/api/directory", Some(&owner), Value::Null)
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    let (_, invite) = call(
        &api,
        "POST",
        "/api/invites",
        Some(&owner),
        json!({"expires_in_seconds":300}),
    )
    .await;
    let (status, member) = call(&api,"POST","/api/invites/accept",None,json!({"token":invite["token"],"username":"fixture_member","password":"synthetic fixture password","device_name":"fixture"})).await;
    assert_eq!(status, StatusCode::OK);
    for method in ["GET", "PUT"] {
        assert_eq!(
            call(
                &api,
                method,
                "/api/directory",
                Some(&member),
                json!({"listed":true,"description":"Synthetic"})
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
    }
}
