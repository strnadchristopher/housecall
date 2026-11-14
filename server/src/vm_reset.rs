//! Two-phase offline reset. Only the fixed private QEMU supervisor ever touches VM disks.
use crate::{activities, member, now, ApiError, ApiResult, AppState, Principal};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::get,
    Extension, Json, Router,
};
use housecall_activities::{Kind, Session};
use rusqlite::{params, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::{Duration, Instant};

pub fn routes() -> Router<AppState> {
    Router::new().route("/channels/{id}/vm/reset", get(status).post(reset))
}
pub fn init(db: &rusqlite::Connection) -> rusqlite::Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS vm_resets(operation TEXT PRIMARY KEY,channel_id TEXT NOT NULL,user_id TEXT NOT NULL,session_id TEXT NOT NULL,created_at INTEGER NOT NULL,outcome TEXT NOT NULL);")
}
async fn status(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(channel): Path<String>,
) -> ApiResult<Value> {
    let record: Option<(String, String, String)> = {
        let db = s.db.lock().unwrap();
        member(&db, &p.user.id, &channel)?;
        db.query_row("SELECT operation,outcome,session_id FROM vm_resets WHERE channel_id=?1 AND user_id=?2 ORDER BY created_at DESC,rowid DESC LIMIT 1", params![channel,p.user.id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?))).optional()?
    };
    let Some((operation, mut outcome, initiating_session)) = record else {
        return Ok(Json(json!({"outcome":"none"})));
    };
    #[cfg(unix)]
    if outcome == "pending" {
        if let Some(path) =
            s.vm.as_ref()
                .filter(|vm| vm.channel == channel)
                .and_then(|vm| vm.reset_socket.clone())
        {
            use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
            let query = async {
                let stream = tokio::net::UnixStream::connect(path).await.ok()?;
                if stream.peer_cred().ok()?.uid() != 47191 {
                    return None;
                }
                let mut stream = tokio::io::BufReader::new(stream);
                stream
                    .get_mut()
                    .write_all(
                        format!(
                            "{}\n",
                            json!({"operation":operation,"action":"reset_status"})
                        )
                        .as_bytes(),
                    )
                    .await
                    .ok()?;
                let mut line = Vec::new();
                loop {
                    let bytes = stream.fill_buf().await.ok()?;
                    if bytes.is_empty() {
                        return None;
                    }
                    let count = bytes
                        .iter()
                        .position(|b| *b == b'\n')
                        .map_or(bytes.len(), |i| i + 1);
                    if line.len() + count > 2048 {
                        return None;
                    }
                    line.extend_from_slice(&bytes[..count]);
                    stream.consume(count);
                    if line.last() == Some(&b'\n') {
                        break;
                    }
                }
                let value: Value = serde_json::from_slice(&line).ok()?;
                (value["operation"] == operation).then_some(value)
            };
            if let Ok(Some(value)) = tokio::time::timeout(Duration::from_secs(2), query).await {
                if let Some(found) = value["outcome"]
                    .as_str()
                    .filter(|value| ["reset", "rolled_back", "unknown", "pending"].contains(value))
                {
                    outcome = found.into();
                }
            }
        }
    }
    let db = s.db.lock().unwrap();
    member(&db, &p.user.id, &channel)?;
    let current: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sessions WHERE id=?1 AND user_id=?2 AND expires_at>?3)",
        params![p.session_id, p.user.id, now()],
        |row| row.get(0),
    )?;
    if !current {
        return Err(crate::unauthorized());
    }
    if ["reset", "rolled_back"].contains(&outcome.as_str()) {
        db.execute(
            "UPDATE vm_resets SET outcome=?1 WHERE operation=?2 AND user_id=?3",
            params![outcome, operation, p.user.id],
        )?;
    }
    Ok(Json(
        json!({"operation":operation,"outcome":outcome,"can_retry":outcome == "unknown" && initiating_session == p.session_id}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Reset {
    expected_revision: u64,
    operation: uuid::Uuid,
    confirmation: String,
}
fn unavailable() -> ApiError {
    ApiError(
        StatusCode::SERVICE_UNAVAILABLE,
        "VM reset unavailable; retry the same operation",
    )
}
fn authority(s: &AppState, p: &Principal, channel: &str, revision: u64) -> Result<(), ApiError> {
    let db = s.db.lock().unwrap();
    database_authority(&db, p, channel, revision)
}
fn database_authority(
    db: &rusqlite::Connection,
    p: &Principal,
    channel: &str,
    revision: u64,
) -> Result<(), ApiError> {
    member(db, &p.user.id, channel)?;
    let valid: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sessions WHERE id=?1 AND user_id=?2 AND expires_at>?3)",
        params![p.session_id, p.user.id, now()],
        |row| row.get(0),
    )?;
    if !valid {
        return Err(crate::unauthorized());
    }
    let encoded: String = db
        .query_row(
            "SELECT state FROM activities WHERE channel_id=?1",
            [channel],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(crate::missing)?;
    let session: Session = serde_json::from_str(&encoded).map_err(|_| unavailable())?;
    let snapshot = session
        .snapshot(&p.user.id, now().max(0) as u64)
        .map_err(|_| crate::forbidden())?;
    if snapshot.kind != Kind::Vm
        || snapshot.host != p.user.id
        || snapshot.revision != revision
        || !snapshot.controller.is_some_and(|lease| {
            lease.user_id == p.user.id && lease.expires_at_ms > now().max(0) as u64
        })
    {
        return Err(crate::forbidden());
    }
    Ok(())
}
async fn live_authority(
    s: &AppState,
    p: &Principal,
    channel: &str,
    revision: u64,
) -> Result<(), ApiError> {
    authority(s, p, channel, revision)?;
    if s.voice.is_none() {
        return Err(unavailable());
    }
    let snapshot = tokio::time::timeout(
        Duration::from_millis(750),
        activities::authorized_snapshot(s, p, channel),
    )
    .await
    .map_err(|_| unavailable())??;
    if snapshot.kind != Kind::Vm || snapshot.host != p.user.id || snapshot.revision != revision {
        return Err(crate::forbidden());
    }
    authority(s, p, channel, revision)
}
async fn reset(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(channel): Path<String>,
    Json(input): Json<Reset>,
) -> ApiResult<Value> {
    if input.confirmation != "discard_vm_changes" {
        return Err(crate::bad("confirm discarding VM changes"));
    }
    let gateway = s.vm.clone().ok_or_else(unavailable)?;
    if gateway.channel != channel {
        return Err(crate::forbidden());
    }
    let path = gateway.reset_socket.clone().ok_or_else(unavailable)?;
    let gate = s
        .vm_operations
        .clone()
        .try_lock_owned()
        .map_err(|_| ApiError(StatusCode::CONFLICT, "VM operation in progress"))?;
    live_authority(&s, &p, &channel, input.expected_revision).await?;
    {
        let db = s.db.lock().unwrap();
        db.execute(
            "INSERT OR IGNORE INTO vm_resets VALUES(?1,?2,?3,?4,?5,'pending')",
            params![
                input.operation.to_string(),
                channel,
                p.user.id,
                p.session_id,
                now()
            ],
        )?;
        let owned: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM vm_resets WHERE operation=?1 AND channel_id=?2 AND user_id=?3 AND session_id=?4)", params![input.operation.to_string(),channel,p.user.id,p.session_id], |row| row.get(0))?;
        if !owned {
            return Err(crate::forbidden());
        }
    }
    #[cfg(unix)]
    {
        let stream = tokio::time::timeout(
            Duration::from_millis(500),
            tokio::net::UnixStream::connect(path),
        )
        .await
        .map_err(|_| unavailable())?
        .map_err(|_| unavailable())?;
        if stream.peer_cred().map_err(|_| unavailable())?.uid() != 47191 {
            return Err(unavailable());
        }
        let stream = stream.into_std().map_err(|_| unavailable())?;
        stream.set_nonblocking(false).map_err(|_| unavailable())?;
        s.vm_media.invalidate(&channel);
        let runtime = tokio::runtime::Handle::current();
        // The owned gate lives in the blocking worker even if the requesting browser disconnects.
        tokio::task::spawn_blocking(move || {
            let _gate = gate;
            let result = transaction(stream, input.operation, |commit| {
                runtime.block_on(live_authority(&s, &p, &channel, input.expected_revision))?;
                let db = s.db.lock().unwrap();
                database_authority(&db, &p, &channel, input.expected_revision)?;
                // Revocation/membership/activity writes cannot interleave with this bounded commit write.
                commit()
            })?;
            s.db.lock().unwrap().execute(
                "UPDATE vm_resets SET outcome=?1 WHERE operation=?2 AND session_id=?3",
                params![
                    result["outcome"].as_str().unwrap_or("pending"),
                    input.operation.to_string(),
                    p.session_id
                ],
            )?;
            Ok(Json(result))
        })
        .await
        .map_err(|_| unavailable())?
    }
    #[cfg(not(unix))]
    {
        let _ = (path, gate);
        Err(unavailable())
    }
}

#[cfg(unix)]
fn transaction(
    stream: std::os::unix::net::UnixStream,
    operation: uuid::Uuid,
    recheck: impl FnOnce(&mut dyn FnMut() -> Result<(), ApiError>) -> Result<(), ApiError>,
) -> Result<Value, ApiError> {
    use std::io::{BufRead, Write};
    let deadline = Instant::now() + Duration::from_secs(125);
    let mut io = std::io::BufReader::new(stream);
    fn send(
        io: &mut std::io::BufReader<std::os::unix::net::UnixStream>,
        value: Value,
    ) -> Result<(), ApiError> {
        io.get_ref()
            .set_write_timeout(Some(Duration::from_millis(500)))
            .map_err(|_| unavailable())?;
        writeln!(io.get_mut(), "{value}").map_err(|_| unavailable())
    }
    fn read(
        io: &mut std::io::BufReader<std::os::unix::net::UnixStream>,
        deadline: Instant,
    ) -> Result<Value, ApiError> {
        let mut line = Vec::new();
        loop {
            io.get_ref()
                .set_read_timeout(Some(
                    deadline
                        .checked_duration_since(Instant::now())
                        .ok_or_else(unavailable)?,
                ))
                .map_err(|_| unavailable())?;
            let bytes = io.fill_buf().map_err(|_| unavailable())?;
            if bytes.is_empty() {
                return Err(unavailable());
            }
            let count = bytes
                .iter()
                .position(|b| *b == b'\n')
                .map_or(bytes.len(), |i| i + 1);
            if line.len() + count > 2048 {
                return Err(unavailable());
            }
            line.extend_from_slice(&bytes[..count]);
            io.consume(count);
            if line.last() == Some(&b'\n') {
                return serde_json::from_slice(&line).map_err(|_| unavailable());
            }
        }
    }
    send(
        &mut io,
        json!({"operation":operation,"action":"prepare_reset"}),
    )?;
    let mut result = read(&mut io, deadline)?;
    if result["operation"] != operation.to_string() {
        return Err(unavailable());
    }
    if result["phase"] == "prepared" {
        // Dropping the connection on failed authorization causes offline rollback and restart.
        recheck(&mut || {
            send(
                &mut io,
                json!({"operation":operation,"action":"commit_reset"}),
            )
        })?;
        result = read(&mut io, deadline)?;
    }
    if result["operation"] != operation.to_string()
        || !["reset", "rolled_back"]
            .iter()
            .any(|outcome| result["outcome"] == *outcome)
    {
        return Err(unavailable());
    }
    Ok(result)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::io::{BufRead, Write};
    fn fixture() -> (AppState, Principal) {
        let mut state = AppState::new(":memory:", "fixture").unwrap();
        state.vm = Some(std::sync::Arc::new(crate::vm::Gateway {
            socket: "/unused/qmp.sock".into(),
            channel: "room".into(),
            reset_socket: Some("/unused/supervisor.sock".into()),
        }));
        let principal = Principal {
            user: crate::User {
                id: "host".into(),
                username: "host".into(),
                is_owner: true,
            },
            session_id: "host".into(),
        };
        let mut activity = Session::new(
            Kind::Vm,
            "host".into(),
            ["host".into(), "viewer".into()].into(),
            now() as u64,
        )
        .unwrap();
        activity
            .apply(
                "host",
                0,
                housecall_activities::Command::RequestControl {},
                now() as u64,
            )
            .unwrap();
        {
            let db = state.db.lock().unwrap();
            db.execute(
                "INSERT INTO channels(id,name,kind) VALUES('room','fixture','voice')",
                [],
            )
            .unwrap();
            for (name, token, joined) in [
                ("host", 'a', true),
                ("viewer", 'b', true),
                ("outsider", 'c', false),
            ] {
                db.execute(
                    "INSERT INTO users(id,username,password,is_owner) VALUES(?1,?1,'unused',0)",
                    [name],
                )
                .unwrap();
                db.execute(
                    "INSERT INTO sessions(id,user_id,token_hash,device_hash,device_name,created_at,expires_at) VALUES(?1,?1,?2,?3,'fixture',0,?4)",
                    params![
                        name,
                        crate::hash(&token.to_string().repeat(64)),
                        crate::hash(&"e".repeat(64)),
                        now() + 60000
                    ],
                )
                .unwrap();
                if joined {
                    db.execute("INSERT INTO members VALUES('room',?1)", [name])
                        .unwrap();
                }
            }
            db.execute(
                "INSERT INTO activities VALUES('room',?1)",
                [serde_json::to_string(&activity).unwrap()],
            )
            .unwrap();
        }
        (state, principal)
    }
    #[test]
    fn reset_authority_requires_current_host_lease_revision_membership_and_session() {
        let (state, mut principal) = fixture();
        assert!(authority(&state, &principal, "room", 1).is_ok());
        assert!(authority(&state, &principal, "room", 0).is_err());
        principal.user.id = "viewer".into();
        principal.session_id = "viewer".into();
        assert_eq!(
            authority(&state, &principal, "room", 1).unwrap_err().0,
            StatusCode::FORBIDDEN
        );
        principal.user.id = "host".into();
        principal.session_id = "host".into();
        state
            .db
            .lock()
            .unwrap()
            .execute("DELETE FROM sessions WHERE id='host'", [])
            .unwrap();
        assert_eq!(
            authority(&state, &principal, "room", 1).unwrap_err().0,
            StatusCode::UNAUTHORIZED
        );
    }
    #[tokio::test]
    async fn actual_reset_route_rejects_unauthenticated_outsider_viewer_stale_and_missing_confirmation(
    ) {
        use axum::{body::Body, http::Request};
        use tower::ServiceExt;
        let (state, _) = fixture();
        for (token, revision, confirmation, expected) in [
            (None, 1, "discard_vm_changes", StatusCode::UNAUTHORIZED),
            (Some('c'), 1, "discard_vm_changes", StatusCode::FORBIDDEN),
            (Some('b'), 1, "discard_vm_changes", StatusCode::FORBIDDEN),
            (Some('a'), 0, "discard_vm_changes", StatusCode::FORBIDDEN),
            (Some('a'), 1, "", StatusCode::BAD_REQUEST),
            (
                Some('a'),
                1,
                "discard_vm_changes",
                StatusCode::SERVICE_UNAVAILABLE,
            ),
        ] {
            let mut req = Request::builder()
                .method("POST")
                .uri("/api/channels/room/vm/reset")
                .header("content-type", "application/json");
            if let Some(token) = token {
                req = req
                    .header(
                        "authorization",
                        format!("Bearer {}", token.to_string().repeat(64)),
                    )
                    .header("x-device-key", "e".repeat(64));
            }
            let body = json!({"operation":uuid::Uuid::new_v4(),"expected_revision":revision,"confirmation":confirmation});
            let response = crate::app(state.clone(), None)
                .oneshot(req.body(Body::from(body.to_string())).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), expected);
        }
    }
    #[tokio::test]
    async fn discovery_survives_new_session_but_is_scoped_to_initiator_and_membership() {
        use axum::{body::Body, http::Request};
        use http_body_util::BodyExt;
        use tower::ServiceExt;
        let (state, _) = fixture();
        let operation = uuid::Uuid::new_v4().to_string();
        {
            let db = state.db.lock().unwrap();
            db.execute(
                "INSERT INTO vm_resets VALUES(?1,'room','host','old-session',?2,'reset')",
                params![operation, now()],
            )
            .unwrap();
        }
        for (token, expected, outcome) in [
            (None, StatusCode::UNAUTHORIZED, None),
            (Some('c'), StatusCode::FORBIDDEN, None),
            (Some('b'), StatusCode::OK, Some("none")),
            (Some('a'), StatusCode::OK, Some("reset")),
        ] {
            let mut request = Request::builder().uri("/api/channels/room/vm/reset");
            if let Some(token) = token {
                request = request
                    .header(
                        "authorization",
                        format!("Bearer {}", token.to_string().repeat(64)),
                    )
                    .header("x-device-key", "e".repeat(64));
            }
            let response = crate::app(state.clone(), None)
                .oneshot(request.body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), expected);
            if let Some(outcome) = outcome {
                let bytes = response.into_body().collect().await.unwrap().to_bytes();
                let body: Value = serde_json::from_slice(&bytes).unwrap();
                assert_eq!(body["outcome"], outcome);
                if outcome == "none" {
                    assert!(body.get("operation").is_none());
                } else {
                    assert_eq!(body["operation"], operation);
                }
            }
        }
    }
    #[test]
    fn prepared_reset_requires_fresh_authority_and_rejects_cross_operation_reply() {
        for (revoked, wrong_operation) in [(false, false), (true, false), (false, true)] {
            let (client, server) = std::os::unix::net::UnixStream::pair().unwrap();
            let operation = uuid::Uuid::new_v4();
            let worker = std::thread::spawn(move || {
                let mut peer = std::io::BufReader::new(server);
                let mut line = String::new();
                peer.read_line(&mut line).unwrap();
                assert_eq!(
                    serde_json::from_str::<Value>(&line).unwrap()["action"],
                    "prepare_reset"
                );
                writeln!(peer.get_mut(), "{}", json!({"operation":if wrong_operation { uuid::Uuid::new_v4() } else { operation }, "phase":"prepared"})).unwrap();
                line.clear();
                peer.read_line(&mut line).unwrap();
                if revoked || wrong_operation {
                    assert!(line.is_empty());
                } else {
                    assert_eq!(
                        serde_json::from_str::<Value>(&line).unwrap()["action"],
                        "commit_reset"
                    );
                    writeln!(
                        peer.get_mut(),
                        "{}",
                        json!({"operation":operation,"outcome":"reset"})
                    )
                    .unwrap();
                }
            });
            let result = transaction(client, operation, |commit| {
                if revoked {
                    Err(crate::unauthorized())
                } else {
                    commit()
                }
            });
            assert_eq!(result.is_ok(), !revoked && !wrong_operation);
            worker.join().unwrap();
        }
    }
}
