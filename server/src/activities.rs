//! Channel-scoped activity state. Voice transport and provider playback remain separate capabilities.
use crate::{emit, member, now, ApiError, ApiResult, AppState, Principal};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::{get, post},
    Extension, Json, Router,
};
use chriscord_activities::{Command, Kind, Session};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeSet;

/// Recheck channel and connected voice membership before provider operations; no DB lock crosses await.
pub async fn authorized_snapshot(
    s: &AppState,
    p: &Principal,
    channel: &str,
) -> Result<chriscord_activities::Snapshot, ApiError> {
    let active = active_roster(s, p, channel).await?;
    let db = s.db.lock().unwrap();
    member(&db, &p.user.id, channel)?;
    let at = now().max(0) as u64;
    load(&db, channel, at, active)?
        .snapshot(&p.user.id, at)
        .map_err(domain)
}

pub fn init(db: &Connection) -> rusqlite::Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS activities(channel_id TEXT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,state TEXT NOT NULL);")
}
pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/channels/{id}/activity",
            get(snapshot).post(start).delete(stop),
        )
        .route("/channels/{id}/activity/commands", post(command))
}
fn domain(e: chriscord_activities::Error) -> ApiError {
    use chriscord_activities::Error::*;
    match e {
        Forbidden => ApiError(StatusCode::FORBIDDEN, "activity permission denied"),
        Conflict => ApiError(
            StatusCode::CONFLICT,
            "stale activity revision; refresh snapshot",
        ),
        Invalid(reason) => ApiError(StatusCode::BAD_REQUEST, reason),
        Provider | Process => ApiError(StatusCode::BAD_GATEWAY, "activity provider unavailable"),
    }
}
fn roster(db: &Connection, channel: &str) -> Result<BTreeSet<String>, ApiError> {
    let mut q = db.prepare("SELECT user_id FROM members WHERE channel_id=?1 ORDER BY user_id")?;
    let rows = q
        .query_map([channel], |r| r.get(0))?
        .collect::<rusqlite::Result<BTreeSet<String>>>()?;
    Ok(rows)
}
async fn active_roster(
    s: &AppState,
    p: &Principal,
    channel: &str,
) -> Result<Option<BTreeSet<String>>, ApiError> {
    {
        let db = s.db.lock().unwrap();
        member(&db, &p.user.id, channel)?;
    }
    let Some(voice) = &s.voice else {
        return Ok(None);
    };
    let peers = voice
        .stats(channel.to_owned(), p.session_id.clone())
        .await
        .map_err(|_| ApiError(StatusCode::FORBIDDEN, "join voice before using an activity"))?;
    let members: BTreeSet<String> = peers
        .into_iter()
        .filter(|peer| peer.connected)
        .map(|peer| peer.user_id)
        .collect();
    if !members.contains(&p.user.id) {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "voice transport is not connected",
        ));
    }
    Ok(Some(members))
}
fn load(
    db: &Connection,
    channel: &str,
    at: u64,
    active: Option<BTreeSet<String>>,
) -> Result<Session, ApiError> {
    let encoded: String = db
        .query_row(
            "SELECT state FROM activities WHERE channel_id=?1",
            [channel],
            |r| r.get(0),
        )
        .optional()?
        .ok_or(ApiError(StatusCode::NOT_FOUND, "no activity in channel"))?;
    let mut session: Session = serde_json::from_str(&encoded).map_err(|_| {
        ApiError(
            StatusCode::INTERNAL_SERVER_ERROR,
            "invalid activity storage",
        )
    })?;
    session
        .replace_members(
            match active {
                Some(members) => members,
                None => roster(db, channel)?,
            },
            at,
        )
        .map_err(domain)?;
    session.tick(at);
    Ok(session)
}
fn save(
    db: &Connection,
    channel: &str,
    session: &Session,
    actor: &str,
    at: u64,
) -> ApiResult<Value> {
    let encoded = serde_json::to_string(session).map_err(|_| {
        ApiError(
            StatusCode::INTERNAL_SERVER_ERROR,
            "activity serialization failed",
        )
    })?;
    db.execute("INSERT INTO activities(channel_id,state) VALUES(?1,?2) ON CONFLICT(channel_id) DO UPDATE SET state=excluded.state", params![channel, encoded])?;
    let snapshot =
        serde_json::to_value(session.snapshot(actor, at).map_err(domain)?).map_err(|_| {
            ApiError(
                StatusCode::INTERNAL_SERVER_ERROR,
                "activity serialization failed",
            )
        })?;
    emit(db, channel, "activity.updated", snapshot.clone())?;
    Ok(Json(snapshot))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Start {
    kind: Kind,
}
async fn start(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(channel): Path<String>,
    Json(input): Json<Start>,
) -> ApiResult<Value> {
    let active = active_roster(&s, &p, &channel).await?;
    let mut db = s.db.lock().unwrap();
    let tx = db.transaction()?;
    member(&tx, &p.user.id, &channel)?;
    if tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM activities WHERE channel_id=?1)",
        [&channel],
        |r| r.get::<_, bool>(0),
    )? {
        return Err(ApiError(StatusCode::CONFLICT, "activity already running"));
    }
    let at = now().max(0) as u64;
    let session = Session::new(
        input.kind,
        p.user.id.clone(),
        match active {
            Some(members) => members,
            None => roster(&tx, &channel)?,
        },
        at,
    )
    .map_err(domain)?;
    let response = save(&tx, &channel, &session, &p.user.id, at)?;
    tx.commit()?;
    Ok(response)
}
async fn snapshot(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(channel): Path<String>,
) -> ApiResult<Value> {
    let active = active_roster(&s, &p, &channel).await?;
    let mut db = s.db.lock().unwrap();
    let tx = db.transaction()?;
    member(&tx, &p.user.id, &channel)?;
    let at = now().max(0) as u64;
    let before: String = tx
        .query_row(
            "SELECT state FROM activities WHERE channel_id=?1",
            [&channel],
            |r| r.get(0),
        )
        .optional()?
        .ok_or(ApiError(StatusCode::NOT_FOUND, "no activity in channel"))?;
    let session = load(&tx, &channel, at, active)?;
    let encoded = serde_json::to_string(&session).map_err(|_| {
        ApiError(
            StatusCode::INTERNAL_SERVER_ERROR,
            "activity serialization failed",
        )
    })?;
    let response = if encoded != before {
        save(&tx, &channel, &session, &p.user.id, at)?
    } else {
        Json(json!(session.snapshot(&p.user.id, at).map_err(domain)?))
    };
    tx.commit()?;
    Ok(response)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ActivityCommand {
    expected_revision: u64,
    command: Command,
}
async fn command(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(channel): Path<String>,
    Json(input): Json<ActivityCommand>,
) -> ApiResult<Value> {
    let active = active_roster(&s, &p, &channel).await?;
    let mut db = s.db.lock().unwrap();
    let tx = db.transaction()?;
    member(&tx, &p.user.id, &channel)?;
    let at = now().max(0) as u64;
    let mut session = load(&tx, &channel, at, active)?;
    if s.dj.is_some() && matches!(input.command, Command::Enqueue { .. }) {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "use DJ queue preparation",
        ));
    }
    session
        .apply(&p.user.id, input.expected_revision, input.command, at)
        .map_err(domain)?;
    let response = save(&tx, &channel, &session, &p.user.id, at)?;
    tx.commit()?;
    Ok(response)
}
async fn stop(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(channel): Path<String>,
) -> ApiResult<Value> {
    let active = active_roster(&s, &p, &channel).await?;
    let mut db = s.db.lock().unwrap();
    let tx = db.transaction()?;
    member(&tx, &p.user.id, &channel)?;
    let at = now().max(0) as u64;
    let session = load(&tx, &channel, at, active)?;
    if session.snapshot(&p.user.id, at).map_err(domain)?.host != p.user.id {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "only activity host can stop",
        ));
    }
    tx.execute("DELETE FROM activities WHERE channel_id=?1", [&channel])?;
    emit(
        &tx,
        &channel,
        "activity.stopped",
        json!({"channel_id":channel}),
    )?;
    tx.commit()?;
    drop(db);
    if let Some(gateway) = &s.plex {
        gateway.stop_channel(&channel);
    }
    if let Some(player) = &s.dj {
        player.stop_channel(&channel);
    }
    Ok(Json(json!({"stopped":true})))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;
    use std::sync::Arc;
    use tower::ServiceExt;
    fn state() -> AppState {
        let state = AppState::new(":memory:", "fixture-setup").unwrap();
        let db = state.db.lock().unwrap();
        init(&db).unwrap();
        db.execute(
            "INSERT INTO channels(id,name,kind) VALUES('room','Fixture','voice')",
            [],
        )
        .unwrap();
        for (name, c, joins) in [
            ("alice", 'a', true),
            ("bob", 'b', true),
            ("cara", 'c', true),
            ("outside", 'd', false),
        ] {
            db.execute(
                "INSERT INTO users(id,username,password,is_owner) VALUES(?1,?1,'unused',0)",
                [name],
            )
            .unwrap();
            let token = c.to_string().repeat(64);
            db.execute("INSERT INTO sessions(id,user_id,token_hash,device_hash,device_name,created_at,expires_at) VALUES(?1,?1,?2,?3,'fixture',?4,?5)", params![name, crate::hash(&token), crate::hash(&"e".repeat(64)), now(), now()+60_000]).unwrap();
            if joins {
                db.execute(
                    "INSERT INTO members(channel_id,user_id) VALUES('room',?1)",
                    [name],
                )
                .unwrap();
            }
        }
        drop(db);
        state
    }
    async fn call(
        state: &AppState,
        user: Option<char>,
        method: &str,
        path: &str,
        body: Value,
    ) -> (StatusCode, Value) {
        let mut req = Request::builder()
            .method(method)
            .uri(path)
            .header("content-type", "application/json");
        if let Some(user) = user {
            req = req
                .header(
                    "authorization",
                    format!("Bearer {}", user.to_string().repeat(64)),
                )
                .header("x-device-key", "e".repeat(64));
        }
        let response = crate::app(state.clone(), None)
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
    async fn all_activity_routes_require_authentication_and_channel_membership() {
        let state = state();
        for (method, path, body) in [
            ("GET", "/api/channels/room/activity", json!(null)),
            (
                "POST",
                "/api/channels/room/activity",
                json!({"kind":"plex"}),
            ),
            ("DELETE", "/api/channels/room/activity", json!(null)),
            (
                "POST",
                "/api/channels/room/activity/commands",
                json!({"expected_revision":0,"command":{"type":"play"}}),
            ),
            (
                "POST",
                "/api/channels/room/gimme/requests",
                json!({"request":{"media":"movie","query":"Fixture"},"idempotency_key":"fixture-1"}),
            ),
        ] {
            assert_eq!(
                call(&state, None, method, path, body.clone()).await.0,
                StatusCode::UNAUTHORIZED,
                "anonymous {method} {path}"
            );
            assert_eq!(
                call(&state, Some('d'), method, path, body).await.0,
                StatusCode::FORBIDDEN,
                "outsider {method} {path}"
            );
        }
    }
    #[tokio::test]
    async fn three_clients_share_persisted_activity_and_enforce_revision_and_host() {
        let state = state();
        let path = "/api/channels/room/activity";
        assert_eq!(
            call(&state, Some('a'), "POST", path, json!({"kind":"plex"}))
                .await
                .0,
            StatusCode::OK
        );
        assert_eq!(
            call(&state, Some('b'), "POST", path, json!({"kind":"dj"}))
                .await
                .0,
            StatusCode::CONFLICT
        );
        let command = format!("{path}/commands");
        let select = json!({"expected_revision":0,"command":{"type":"select","media_id":"42","duration_ms":100000}});
        assert_eq!(
            call(&state, Some('b'), "POST", &command, select.clone())
                .await
                .0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            call(&state, Some('a'), "POST", &command, select.clone())
                .await
                .0,
            StatusCode::OK
        );
        assert_eq!(
            call(&state, Some('a'), "POST", &command, select).await.0,
            StatusCode::CONFLICT
        );
        for user in ['a', 'b', 'c'] {
            let (status, snapshot) = call(&state, Some(user), "GET", path, json!(null)).await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(snapshot["revision"], 1);
            assert_eq!(snapshot["playback"]["media_id"], "42");
        }
        assert_eq!(
            call(&state, Some('b'), "DELETE", path, json!(null)).await.0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            call(&state, Some('a'), "DELETE", path, json!(null)).await.0,
            StatusCode::OK
        );
        assert_eq!(
            call(&state, Some('c'), "GET", path, json!(null)).await.0,
            StatusCode::NOT_FOUND
        );
        let db = state.db.lock().unwrap();
        let events: i64 = db
            .query_row(
                "SELECT count(*) FROM events WHERE kind LIKE 'activity.%'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            events, 9,
            "start, select, stop events each delivered to all three members"
        );
    }
    #[tokio::test]
    async fn removed_channel_member_loses_activity_access_and_gimme_is_dry_run() {
        let state = state();
        call(
            &state,
            Some('a'),
            "POST",
            "/api/channels/room/activity",
            json!({"kind":"vm"}),
        )
        .await;
        state
            .db
            .lock()
            .unwrap()
            .execute("DELETE FROM members WHERE user_id='bob'", [])
            .unwrap();
        assert_eq!(
            call(
                &state,
                Some('b'),
                "GET",
                "/api/channels/room/activity",
                json!(null)
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
        let (status, body) = call(&state, Some('a'), "POST", "/api/channels/room/gimme/requests", json!({"request":{"media":"movie","query":"Fixture title"},"idempotency_key":"fixture-1"})).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["dry_run"], true);
        assert_eq!(body["provider_verified"], false);
        assert_eq!(body["operation"]["state"], "dry_run");
    }
    #[tokio::test]
    async fn configured_voice_requires_connected_session_for_activity_routes() {
        let mut state = state();
        state.voice = Some(Arc::new(
            chriscord_sfu::Sfu::start(
                "127.0.0.1:0".parse().unwrap(),
                "127.0.0.1".parse().unwrap(),
                Arc::new(|_, _, _| true),
            )
            .unwrap(),
        ));
        for (method, path, body) in [
            ("GET", "/api/channels/room/activity", json!(null)),
            (
                "POST",
                "/api/channels/room/activity",
                json!({"kind":"plex"}),
            ),
            ("DELETE", "/api/channels/room/activity", json!(null)),
            (
                "POST",
                "/api/channels/room/activity/commands",
                json!({"expected_revision":0,"command":{"type":"play"}}),
            ),
        ] {
            assert_eq!(
                call(&state, Some('a'), method, path, body).await.0,
                StatusCode::FORBIDDEN
            );
        }
    }
}
