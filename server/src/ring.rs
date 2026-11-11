//! 1:1 calls through the server: ring the other person in a direct conversation.
//! The call itself is the normal voice room of that conversation; these routes only
//! tell the other member (and, on iOS, their phone) that someone is calling.
use crate::{bad, member, now, ApiError, ApiResult, AppState, Principal};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::post,
    Extension, Json, Router,
};
use rusqlite::{params, Connection};
use serde_json::{json, Value};

/// One ring per caller per conversation in this window. Decline is not limited beyond the session limit.
const RING_WINDOW_MS: i64 = 10_000;

fn ring_key(channel: &str, caller: &str) -> String {
    format!("{channel}:{caller}")
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/channels/{id}/ring", post(ring))
        .route("/channels/{id}/ring/decline", post(decline))
}

/// The other member of a two-person direct conversation the caller belongs to.
fn other_member(db: &Connection, caller: &str, channel: &str) -> Result<String, ApiError> {
    member(db, caller, channel)?;
    let kind: String = db.query_row("SELECT kind FROM channels WHERE id=?", [channel], |r| {
        r.get(0)
    })?;
    let mut q = db.prepare("SELECT user_id FROM members WHERE channel_id=?")?;
    let members = q
        .query_map([channel], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    if kind != "dm" || members.len() != 2 {
        return Err(bad("only a direct conversation can be rung"));
    }
    members
        .into_iter()
        .find(|id| id != caller)
        .ok_or_else(|| bad("only a direct conversation can be rung"))
}

/// Delivered to one member only (the shared `emit` goes to everyone in the channel, caller included).
fn emit_to(
    db: &Connection,
    user: &str,
    channel: &str,
    kind: &str,
    payload: Value,
) -> Result<(), ApiError> {
    db.execute(
        "INSERT INTO events(user_id,kind,channel_id,payload,created_at) VALUES(?,?,?,?,?)",
        params![user, kind, channel, payload.to_string(), now()],
    )?;
    Ok(())
}

fn display_name(db: &Connection, user: &str) -> Result<String, ApiError> {
    Ok(db.query_row(
        "SELECT COALESCE(NULLIF(TRIM(display_name),''),username) FROM users WHERE id=?",
        [user],
        |r| r.get(0),
    )?)
}

async fn ring(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(channel): Path<String>,
) -> ApiResult<Value> {
    let (callee, from_name) = {
        let db = s.db.lock().unwrap();
        let callee = other_member(&db, &p.user.id, &channel)?;
        {
            let mut rings = s.rings.lock().unwrap();
            let at = now();
            if rings.len() > 1024 {
                rings.retain(|_, last| at - *last < RING_WINDOW_MS);
            }
            let key = ring_key(&channel, &p.user.id);
            if rings
                .get(&key)
                .is_some_and(|last| at - *last < RING_WINDOW_MS)
            {
                return Err(ApiError(
                    StatusCode::TOO_MANY_REQUESTS,
                    "this person was just rung; wait a few seconds",
                ));
            }
            rings.insert(key, at);
        }
        let from_name = display_name(&db, &p.user.id)?;
        emit_to(
            &db,
            &callee,
            &channel,
            "call.ring",
            json!({"from":p.user.id,"from_name":from_name,"channel_id":channel}),
        )?;
        (callee, from_name)
    };
    // The phone ring must never delay or fail the in-app ring.
    if s.push.is_enabled() {
        let state = s.clone();
        tokio::spawn(async move {
            crate::push::send_voip_ring(&state, &callee, &channel, &from_name).await;
        });
    }
    Ok(Json(json!({"ringing":true})))
}

/// The callee declining, or the caller cancelling before anyone answered. The client tells
/// the two apart by which side it is on, so one event serves both.
async fn decline(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(channel): Path<String>,
) -> ApiResult<Value> {
    let db = s.db.lock().unwrap();
    let other = other_member(&db, &p.user.id, &channel)?;
    {
        // A decline or cancel ends the ring, so either side may ring again at once.
        let mut rings = s.rings.lock().unwrap();
        rings.remove(&ring_key(&channel, &p.user.id));
        rings.remove(&ring_key(&channel, &other));
    }
    emit_to(
        &db,
        &other,
        &channel,
        "call.declined",
        json!({"from":p.user.id,"channel_id":channel}),
    )?;
    Ok(Json(json!({"declined":true})))
}
