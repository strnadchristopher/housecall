//! Authenticated VM input. QMP remains a private Unix socket; no caller chooses commands/paths.
use crate::{activities, member, now, ApiError, ApiResult, AppState, Principal};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::post,
    Extension, Json, Router,
};
use chriscord_activities::{Kind, Session};
use rusqlite::{params, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{path::PathBuf, sync::Arc};

pub struct Gateway {
    pub(crate) socket: PathBuf,
    pub(crate) channel: String,
    pub(crate) reset_socket: Option<PathBuf>,
}
pub fn configure(state: &mut AppState) -> Result<(), String> {
    match (
        std::env::var("CHRISCORD_VM_QMP_SOCKET").ok(),
        std::env::var("CHRISCORD_VM_CHANNEL_ID").ok(),
    ) {
        (None, None) => Ok(()),
        (Some(socket), Some(channel)) if cfg!(unix) => {
            let socket = PathBuf::from(socket);
            if !socket.is_absolute() || channel.is_empty() || channel.len() > 128 {
                return Err(
                    "VM input requires an absolute Unix socket and a configured channel".into(),
                );
            }
            let reset_socket = std::env::var("CHRISCORD_VM_SUPERVISOR_SOCKET")
                .ok()
                .map(PathBuf::from);
            if reset_socket
                .as_ref()
                .is_some_and(|path| !path.is_absolute())
            {
                return Err("VM supervisor requires an absolute private Unix socket".into());
            }
            state.vm = Some(Arc::new(Gateway {
                socket,
                channel,
                reset_socket,
            }));
            Ok(())
        }
        _ => Err(
            "Set both CHRISCORD_VM_QMP_SOCKET and CHRISCORD_VM_CHANNEL_ID on Unix, or neither"
                .into(),
        ),
    }
}
pub fn routes() -> Router<AppState> {
    Router::new().route("/channels/{id}/vm/input", post(input))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    expected_revision: u64,
    event: Event,
}
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum Event {
    Key { key: String },
    Pointer { x: u16, y: u16 },
    Click { button: String },
}
impl Event {
    fn events(&self) -> Result<Value, ApiError> {
        match self {
            Self::Key { key } => {
                // Each operation pairs down/up: a disconnect cannot leave a held modifier.
                if !(key.len() == 1
                    && key
                        .bytes()
                        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()))
                    && ![
                        "spc",
                        "ret",
                        "backspace",
                        "tab",
                        "esc",
                        "up",
                        "down",
                        "left",
                        "right",
                        "home",
                        "end",
                        "pgup",
                        "pgdn",
                        "delete",
                        "slash",
                        "dot",
                        "minus",
                        "equal",
                    ]
                    .contains(&key.as_str())
                {
                    return Err(crate::bad("unsupported VM key"));
                }
                Ok(
                    json!([{"type":"key","data":{"down":true,"key":{"type":"qcode","data":key}}},
                    {"type":"key","data":{"down":false,"key":{"type":"qcode","data":key}}}]),
                )
            }
            Self::Pointer { x, y } if *x <= 32767 && *y <= 32767 => Ok(json!([
                {"type":"abs","data":{"axis":"x","value":x}},
                {"type":"abs","data":{"axis":"y","value":y}}])),
            Self::Click { button }
                if ["left", "middle", "right", "wheel-up", "wheel-down"]
                    .contains(&button.as_str()) =>
            {
                Ok(json!([
                {"type":"btn","data":{"down":true,"button":button}},
                {"type":"btn","data":{"down":false,"button":button}}]))
            }
            _ => Err(crate::bad("invalid VM pointer input")),
        }
    }
}
fn unavailable() -> ApiError {
    ApiError(StatusCode::SERVICE_UNAVAILABLE, "VM input unavailable")
}

