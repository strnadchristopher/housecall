//! Fail closed when a newly declared route escapes the authentication boundary.
use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use housecall_server::{app, AppState};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use tower::ServiceExt;

fn inventory() -> BTreeSet<(String, String)> {
    let mut routes = BTreeSet::new();
    let mut local_peer_routes = BTreeSet::new();
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    for file in std::fs::read_dir(root).unwrap() {
        let path = file.unwrap().path();
        if path.extension().and_then(|s| s.to_str()) != Some("rs") {
            continue;
        }
        let source = std::fs::read_to_string(path).unwrap();
        for tail in source.split(".route(").skip(1) {
            let tail = tail.trim_start();
            assert!(
                tail.starts_with('"'),
                "route inventory requires literal route paths; extend parser for new routing shape"
            );
            let end = tail[1..].find('"').unwrap() + 1;
            let path = &tail[1..end];
            let expression = &tail[end + 1..];
            let mut depth = 1i32;
            let mut quoted = false;
            let mut escaped = false;
            let mut finish = 0;
            for (i, c) in expression.char_indices() {
                if escaped {
                    escaped = false;
                    continue;
                }
                if c == '\\' && quoted {
                    escaped = true;
                    continue;
                }
                if c == '"' {
                    quoted = !quoted;
                    continue;
                }
                if !quoted {
                    if c == '(' {
                        depth += 1
                    }
                    if c == ')' {
                        depth -= 1
                    }
                }
                if depth == 0 {
                    finish = i;
                    break;
                }
            }
            assert!(finish > 0, "unparsed route {path}");
            let methods = &expression[..finish];
            let mut found = false;
            for method in ["get", "post", "patch", "delete", "put", "head", "options"] {
                if methods.contains(&format!("{method}(")) {
                    found = true;
                    if path.starts_with("/v1/vm-publisher/") {
                        // These routes are served only on the private Unix socket and
                        // authenticate the connecting process with SO_PEERCRED.
                        local_peer_routes.insert((method.to_uppercase(), path.to_owned()));
                    } else {
                        routes.insert((method.to_uppercase(), format!("/api{path}")));
                        if method == "get" {
                            routes.insert(("HEAD".into(), format!("/api{path}")));
                        }
                    }
                }
            }
            assert!(found, "unknown method declaration for {path}");
        }
    }
    assert!(routes.len() > 65, "inventory unexpectedly shrank");
    assert_eq!(
        local_peer_routes.len(),
        4,
        "local peer route inventory changed"
    );
    routes
}
async fn request(
    api: &Router,
    method: &str,
    path: &str,
    auth: Option<(&str, &str)>,
    body: Value,
) -> (StatusCode, Value) {
    let mut req = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    if let Some((token, key)) = auth {
        req = req.header("authorization", format!("Bearer {token}"));
        if !key.is_empty() {
            req = req.header("x-device-key", key)
        }
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
#[tokio::test]
async fn every_declared_private_route_rejects_missing_stolen_and_revoked_credentials() {
    let secret = "route-inventory-bootstrap-secret-at-least32";
    let state = AppState::new(":memory:", secret).unwrap();
    let db = state.db.clone();
    let api = app(state, None);
    let (status,session)=request(&api,"POST","/api/setup",None,json!({"setup_token":secret,"username":"inventory","password":"long fixture password123","device_name":"inventory"})).await;
    assert_eq!(status, StatusCode::OK);
    let token = session["token"].as_str().unwrap();
    let key = session["device_key"].as_str().unwrap();
    let all = inventory();
    let public = BTreeSet::from([
        ("POST".to_owned(), "/api/setup".to_owned()),
        ("POST".into(), "/api/login".into()),
        ("POST".into(), "/api/invites/accept".into()),
        ("GET".into(), "/api/instance".into()),
        ("HEAD".into(), "/api/instance".into()),
        ("POST".into(), "/api/access-requests".into()),
        ("GET".into(), "/api/access-requests/{id}/status".into()),
        ("HEAD".into(), "/api/access-requests/{id}/status".into()),
        ("GET".into(), "/api/preflight".into()),
        ("HEAD".into(), "/api/preflight".into()),
        ("GET".into(), "/api/health".into()),
        ("HEAD".into(), "/api/health".into()),
        ("POST".into(), "/api/passkeys/login/start".into()),
        ("POST".into(), "/api/passkeys/login/finish".into()),
        ("POST".into(), "/api/link/claim".into()),
        ("POST".into(), "/api/link/result".into()),
    ]);
    assert!(public.is_subset(&all));
    let private = all.difference(&public).cloned().collect::<Vec<_>>();
    for auth in [
        None,
        Some((token, "")),
        Some((token, "wrong-device-secret")),
    ] {
        for (method, path) in &private {
            let path = path
                .replace("{id}", "00000000-0000-4000-8000-000000000001")
                .replace("{peer}", "1")
                .replace("{user}", "user");
            assert_eq!(
                request(&api, method, &path, auth, json!({})).await.0,
                StatusCode::UNAUTHORIZED,
                "{method} {path}"
            );
        }
    }
    assert_eq!(
        request(&api, "GET", "/api/me", Some((token, key)), json!({}))
            .await
            .0,
        StatusCode::OK
    );
    db.lock()
        .unwrap()
        .execute("DELETE FROM sessions", [])
        .unwrap();
    for (method, path) in &private {
        let path = path
            .replace("{id}", "00000000-0000-4000-8000-000000000001")
            .replace("{peer}", "1")
            .replace("{user}", "user");
        assert_eq!(
            request(&api, method, &path, Some((token, key)), json!({}))
                .await
                .0,
            StatusCode::UNAUTHORIZED,
            "revoked {method} {path}"
        );
    }
    println!(
        "{} private method/path pairs rejected all4 credential failures; {} explicit public pairs",
        private.len(),
        public.len()
    );
}
