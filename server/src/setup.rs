//! Owner-only integration readiness. Reports booleans and env var *names* only, never values.
use crate::{owner, ApiResult, AppState, Principal};
use axum::{extract::State, routing::get, Extension, Json, Router};
use serde_json::{json, Value};

/// GET /api/setup/status. Mounted with the other private routes: it needs a session, then an owner.
pub fn routes() -> Router<AppState> {
    Router::new().route("/setup/status", get(status))
}

fn row(id: &str, ready: bool, missing: &[&str]) -> Value {
    if ready {
        json!({"id":id,"ready":true})
    } else {
        json!({"id":id,"ready":false,"missing":missing})
    }
}

async fn status(State(s): State<AppState>, Extension(p): Extension<Principal>) -> ApiResult<Value> {
    owner(&p)?;
    let calls = s.voice.is_some();
    let media = s.media.is_some();
    let scanner = !matches!(
        s.scanner.engine(),
        housecall_media::scan::Engine::Disabled | housecall_media::scan::Engine::Unspecified
    );
    let transcode_missing: &[&str] = if media {
        &["HOUSECALL_FFMPEG"]
    } else {
        &["HOUSECALL_MEDIA_KEY"]
    };
    let dj_missing: &[&str] = if !calls {
        &["SFU_PUBLIC_IP"]
    } else if !media {
        &["HOUSECALL_MEDIA_KEY"]
    } else {
        &["DJ_ENABLED", "SWITCHBOARD_URL"]
    };
    let integrations = vec![
        row("calls", calls, &["SFU_PUBLIC_IP", "SFU_PORT"]),
        row("media", media, &["HOUSECALL_MEDIA_KEY"]),
        row(
            "scanner",
            scanner,
            &["HOUSECALL_MEDIA_SCANNER", "HOUSECALL_FSANALYZE"],
        ),
        row("transcode", s.transcoder.is_some(), transcode_missing),
        row("dj", s.dj.is_some() && calls, dj_missing),
        row(
            "gimme",
            !s.gimme.is_dry_run(),
            &["GIMME_BASE_URL", "GIMME_AGENT_API_KEY", "GIMME_DRY_RUN"],
        ),
        row(
            "plex",
            s.plex.is_some() && calls,
            &["PLEX_URL", "PLEX_TOKEN"],
        ),
        row("giphy", crate::giphy::configured(), &["GIPHY_API_KEY"]),
        row(
            "vm",
            s.vm.is_some() && calls,
            &["compose profile: vm", "HOUSECALL_VM_CHANNEL_ID"],
        ),
    ];
    Ok(Json(json!({"integrations":integrations})))
}