async fn input(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(channel): Path<String>,
    Json(input): Json<Input>,
) -> ApiResult<Value> {
    let gateway = state.vm.clone().ok_or_else(unavailable)?;
    if state.voice.is_none() {
        return Err(unavailable());
    }
    if gateway.channel != channel {
        return Err(crate::forbidden());
    }
    // No unbounded input queue. Handoff/release/stop use the same gate.
    let gate = state.vm_operations.clone().try_lock_owned().map_err(|_| {
        ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            "VM input busy; retry current state",
        )
    })?;
    let snapshot = activities::authorized_snapshot(&state, &principal, &channel).await?;
    if snapshot.kind != Kind::Vm
        || snapshot.revision != input.expected_revision
        || !snapshot.controller.is_some_and(|lease| {
            lease.user_id == principal.user.id && lease.expires_at_ms > now().max(0) as u64
        })
    {
        return Err(crate::forbidden());
    }
    let events = input.event.events()?;
    #[cfg(unix)]
    {
        let socket = tokio::time::timeout(
            std::time::Duration::from_millis(500),
            tokio::net::UnixStream::connect(&gateway.socket),
        )
        .await
        .map_err(|_| unavailable())?
        .map_err(|_| unavailable())?
        .into_std()
        .map_err(|_| unavailable())?;
        socket.set_nonblocking(false).map_err(|_| unavailable())?;
        let runtime = tokio::runtime::Handle::current();
        tokio::task::spawn_blocking(move || {
            let _gate = gate;
            dispatch(
                &state,
                &principal,
                &channel,
                input.expected_revision,
                events,
                socket,
                || {
                    runtime.block_on(async {
                        tokio::time::timeout(
                            std::time::Duration::from_millis(500),
                            activities::active_roster(&state, &principal, &channel),
                        )
                        .await
                        .map_err(|_| unavailable())??
                        .ok_or_else(unavailable)?;
                        Ok(())
                    })
                },
            )
        })
        .await
        .map_err(|_| unavailable())?
    }
    #[cfg(not(unix))]
    {
        let _ = (gate, events);
        Err(unavailable())
    }
}

#[cfg(unix)]
fn dispatch(
    state: &AppState,
    principal: &Principal,
    channel: &str,
    revision: u64,
    events: Value,
    socket: std::os::unix::net::UnixStream,
    recheck_voice: impl FnOnce() -> Result<(), ApiError>,
) -> ApiResult<Value> {
    let mut qmp = Qmp::connect(socket)?;
    recheck_voice()?;
    // Recheck after connection/handshake: a queued request must not survive revocation,
    // lease expiry, or activity replacement. Hold DB only across the bounded local write.
    let db = state.db.lock().unwrap();
    member(&db, &principal.user.id, channel)?;
    let valid: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sessions WHERE id=?1 AND user_id=?2 AND expires_at>?3)",
        params![principal.session_id, principal.user.id, now()],
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
        .snapshot(&principal.user.id, now().max(0) as u64)
        .map_err(|_| crate::forbidden())?;
    if snapshot.kind != Kind::Vm
        || snapshot.revision != revision
        || !snapshot.controller.is_some_and(|lease| {
            lease.user_id == principal.user.id && lease.expires_at_ms > now().max(0) as u64
        })
    {
        return Err(crate::forbidden());
    }
    qmp.send("input-send-event", json!({"events":events}), 2)?;
    drop(db);
    qmp.reply(2)?;
    Ok(Json(json!({"accepted":true,"revision":revision})))
}

