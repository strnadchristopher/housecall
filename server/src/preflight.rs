//! First-run checklist. Public, rate limited, read only, and only while no owner exists.
//! Answers with booleans and short reason codes: no paths, versions or addresses.
use crate::{ApiError, ApiResult, AppState};
use axum::{extract::State, http::HeaderMap, http::StatusCode, routing::get, Json, Router};
use serde_json::{json, Value};

pub fn routes() -> Router<AppState> {
    Router::new().route("/preflight", get(preflight))
}

fn check(ok: bool, reason: &str) -> Value {
    if ok {
        json!({"ok":true})
    } else {
        json!({"ok":false,"reason":reason})
    }
}

fn https_ok(headers: &HeaderMap) -> bool {
    let forwarded = headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| {
            v.split(',')
                .next()
                .is_some_and(|p| p.trim().eq_ignore_ascii_case("https"))
        });
    forwarded
}

async fn preflight(State(s): State<AppState>, headers: HeaderMap) -> ApiResult<Value> {
    if s.limited("public:preflight".into(), 30) {
        return Err(ApiError(StatusCode::TOO_MANY_REQUESTS, "try again later"));
    }
    let storage = {
        let db = s.db.lock().unwrap();
        let owned = db
            .query_row("SELECT COUNT(*) FROM users", [], |r| r.get::<_, i64>(0))
            .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "internal error"))?;
        if owned > 0 {
            return Err(ApiError(StatusCode::NOT_FOUND, "not found"));
        }
        // Take the write lock and release it again without changing anything.
        let ok = db.execute_batch("BEGIN IMMEDIATE; ROLLBACK;").is_ok();
        if !ok {
            let _ = db.execute_batch("ROLLBACK");
        }
        ok
    };
    Ok(Json(json!({
        "https": check(https_ok(&headers), "plain_http"),
        // A bound SFU is configuration, not evidence of external UDP reachability.
        "call_port": check(false, if s.voice.is_some() { "external_unverified" } else { "voice_off" }),
        "storage": check(storage, "not_writable"),
    })))
}
