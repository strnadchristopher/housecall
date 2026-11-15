use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use housecall_server::{app, AppState};
use http_body_util::BodyExt;
use tower::ServiceExt;

/// Every optional integration variable is empty, as in a fresh `.env`: the
/// integrations stay disabled and the server still configures and answers.
#[tokio::test]
async fn health_ok_with_all_integration_variables_empty() {
    for name in [
        "GIPHY_API_KEY",
        "PLEX_URL",
        "PLEX_TOKEN",
        "GIMME_BASE_URL",
        "GIMME_AGENT_API_KEY",
        "SWITCHBOARD_URL",
        "SWITCHBOARD_API_KEY",
        "DJ_ENABLED",
        "SPOTIFY_ACCESS_TOKEN",
        "PUSH_ENABLED",
        "PUSH_TOKEN_KEY",
        "APNS_PRIVATE_KEY_PEM",
        "APNS_KEY_ID",
        "APNS_TEAM_ID",
        "APNS_TOPIC",
        "FCM_SERVICE_ACCOUNT_JSON",
        "RESEND_API_KEY",
        "HOUSECALL_MAIL_FROM",
    ] {
        std::env::set_var(name, "");
    }
    // Compose passes DJ_ENABLED and PUSH_ENABLED as "false" by default.
    std::env::set_var("DJ_ENABLED", "false");
    std::env::set_var("PUSH_ENABLED", "false");
    std::env::set_var("GIMME_DRY_RUN", "false");

    let mut state = AppState::new(":memory:", "test-bootstrap-credential-32-characters").unwrap();
    housecall_server::plex::configure(&mut state).unwrap();
    housecall_server::gimme::configure(&mut state).unwrap();
    housecall_server::dj::configure(&mut state).unwrap();
    housecall_server::push::configure(&mut state).unwrap();
    assert!(state.gimme.is_dry_run());
    assert!(state.plex.is_none());
    assert!(state.dj.is_none());

    let response = app(state, None)
        .oneshot(
            Request::builder()
                .uri("/api/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(value["ok"], true);
    assert_eq!(
        value["version"],
        env!("CARGO_PKG_VERSION"),
        "Settings, About shows the server version"
    );
}
