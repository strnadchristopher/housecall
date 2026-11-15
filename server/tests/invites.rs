use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use base64::Engine;
use housecall_server::{app, AppState};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;

const SETUP: &str = "test-bootstrap-credential-32-characters";

async fn call(
    api: &Router,
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
    let response = api
        .clone()
        .oneshot(req.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}
async fn owner() -> (Router, Value) {
    let mut state = AppState::new(":memory:", SETUP).unwrap();
    state.public_auth_limit = 1000;
    let api = app(state, None);
    let (s, a) = call(&api, "POST", "/api/setup", None, json!({"setup_token":SETUP,"username":"owner","password":"test-password-long","device_name":"test"})).await;
    assert_eq!(s, StatusCode::OK, "{a}");
    (api, a)
}
async fn create(api: &Router, owner: &Value, body: Value) -> Value {
    let (s, v) = call(api, "POST", "/api/invites", Some(owner), body).await;
    assert_eq!(s, StatusCode::OK, "{v}");
    v
}
async fn accept(api: &Router, token: &Value, name: &str) -> (StatusCode, Value) {
    call(
        api,
        "POST",
        "/api/invites/accept",
        None,
        json!({"token":token,"username":name,"password":"test-password-long","device_name":"test"}),
    )
    .await
}

#[tokio::test]
async fn default_invite_is_single_use() {
    let (api, a) = owner().await;
    let v = create(&api, &a, json!({"expires_in_seconds":3600})).await;
    assert_eq!(accept(&api, &v["token"], "alice").await.0, StatusCode::OK);
    assert_eq!(
        accept(&api, &v["token"], "bob").await.0,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn limited_invite_admits_exactly_max_uses() {
    let (api, a) = owner().await;
    let v = create(&api, &a, json!({"expires_in_seconds":3600,"max_uses":2})).await;
    assert_eq!(accept(&api, &v["token"], "alice").await.0, StatusCode::OK);
    assert_eq!(accept(&api, &v["token"], "bob").await.0, StatusCode::OK);
    assert_eq!(
        accept(&api, &v["token"], "carol").await.0,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn unlimited_never_expiring_invite_is_listed_as_such() {
    let (api, a) = owner().await;
    let v = create(&api, &a, json!({"expires_in_seconds":null,"max_uses":null})).await;
    for name in ["alice", "bob", "carol"] {
        assert_eq!(accept(&api, &v["token"], name).await.0, StatusCode::OK);
    }
    let (_, list) = call(&api, "GET", "/api/invites", Some(&a), Value::Null).await;
    let row = list["invites"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["id"] == v["id"])
        .unwrap()
        .clone();
    assert_eq!(row["expires_at"], Value::Null);
    assert_eq!(row["max_uses"], Value::Null);
    assert_eq!(row["uses"], json!(3));
}

#[tokio::test]
async fn rejects_out_of_range_options() {
    let (api, a) = owner().await;
    for body in [
        json!({"expires_in_seconds":30}),
        json!({"expires_in_seconds":31_536_001}),
        json!({"expires_in_seconds":3600,"max_uses":0}),
        json!({"expires_in_seconds":3600,"max_uses":1001}),
    ] {
        assert_eq!(
            call(&api, "POST", "/api/invites", Some(&a), body.clone())
                .await
                .0,
            StatusCode::BAD_REQUEST,
            "{body}"
        );
    }
}

#[tokio::test]
async fn code_carries_origin_and_token() {
    let (api, a) = owner().await;
    let v = create(&api, &a, json!({"expires_in_seconds":3600})).await;
    let token = v["token"].as_str().unwrap();
    let origin = v["link"]
        .as_str()
        .unwrap()
        .split("/#invite=")
        .next()
        .unwrap();
    let expected = format!(
        "hc1.{}.{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(origin),
        token
    );
    assert_eq!(v["code"], json!(expected));
    assert!(expected.starts_with("hc1.aHR0cDovL2xvY2FsaG9zdDoxNDIw."));
}

#[tokio::test]
async fn signed_in_member_redeems_into_another_server_without_spending_twice() {
    let (api, a) = owner().await;
    let home = create(&api, &a, json!({"expires_in_seconds":3600})).await;
    let (_, alice) = accept(&api, &home["token"], "alice").await;
    let (s, club) = call(
        &api,
        "POST",
        "/api/servers",
        Some(&a),
        json!({"name":"Book club"}),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{club}");
    let v = create(
        &api,
        &a,
        json!({"expires_in_seconds":3600,"max_uses":2,"server_id":club["id"]}),
    )
    .await;
    let (s, r) = call(
        &api,
        "POST",
        "/api/invites/redeem",
        Some(&alice),
        json!({"token":v["token"]}),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{r}");
    assert_eq!(r["server_id"], club["id"]);
    assert_eq!(r["joined"], json!(true));
    let (_, servers) = call(&api, "GET", "/api/servers", Some(&alice), Value::Null).await;
    assert!(servers["servers"]
        .as_array()
        .unwrap()
        .iter()
        .any(|s| s["id"] == club["id"]));
    let (s, again) = call(
        &api,
        "POST",
        "/api/invites/redeem",
        Some(&alice),
        json!({"token":v["token"]}),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(again["joined"], json!(false));
    assert_eq!(accept(&api, &v["token"], "bob").await.0, StatusCode::OK);
    assert_eq!(
        accept(&api, &v["token"], "carol").await.0,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn redeem_rejects_bad_tokens_and_anonymous_callers() {
    let (api, a) = owner().await;
    let fake = "ab".repeat(32);
    assert_eq!(
        call(
            &api,
            "POST",
            "/api/invites/redeem",
            Some(&a),
            json!({"token":fake})
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        call(
            &api,
            "POST",
            "/api/invites/redeem",
            Some(&a),
            json!({"token":"short"})
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        call(
            &api,
            "POST",
            "/api/invites/redeem",
            None,
            json!({"token":fake})
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
}
