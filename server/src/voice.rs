use crate::{member, now, ApiError, ApiResult, AppState, Principal};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::{delete, get, post},
    Extension, Json, Router,
};
use rusqlite::params;
use serde_json::{json, Value};
use std::sync::Arc;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/channels/{id}/voice/join", post(join))
        .route("/channels/{id}/voice/stats", get(stats))
        .route("/channels/{id}/voice/{peer}", delete(leave))
}
/// Enable explicitly with the UDP bind address and routable advertised IP from environment.
pub fn configure(state: &mut AppState) -> Result<(), String> {
    let bind = std::env::var("SFU_BIND").ok();
    let public = std::env::var("SFU_PUBLIC_IP").ok();
    match (bind, public) {
        (None, None) => Ok(()),
        (Some(bind), Some(public)) => {
            let bind = bind.parse().map_err(|_| "invalid SFU_BIND")?;
            let public = public.parse().map_err(|_| "invalid SFU_PUBLIC_IP")?;
            let db = state.db.clone();
            let publisher = state.vm_media.clone();
            let authorize: chriscord_sfu::Authorize = Arc::new(move |room, user, session| {
                let Ok(db) = db.lock() else {
                    return false;
                };
                if publisher.authorize(&db, room, user, session) {
                    return true;
                }
                db.query_row("SELECT EXISTS(SELECT 1 FROM sessions s JOIN members m ON m.user_id=s.user_id WHERE s.id=?1 AND s.user_id=?2 AND s.expires_at>?3 AND m.channel_id=?4)", params![session, user, now(), room], |r| r.get::<_, bool>(0)).unwrap_or(false)
            });
            let sfu =
                chriscord_sfu::Sfu::start(bind, public, authorize).map_err(|e| e.to_string())?;
            tracing::info!(address=%sfu.address(), "private WebRTC SFU enabled");
            state.voice = Some(Arc::new(sfu));
            Ok(())
        }
        _ => Err("set both SFU_BIND and SFU_PUBLIC_IP, or neither".into()),
    }
}
fn engine(s: &AppState) -> Result<Arc<chriscord_sfu::Sfu>, ApiError> {
    s.voice.clone().ok_or(ApiError(
        StatusCode::SERVICE_UNAVAILABLE,
        "voice transport is not configured",
    ))
}
fn error(e: chriscord_sfu::Error) -> ApiError {
    match e {
        chriscord_sfu::Error::Forbidden => {
            ApiError(StatusCode::FORBIDDEN, "voice session unauthorized")
        }
        chriscord_sfu::Error::Invalid => ApiError(StatusCode::BAD_REQUEST, "invalid voice offer"),
        chriscord_sfu::Error::Busy => {
            ApiError(StatusCode::SERVICE_UNAVAILABLE, "voice capacity reached")
        }
        chriscord_sfu::Error::Io => {
            ApiError(StatusCode::INTERNAL_SERVER_ERROR, "voice transport failed")
        }
    }
}
async fn join(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(room): Path<String>,
    Json(offer): Json<Value>,
) -> ApiResult<Value> {
    {
        let db = s.db.lock().unwrap();
        member(&db, &p.user.id, &room)?;
    }
    let engine = engine(&s)?;
    let offer = serde_json::from_value::<chriscord_sfu::SdpOffer>(offer)
        .map_err(|_| ApiError(StatusCode::BAD_REQUEST, "invalid SDP offer"))?;
    let joined = engine
        .join(room, p.user.id, p.session_id, offer)
        .await
        .map_err(error)?;
    Ok(Json(json!(joined)))
}
async fn stats(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(room): Path<String>,
) -> ApiResult<Value> {
    {
        let db = s.db.lock().unwrap();
        member(&db, &p.user.id, &room)?;
    }
    let stats = engine(&s)?.stats(room, p.session_id).await.map_err(error)?;
    Ok(Json(json!({"peers":stats})))
}
async fn leave(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path((room, peer)): Path<(String, u64)>,
) -> ApiResult<Value> {
    {
        let db = s.db.lock().unwrap();
        member(&db, &p.user.id, &room)?;
    }
    engine(&s)?
        .leave(room, p.session_id, peer)
        .await
        .map_err(error)?;
    Ok(Json(json!({"left":true})))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use tower::ServiceExt;
    #[tokio::test]
    async fn all_voice_routes_require_authentication_and_membership_even_when_disabled() {
        let state = AppState::new(":memory:", "fixture").unwrap();
        {
            let db = state.db.lock().unwrap();
            db.execute("INSERT INTO users(id,username,password,is_owner) VALUES('outsider','outsider','unused',0)", []).unwrap();
            db.execute(
                "INSERT INTO channels(id,name,kind) VALUES('room','Room','channel')",
                [],
            )
            .unwrap();
            db.execute("INSERT INTO sessions(id,user_id,token_hash,device_hash,device_name,created_at,expires_at) VALUES('s','outsider',?1,?2,'fixture',?3,?4)", params![crate::hash(&"a".repeat(64)),crate::hash(&"b".repeat(64)), now(), now()+60_000]).unwrap();
        }
        for (method, path) in [
            ("POST", "/api/channels/room/voice/join"),
            ("GET", "/api/channels/room/voice/stats"),
            ("DELETE", "/api/channels/room/voice/1"),
        ] {
            for authenticated in [false, true] {
                let mut req = Request::builder()
                    .method(method)
                    .uri(path)
                    .header("content-type", "application/json");
                if authenticated {
                    req = req
                        .header("authorization", format!("Bearer {}", "a".repeat(64)))
                        .header("x-device-key", "b".repeat(64));
                }
                let response = crate::app(state.clone(), None)
                    .oneshot(req.body(Body::from("{}")).unwrap())
                    .await
                    .unwrap();
                assert_eq!(
                    response.status(),
                    if authenticated {
                        StatusCode::FORBIDDEN
                    } else {
                        StatusCode::UNAUTHORIZED
                    },
                    "{method} {path}"
                );
            }
        }
    }
}
