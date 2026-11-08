use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use chriscord_server::{app, AppState};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use std::{
    io::{self, Read},
    sync::Arc,
};
use tower::ServiceExt;
struct Clean;
impl chriscord_media::Scanner for Clean {
    fn scan(&self, input: &mut dyn Read) -> io::Result<()> {
        io::copy(input, &mut io::sink())?;
        Ok(())
    }
}
async fn request(
    api: &Router,
    method: &str,
    path: &str,
    auth: Option<&Value>,
    bytes: Vec<u8>,
    extra: Option<(&str, &str)>,
) -> (StatusCode, Vec<u8>) {
    let mut b = Request::builder().method(method).uri(path).header(
        "content-type",
        if method == "PATCH" {
            "application/octet-stream"
        } else {
            "application/json"
        },
    );
    if let Some(a) = auth {
        b = b
            .header(
                "authorization",
                format!("Bearer {}", a["token"].as_str().unwrap()),
            )
            .header("x-device-key", a["device_key"].as_str().unwrap());
    }
    if let Some((k, v)) = extra {
        b = b.header(k, v)
    }
    let response = api
        .clone()
        .oneshot(b.body(Body::from(bytes)).unwrap())
        .await
        .unwrap();
    (
        response.status(),
        response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .to_vec(),
    )
}
async fn json_req(
    api: &Router,
    method: &str,
    path: &str,
    auth: Option<&Value>,
    value: Value,
) -> (StatusCode, Value) {
    let (s, b) = request(
        api,
        method,
        path,
        auth,
        value.to_string().into_bytes(),
        None,
    )
    .await;
    (s, serde_json::from_slice(&b).unwrap_or(Value::Null))
}
#[tokio::test]
async fn encrypted_upload_http_resume_ownership_quarantine_range_and_limits() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = AppState::new(":memory:", "bootstrap-long-enough-for-test-secret").unwrap();
    s.media = Some(Arc::new(
        chriscord_media::Store::new(dir.path(), [7; 32]).unwrap(),
    ));
    let state = s.clone();
    let api = app(s, None);
    let(_,a)=json_req(&api,"POST","/api/setup",None,json!({"setup_token":"bootstrap-long-enough-for-test-secret","username":"owner","password":"password-long-enough","device_name":"test"})).await;
    let (_, i) = json_req(
        &api,
        "POST",
        "/api/invites",
        Some(&a),
        json!({"email":"fixture@example.test","expires_in_seconds":60}),
    )
    .await;
    let(_,b)=json_req(&api,"POST","/api/invites/accept",None,json!({"token":i["token"],"username":"outsider","password":"password-long-enough","device_name":"test"})).await;
    let (_, channel) = json_req(
        &api,
        "POST",
        "/api/channels",
        Some(&a),
        json!({"name":"private","kind":"channel"}),
    )
    .await;
    let cid = channel["id"].as_str().unwrap();
    for (method, path) in [
        ("POST", "/api/uploads"),
        ("GET", "/api/uploads/00000000-0000-0000-0000-000000000000"),
        ("PATCH", "/api/uploads/00000000-0000-0000-0000-000000000000"),
        (
            "DELETE",
            "/api/uploads/00000000-0000-0000-0000-000000000000",
        ),
        (
            "POST",
            "/api/uploads/00000000-0000-0000-0000-000000000000/complete",
        ),
        ("GET", "/api/media/00000000-0000-0000-0000-000000000000"),
    ] {
        assert_eq!(
            json_req(&api, method, path, None, json!({})).await.0,
            StatusCode::UNAUTHORIZED
        )
    }
    assert_eq!(
        json_req(
            &api,
            "POST",
            "/api/uploads",
            Some(&b),
            json!({"channel_id":cid,"filename":"test","length":"300000"})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (ok, u) = json_req(
        &api,
        "POST",
        "/api/uploads",
        Some(&a),
        json!({"channel_id":cid,"filename":"test.bin","length":"300000"}),
    )
    .await;
    assert_eq!(ok, StatusCode::OK, "{u}");
    let id = u["id"].as_str().unwrap();
    let path = format!("/api/uploads/{id}");
    for method in ["GET", "DELETE"] {
        assert_eq!(
            json_req(&api, method, &path, Some(&b), json!({})).await.0,
            StatusCode::NOT_FOUND
        )
    }
    assert_eq!(
        request(
            &api,
            "PATCH",
            &path,
            Some(&b),
            vec![1],
            Some(("upload-offset", "0"))
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        json_req(
            &api,
            "POST",
            &format!("{path}/complete"),
            Some(&b),
            json!({})
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        json_req(
            &api,
            "GET",
            &format!("/api/media/{id}"),
            Some(&b),
            json!({})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        request(
            &api,
            "PATCH",
            &path,
            Some(&a),
            vec![42; 200000],
            Some(("upload-offset", "0"))
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        request(
            &api,
            "PATCH",
            &path,
            Some(&a),
            vec![42; 100000],
            Some(("upload-offset", "0"))
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        json_req(&api, "GET", &path, Some(&a), json!({})).await.1["offset"],
        "200000"
    );
    assert_eq!(
        request(
            &api,
            "PATCH",
            &path,
            Some(&a),
            vec![42; 100000],
            Some(("upload-offset", "200000"))
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        json_req(
            &api,
            "POST",
            &format!("{path}/complete"),
            Some(&a),
            json!({})
        )
        .await
        .0,
        StatusCode::LOCKED
    );
    assert_eq!(
        json_req(
            &api,
            "GET",
            &format!("/api/media/{id}"),
            Some(&a),
            json!({})
        )
        .await
        .0,
        StatusCode::LOCKED
    );
    let mut clean = state;
    clean.scanner = Arc::new(Clean);
    let api = app(clean, None);
    assert_eq!(
        json_req(
            &api,
            "POST",
            &format!("{path}/complete"),
            Some(&a),
            json!({})
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        json_req(
            &api,
            "POST",
            "/api/reports",
            Some(&a),
            json!({"kind":"bug","body":"screenshot","screenshot_id":id})
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let (status, report) = json_req(
        &api,
        "POST",
        "/api/reports",
        Some(&a),
        json!({"kind":"bug","body":"screenshot","screenshot_id":id,"screenshot_consent":true}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let screenshot_path = format!("/api/reports/{}/screenshot", report["id"].as_str().unwrap());
    assert_eq!(
        json_req(&api, "GET", &screenshot_path, Some(&b), json!({}))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        request(&api, "GET", &screenshot_path, Some(&a), vec![], None)
            .await
            .1,
        vec![42; 300000]
    );
    let (status, bytes) = request(
        &api,
        "GET",
        &format!("/api/media/{id}"),
        Some(&a),
        vec![],
        Some(("range", "bytes=100-199")),
    )
    .await;
    assert_eq!(status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(bytes, vec![42; 100]);
    assert_eq!(
        request(
            &api,
            "GET",
            &format!("/api/media/{id}"),
            Some(&a),
            vec![],
            Some(("range", "bytes=999999-"))
        )
        .await
        .0,
        StatusCode::RANGE_NOT_SATISFIABLE
    );
    assert_eq!(
        request(
            &api,
            "PATCH",
            &path,
            Some(&a),
            vec![0; 4 * 1024 * 1024 + 1],
            Some(("upload-offset", "300000"))
        )
        .await
        .0,
        StatusCode::PAYLOAD_TOO_LARGE
    );
    let (status, message) = json_req(
        &api,
        "POST",
        &format!("/api/channels/{cid}/messages"),
        Some(&a),
        json!({"body":"","attachment_ids":[id]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{message}");
    assert_eq!(message["attachments"][0]["id"], id);
    assert_eq!(
        json_req(
            &api,
            "DELETE",
            &format!("/api/messages/{}", message["id"].as_str().unwrap()),
            Some(&a),
            json!({})
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        json_req(
            &api,
            "GET",
            &format!("/api/media/{id}"),
            Some(&a),
            json!({})
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
}