#[cfg(unix)]
struct Qmp {
    io: std::io::BufReader<std::os::unix::net::UnixStream>,
    deadline: std::time::Instant,
}
#[cfg(unix)]
impl Qmp {
    fn connect(stream: std::os::unix::net::UnixStream) -> Result<Self, ApiError> {
        Self::connect_before(
            stream,
            std::time::Instant::now() + std::time::Duration::from_secs(2),
        )
    }
    fn connect_before(
        stream: std::os::unix::net::UnixStream,
        deadline: std::time::Instant,
    ) -> Result<Self, ApiError> {
        let mut qmp = Self {
            io: std::io::BufReader::new(stream),
            deadline,
        };
        if qmp.read()?.get("QMP").is_none() {
            return Err(unavailable());
        }
        qmp.send("qmp_capabilities", json!({}), 1)?;
        qmp.reply(1)?;
        Ok(qmp)
    }
    fn remaining(&self) -> Result<std::time::Duration, ApiError> {
        self.deadline
            .checked_duration_since(std::time::Instant::now())
            .filter(|remaining| !remaining.is_zero())
            .ok_or_else(unavailable)
    }
    fn read(&mut self) -> Result<Value, ApiError> {
        use std::io::BufRead;
        let mut line = Vec::new();
        loop {
            self.io
                .get_ref()
                .set_read_timeout(Some(
                    self.remaining()?.min(std::time::Duration::from_millis(500)),
                ))
                .map_err(|_| unavailable())?;
            let available = self.io.fill_buf().map_err(|_| unavailable())?;
            if available.is_empty() {
                return Err(unavailable());
            }
            let count = available
                .iter()
                .position(|b| *b == b'\n')
                .map_or(available.len(), |n| n + 1);
            if line.len() + count > 65536 {
                return Err(unavailable());
            }
            line.extend_from_slice(&available[..count]);
            self.io.consume(count);
            if line.last() == Some(&b'\n') {
                break;
            }
        }
        serde_json::from_slice(&line).map_err(|_| unavailable())
    }
    fn send(&mut self, command: &str, arguments: Value, id: u8) -> Result<(), ApiError> {
        use std::io::Write;
        let mut encoded =
            serde_json::to_vec(&json!({"execute":command,"arguments":arguments,"id":id}))
                .map_err(|_| unavailable())?;
        encoded.push(b'\n');
        let mut written = 0;
        while written < encoded.len() {
            self.io
                .get_ref()
                .set_write_timeout(Some(
                    self.remaining()?.min(std::time::Duration::from_millis(250)),
                ))
                .map_err(|_| unavailable())?;
            let count = self
                .io
                .get_mut()
                .write(&encoded[written..])
                .map_err(|_| unavailable())?;
            if count == 0 {
                return Err(unavailable());
            }
            written += count;
        }
        Ok(())
    }
    fn reply(&mut self, id: u8) -> Result<Value, ApiError> {
        for _ in 0..8 {
            let value = self.read()?;
            if value.get("event").is_some() {
                continue;
            }
            if value["id"] != id || value.get("error").is_some() {
                return Err(unavailable());
            }
            return value.get("return").cloned().ok_or_else(unavailable);
        }
        Err(unavailable())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    #[test]
    fn qmp_dispatch_rechecks_revocation_after_handshake() {
        use std::io::{BufRead, Write};
        use std::os::unix::net::UnixStream;
        for revocation in ["none", "session", "voice"] {
            let revoke_during_handshake = revocation != "none";
            let connected = Arc::new(std::sync::atomic::AtomicBool::new(true));
            let state = AppState::new(":memory:", "fixture").unwrap();
            let principal = Principal {
                user: crate::User {
                    id: "controller".into(),
                    username: "fixture".into(),
                    is_owner: true,
                },
                session_id: "session".into(),
            };
            let mut activity = Session::new(
                Kind::Vm,
                "controller".into(),
                ["controller".into()].into(),
                now() as u64,
            )
            .unwrap();
            activity
                .apply(
                    "controller",
                    0,
                    chriscord_activities::Command::RequestControl {},
                    now() as u64,
                )
                .unwrap();
            {
                let db = state.db.lock().unwrap();
                db.execute(
                    "INSERT INTO users(id,username,password,is_owner) VALUES('controller','fixture','unused',1)",
                    [],
                )
                .unwrap();
                db.execute("INSERT INTO sessions VALUES('session','controller','synthetic','synthetic','fixture',0,?1)", [now()+60000]).unwrap();
                db.execute(
                    "INSERT INTO channels(id,name,kind) VALUES('vm-channel','fixture','channel')",
                    [],
                )
                .unwrap();
                db.execute("INSERT INTO members VALUES('vm-channel','controller')", [])
                    .unwrap();
                db.execute(
                    "INSERT INTO activities VALUES('vm-channel',?1)",
                    [serde_json::to_string(&activity).unwrap()],
                )
                .unwrap();
            }
            let (client, server) = UnixStream::pair().unwrap();
            let fixture_state = state.clone();
            let fixture_connected = connected.clone();
            let thread = std::thread::spawn(move || {
                server
                    .set_read_timeout(Some(std::time::Duration::from_secs(2)))
                    .unwrap();
                let mut io = std::io::BufReader::new(server);
                io.get_mut().write_all(b"{\"QMP\":{}}\n").unwrap();
                let mut line = String::new();
                io.read_line(&mut line).unwrap();
                assert_eq!(
                    serde_json::from_str::<Value>(&line).unwrap()["execute"],
                    "qmp_capabilities"
                );
                if revocation == "voice" {
                    fixture_connected.store(false, std::sync::atomic::Ordering::SeqCst);
                }
                if revocation == "session" {
                    fixture_state
                        .db
                        .lock()
                        .unwrap()
                        .execute("DELETE FROM sessions", [])
                        .unwrap();
                }
                io.get_mut()
                    .write_all(b"{\"return\":{},\"id\":1}\n")
                    .unwrap();
                line.clear();
                let count = io.read_line(&mut line).unwrap();
                if revoke_during_handshake {
                    assert_eq!(count, 0);
                } else {
                    let command: Value = serde_json::from_str(&line).unwrap();
                    assert_eq!(command["execute"], "input-send-event");
                    assert_eq!(command["arguments"]["events"][1]["data"]["down"], false);
                    io.get_mut()
                        .write_all(b"{\"return\":{},\"id\":2}\n")
                        .unwrap();
                }
            });
            let result = dispatch(
                &state,
                &principal,
                "vm-channel",
                1,
                Event::Key { key: "a".into() }.events().unwrap(),
                client,
                || {
                    if connected.load(std::sync::atomic::Ordering::SeqCst) {
                        Ok(())
                    } else {
                        Err(crate::forbidden())
                    }
                },
            );
            if revoke_during_handshake {
                assert_eq!(
                    result.unwrap_err().0,
                    if revocation == "voice" {
                        StatusCode::FORBIDDEN
                    } else {
                        StatusCode::UNAUTHORIZED
                    }
                );
            } else {
                assert_eq!(result.unwrap().0["accepted"], true);
            }
            thread.join().unwrap();
        }
    }
    #[cfg(unix)]
    #[test]
    fn trickled_qmp_greeting_cannot_extend_total_deadline() {
        use std::io::Write;
        use std::time::{Duration, Instant};
        let (client, mut peer) = std::os::unix::net::UnixStream::pair().unwrap();
        let thread = std::thread::spawn(move || {
            for _ in 0..30 {
                if peer.write_all(b" ").is_err() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        });
        let start = Instant::now();
        assert!(Qmp::connect_before(client, start + Duration::from_millis(100)).is_err());
        assert!(start.elapsed() < Duration::from_millis(500));
        thread.join().unwrap();
    }
    #[test]
    fn input_is_bounded_and_never_accepts_raw_qmp_or_held_keys() {
        assert!(
            serde_json::from_value::<Event>(json!({"type":"execute","command":"quit"})).is_err()
        );
        assert!(Event::Pointer { x: 32768, y: 0 }.events().is_err());
        assert!(Event::Key {
            key: "ctrl-alt-delete".into()
        }
        .events()
        .is_err());
        let key = Event::Key { key: "a".into() }.events().unwrap();
        assert_eq!(key[0]["data"]["down"], true);
        assert_eq!(key[1]["data"]["down"], false);
        assert!(Event::Click {
            button: "left".into()
        }
        .events()
        .is_ok());
    }
}
