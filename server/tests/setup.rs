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
const SENTINEL: &str = "sentinel-xyz";

async fn send(
    api: &Router,
    method: &str,
    path: &str,
    auth: Option<&Value>,
    body: Value,
) -> (StatusCode, String) {
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
    let res = api
        .clone()
        .oneshot(req.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    (status, String::from_utf8_lossy(&bytes).into_owned())
}

#[tokio::test]
async fn status_is_owner_only_and_never_returns_config_values() {
    // The only test in this file, so mutating process env cannot race another test.
    std::env::set_var("GIMME_DRY_RUN", "false");
    std::env::set_var("GIMME_BASE_URL", "https://gimme.example.com");
    std::env::set_var("GIMME_AGENT_API_KEY", SENTINEL);
    std::env::set_var("PLEX_TOKEN", "sentinel-plex-token");
    std::env::set_var("GIPHY_API_KEY", "sentinel-giphy-key");
    let mut state = AppState::new(":memory:", SETUP).unwrap();
    state.public_auth_limit = 1000;
    housecall_server::gimme::configure(&mut state).unwrap();
    let api = app(state, None);
    let (_, owner) = send(
        &api,
        "POST",
        "/api/setup",
        None,
        json!({"setup_token":SETUP,"username":"owner","password":"test-password-long","device_name":"t"}),
    )
    .await;
    let owner: Value = serde_json::from_str(&owner).unwrap();
    let (_, invite) = send(
        &api,
        "POST",
        "/api/invites",
        Some(&owner),
        json!({"expires_in_seconds":3600}),
    )
    .await;
    let invite: Value = serde_json::from_str(&invite).unwrap();
    let (_, member) = send(
        &api,
        "POST",
        "/api/invites/accept",
        None,
        json!({"token":invite["token"],"username":"alice","password":"test-password-long","device_name":"t"}),
    )
    .await;
    let member: Value = serde_json::from_str(&member).unwrap();

    let (status, _) = send(&api, "GET", "/api/setup/status", None, Value::Null).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = send(&api, "GET", "/api/setup/status", Some(&member), Value::Null).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let (status, body) = send(&api, "GET", "/api/setup/status", Some(&owner), Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    for secret in [
        SENTINEL,
        "sentinel-plex-token",
        "sentinel-giphy-key",
        "gimme.example.com",
    ] {
        assert!(!body.contains(secret), "body leaked {secret}");
    }
    let v: Value = serde_json::from_str(&body).unwrap();
    let rows = v["integrations"].as_array().unwrap();
    let ids: Vec<_> = rows.iter().map(|r| r["id"].as_str().unwrap()).collect();
    assert_eq!(
        ids,
        [
            "calls",
            "media",
            "scanner",
            "transcode",
            "dj",
            "gimme",
            "plex",
            "giphy",
            "vm"
        ]
    );
    let find = |id: &str| rows.iter().find(|r| r["id"] == id).unwrap();
    assert_eq!(find("gimme")["ready"], true);
    assert_eq!(find("giphy")["ready"], true);
    assert_eq!(find("calls")["ready"], false);
    assert_eq!(
        find("calls")["missing"],
        json!(["SFU_PUBLIC_IP", "SFU_PORT"])
    );
    for row in rows {
        for key in row.as_object().unwrap().keys() {
            assert!(["id", "ready", "missing", "detail"].contains(&key.as_str()));
        }
    }
}
