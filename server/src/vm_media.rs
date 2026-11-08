//! Private VM capture-source admission. Browser authorization never reaches the capture process.
use crate::{activities, member, now, ApiError, ApiResult, AppState, Principal};
use axum::{
    extract::{DefaultBodyLimit, Path, State},
    http::StatusCode,
    routing::{get, post},
    Extension, Json, Router,
};
use chriscord_activities::{Kind, Session};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

const SOURCE_USER: &str = "vm-capture";
const LEASE: Duration = Duration::from_secs(3);
#[derive(Clone)]
struct Grant {
    principal: Principal,
    session: String,
    generation: Option<String>,
    peer: Option<u64>,
    until: Instant,
}
#[derive(Default)]
pub struct Publisher {
    socket: Option<PathBuf>,
    uid: u32,
    channel: String,
    grant: Mutex<Option<Grant>>,
}
impl Publisher {
    pub fn configured(&self) -> bool {
        self.socket.is_some()
    }
    pub fn invalidate(&self, channel: &str) {
        if channel == self.channel {
            *self.grant.lock().unwrap() = None;
        }
    }
    fn invalidate_session(&self, session: &str) {
        let mut grant = self.grant.lock().unwrap();
        if grant.as_ref().is_some_and(|g| g.session == session) {
            *grant = None;
        }
    }
    /// Called from the SFU's existing periodic authorization boundary. No SFU RPC here.
    pub(crate) fn authorize(&self, db: &Connection, room: &str, user: &str, session: &str) -> bool {
        if user != SOURCE_USER || room != self.channel {
            return false;
        }
        let grant = self.grant.lock().unwrap().clone();
        grant.is_some_and(|g| {
            g.session == session
                && g.until > Instant::now()
                && database_authority(db, &g.principal, room)
        })
    }
}
fn unavailable() -> ApiError {
    ApiError(StatusCode::SERVICE_UNAVAILABLE, "VM capture unavailable")
}
fn database_authority(db: &Connection, principal: &Principal, channel: &str) -> bool {
    if member(db, &principal.user.id, channel).is_err() {
        return false;
    }
    let valid = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sessions WHERE id=?1 AND user_id=?2 AND expires_at>?3)",
            params![principal.session_id, principal.user.id, now()],
            |row| row.get::<_, bool>(0),
        )
        .unwrap_or(false);
    if !valid {
        return false;
    }
    let encoded: Option<String> = db
        .query_row(
            "SELECT state FROM activities WHERE channel_id=?1",
            [channel],
            |row| row.get(0),
        )
        .optional()
        .ok()
        .flatten();
    encoded
        .and_then(|value| serde_json::from_str::<Session>(&value).ok())
        .and_then(|activity| {
            activity
                .snapshot(&principal.user.id, now().max(0) as u64)
                .ok()
        })
        .is_some_and(|snapshot| snapshot.kind == Kind::Vm && snapshot.host == principal.user.id)
}
pub fn configure(state: &mut AppState) -> Result<(), String> {
    let socket = std::env::var("CHRISCORD_VM_MEDIA_SOCKET").unwrap_or_default();
    if socket.is_empty() {
        return Ok(());
    }
    if !cfg!(unix) || state.vm.is_none() {
        return Err("VM capture requires configured Unix VM input/channel".into());
    }
    let socket = PathBuf::from(socket);
    let uid: u32 = std::env::var("CHRISCORD_VM_MEDIA_UID")
        .unwrap_or_else(|_| "47192".into())
        .parse()
        .map_err(|_| "invalid VM publisher UID")?;
    if !socket.is_absolute() || uid == 0 {
        return Err("VM capture requires an absolute private socket and nonroot peer UID".into());
    }
    state.vm_media = Arc::new(Publisher {
        socket: Some(socket),
        uid,
        channel: std::env::var("CHRISCORD_VM_CHANNEL_ID").map_err(|_| "VM channel missing")?,
        grant: Mutex::new(None),
    });
    Ok(())
}
pub fn routes() -> Router<AppState> {
    Router::new().route(
        "/channels/{id}/vm/media",
        get(status).post(arm).delete(disarm),
    )
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Arm {
    expected_revision: u64,
}
async fn arm(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(channel): Path<String>,
    Json(input): Json<Arm>,
) -> ApiResult<Value> {
    if !s.vm_media.configured() || s.voice.is_none() {
        return Err(unavailable());
    }
    if channel != s.vm_media.channel {
        return Err(crate::forbidden());
    }
    let _operation = s
        .vm_operations
        .clone()
        .try_lock_owned()
        .map_err(|_| unavailable())?;
    let snapshot = activities::authorized_snapshot(&s, &p, &channel).await?;
    if snapshot.kind != Kind::Vm
        || snapshot.host != p.user.id
        || snapshot.revision != input.expected_revision
    {
        return Err(crate::forbidden());
    }
    if !database_authority(&s.db.lock().unwrap(), &p, &channel) {
        return Err(crate::forbidden());
    }
    // An armed source gets time to initialize codecs/ICE; subsequent renewals require live voice.
    *s.vm_media.grant.lock().unwrap() = Some(Grant {
        principal: p,
        session: format!("vm-publisher:{}", uuid::Uuid::new_v4()),
        generation: None,
        peer: None,
        until: Instant::now() + LEASE,
    });
    Ok(Json(json!({"armed":true,"phase":"armed"})))
}
async fn disarm(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(channel): Path<String>,
) -> ApiResult<Value> {
    let _operation = s
        .vm_operations
        .clone()
        .try_lock_owned()
        .map_err(|_| unavailable())?;
    let snapshot = activities::authorized_snapshot(&s, &p, &channel).await?;
    if snapshot.host != p.user.id {
        return Err(crate::forbidden());
    }
    s.vm_media.invalidate(&channel);
    Ok(Json(json!({"armed":false})))
}
async fn status(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(channel): Path<String>,
) -> ApiResult<Value> {
    member(&s.db.lock().unwrap(), &p.user.id, &channel)?;
    if !s.vm_media.configured() || channel != s.vm_media.channel {
        return Ok(Json(
            json!({"configured":false,"armed":false,"phase":"unavailable"}),
        ));
    }
    let grant = validated(&s, false, None).await;
    let Some(grant) = grant else {
        return Ok(Json(
            json!({"configured":true,"armed":false,"phase":"idle"}),
        ));
    };
    let peers = match &s.voice {
        Some(voice) => voice.stats(channel, p.session_id).await.ok(),
        None => None,
    };
    let live = peers.is_some_and(|peers| {
        peers.into_iter().any(|peer| {
            Some(peer.peer_id) == grant.peer
                && peer.publisher
                && peer.connected
                && peer.received_frames > 0
        })
    });
    Ok(Json(
        json!({"configured":true,"armed":true,"peer_id":grant.peer,"phase":if live {"live"} else if grant.peer.is_some() {"connecting"} else {"armed"}}),
    ))
}
/// Check actual interactive voice, excluding the publisher, before renewing the source's lease.
async fn validated(s: &AppState, renew: bool, expected: Option<&str>) -> Option<Grant> {
    let grant = s.vm_media.grant.lock().unwrap().clone()?;
    if expected.is_some_and(|session| session != grant.session) {
        return None;
    }
    let valid = s.voice.is_some()
        && tokio::time::timeout(
            Duration::from_millis(750),
            activities::authorized_snapshot(s, &grant.principal, &s.vm_media.channel),
        )
        .await
        .ok()
        .and_then(Result::ok)
        .is_some_and(|snapshot| {
            snapshot.kind == Kind::Vm && snapshot.host == grant.principal.user.id
        })
        && database_authority(&s.db.lock().unwrap(), &grant.principal, &s.vm_media.channel);
    if !valid {
        s.vm_media.invalidate_session(&grant.session);
        return None;
    }
    // Never renew a replaced grant. Expired admitted sources require explicit rearming.
    let mut guard = s.vm_media.grant.lock().unwrap();
    let current = guard.as_mut().filter(|g| g.session == grant.session)?;
    if current.peer.is_some() && current.until <= Instant::now() {
        *guard = None;
        return None;
    }
    if renew || current.peer.is_none() {
        current.until = Instant::now() + LEASE;
    }
    Some(current.clone())
}
struct PendingJoin {
    publisher: Arc<Publisher>,
    session: String,
    completed: bool,
}
impl Drop for PendingJoin {
    fn drop(&mut self) {
        if !self.completed {
            self.publisher.invalidate_session(&self.session);
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Join {
    generation: String,
    offer: chriscord_sfu::SdpOffer,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Pulse {
    generation: String,
    peer_id: Option<u64>,
}
async fn private_status(State(s): State<AppState>) -> Json<Value> {
    Json(json!({"armed":validated(&s, false, None).await.is_some()}))
}
async fn join(State(s): State<AppState>, Json(input): Json<Join>) -> ApiResult<Value> {
    if uuid::Uuid::parse_str(&input.generation)
        .map(|id| id.to_string())
        .ok()
        .as_deref()
        != Some(input.generation.as_str())
    {
        return Err(crate::bad("invalid capture generation"));
    }
    let _operation = s
        .vm_operations
        .clone()
        .try_lock_owned()
        .map_err(|_| unavailable())?;
    let grant = validated(&s, true, None)
        .await
        .ok_or_else(crate::forbidden)?;
    {
        let mut current = s.vm_media.grant.lock().unwrap();
        let current = current
            .as_mut()
            .filter(|g| g.session == grant.session)
            .ok_or_else(crate::forbidden)?;
        if current.generation.is_some() {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "capture generation already joined",
            ));
        }
        current.generation = Some(input.generation.clone());
    }
    let mut pending = PendingJoin {
        publisher: s.vm_media.clone(),
        session: grant.session.clone(),
        completed: false,
    };
    let voice = s.voice.as_ref().ok_or_else(unavailable)?;
    let joined = match voice
        .join_publisher(
            s.vm_media.channel.clone(),
            SOURCE_USER.into(),
            grant.session.clone(),
            input.offer,
        )
        .await
    {
        Ok(joined) => joined,
        Err(_) => {
            s.vm_media.invalidate_session(&grant.session);
            return Err(unavailable());
        }
    };
    if validated(&s, true, Some(&grant.session)).await.is_none() {
        let _ = voice
            .leave(s.vm_media.channel.clone(), grant.session, joined.peer_id)
            .await;
        return Err(crate::forbidden());
    }
    {
        let mut current = s.vm_media.grant.lock().unwrap();
        let current = current
            .as_mut()
            .filter(|g| g.session == grant.session)
            .ok_or_else(crate::forbidden)?;
        current.peer = Some(joined.peer_id);
    }
    pending.completed = true;
    Ok(Json(
        json!({"generation":input.generation,"peer_id":joined.peer_id,"answer":joined.answer}),
    ))
}
async fn heartbeat(State(s): State<AppState>, Json(input): Json<Pulse>) -> Json<Value> {
    let matching = s.vm_media.grant.lock().unwrap().clone().filter(|g| {
        g.generation.as_deref() == Some(input.generation.as_str())
            && g.peer == input.peer_id
            && input.peer_id.is_some()
    });
    let active = if let Some(grant) = matching {
        validated(&s, true, Some(&grant.session)).await.is_some()
    } else {
        false
    };
    Json(json!({"active":active}))
}
async fn leave(State(s): State<AppState>, Json(input): Json<Pulse>) -> Json<Value> {
    let grant = s.vm_media.grant.lock().unwrap().clone();
    let mut left = false;
    if let Some(grant) = grant.filter(|g| {
        g.generation.as_deref() == Some(input.generation.as_str())
            && input.peer_id.is_none_or(|peer| g.peer == Some(peer))
    }) {
        s.vm_media.invalidate_session(&grant.session);
        if let Some(voice) = &s.voice {
            let _ = voice
                .leave(
                    s.vm_media.channel.clone(),
                    grant.session,
                    grant.peer.unwrap_or(0),
                )
                .await;
        }
        left = true;
    }
    Json(json!({"left":left}))
}

#[cfg(unix)]
struct OwnedSocket {
    path: PathBuf,
    device: u64,
    inode: u64,
    _lock: std::fs::File,
}
#[cfg(unix)]
impl OwnedSocket {
    async fn bind(path: &std::path::Path) -> std::io::Result<(tokio::net::UnixListener, Self)> {
        use std::io::{Read, Seek, Write};
        use std::os::unix::fs::{FileTypeExt, MetadataExt, OpenOptionsExt};
        let failure = || {
            std::io::Error::other(
                "VM signaling directory/socket ownership or lifecycle lock is unsafe",
            )
        };
        let parent = std::fs::symlink_metadata(path.parent().ok_or_else(failure)?)?;
        // The publisher mounts this directory read-only and needs search, not write access.
        if !parent.is_dir() || parent.mode() & 0o022 != 0 {
            return Err(failure());
        }
        let lock_path = path.with_extension("lock");
        if let Ok(meta) = std::fs::symlink_metadata(&lock_path) {
            if !meta.is_file() || meta.uid() != parent.uid() || meta.mode() & 0o077 != 0 {
                return Err(failure());
            }
        }
        let mut lock = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .open(&lock_path)?;
        if lock.metadata()?.uid() != parent.uid() {
            return Err(failure());
        }
        lock.try_lock().map_err(|_| failure())?;
        let mut record = String::new();
        (&mut lock).take(256).read_to_string(&mut record)?;
        if let Ok(meta) = std::fs::symlink_metadata(path) {
            let expected = format!("{} {}", meta.dev(), meta.ino());
            if !meta.file_type().is_socket() || meta.uid() != parent.uid() || record != expected {
                return Err(failure());
            }
            match tokio::time::timeout(
                Duration::from_millis(250),
                tokio::net::UnixStream::connect(path),
            )
            .await
            {
                Ok(Err(error)) if error.kind() == std::io::ErrorKind::ConnectionRefused => {}
                _ => return Err(failure()),
            }
            let current = std::fs::symlink_metadata(path)?;
            if current.dev() != meta.dev() || current.ino() != meta.ino() {
                return Err(failure());
            }
            std::fs::remove_file(path)?;
        }
        let listener = tokio::net::UnixListener::bind(path)?;
        let meta = std::fs::symlink_metadata(path)?;
        let owner = Self {
            path: path.into(),
            device: meta.dev(),
            inode: meta.ino(),
            _lock: lock.try_clone()?,
        };
        lock.set_len(0)?;
        lock.rewind()?;
        write!(lock, "{} {}", owner.device, owner.inode)?;
        lock.sync_all()?;
        Ok((listener, owner))
    }
}
#[cfg(unix)]
impl Drop for OwnedSocket {
    fn drop(&mut self) {
        use std::os::unix::fs::MetadataExt;
        if std::fs::symlink_metadata(&self.path)
            .is_ok_and(|meta| meta.dev() == self.device && meta.ino() == self.inode)
        {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}
#[cfg(unix)]
struct PrivateListener {
    listener: tokio::net::UnixListener,
    uid: u32,
    _owner: Option<OwnedSocket>,
}
#[cfg(unix)]
impl axum::serve::Listener for PrivateListener {
    type Io = tokio::net::UnixStream;
    type Addr = tokio::net::unix::SocketAddr;
    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        loop {
            match self.listener.accept().await {
                Ok((stream, addr))
                    if stream.peer_cred().is_ok_and(|cred| cred.uid() == self.uid) =>
                {
                    return (stream, addr)
                }
                Ok(_) => {}
                Err(_) => tokio::time::sleep(Duration::from_millis(250)).await,
            }
        }
    }
    fn local_addr(&self) -> std::io::Result<Self::Addr> {
        self.listener.local_addr()
    }
}
/// Bind a private socket; recover only a recorded, same-owner, provably stale inode under its lifecycle lock.
pub async fn start(s: &AppState) -> Result<(), Box<dyn std::error::Error>> {
    let Some(path) = &s.vm_media.socket else {
        return Ok(());
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if s.voice.is_none() {
            return Err("VM capture requires the SFU".into());
        }
        let (listener, owner) = OwnedSocket::bind(path).await?;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o660))?;
        let listener = PrivateListener {
            listener,
            uid: s.vm_media.uid,
            _owner: Some(owner),
        };
        let router = Router::new()
            .route("/v1/vm-publisher/status", get(private_status))
            .route("/v1/vm-publisher/join", post(join))
            .route("/v1/vm-publisher/heartbeat", post(heartbeat))
            .route("/v1/vm-publisher/leave", post(leave))
            .layer(DefaultBodyLimit::max(96 * 1024))
            .with_state(s.clone());
        tokio::spawn(async move {
            if axum::serve(listener, router).await.is_err() {
                tracing::error!("private VM capture listener stopped");
            }
        });
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        return Err("VM capture requires Unix".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> AppState {
        let mut state = AppState::new(":memory:", "fixture").unwrap();
        let principal = Principal {
            user: crate::User {
                id: "host".into(),
                username: "host".into(),
                is_owner: true,
            },
            session_id: "host-session".into(),
        };
        let activity = Session::new(
            Kind::Vm,
            "host".into(),
            ["host".into()].into(),
            now() as u64,
        )
        .unwrap();
        {
            let db = state.db.lock().unwrap();
            db.execute(
                "INSERT INTO users(id,username,password,is_owner) VALUES('host','host','unused',1)",
                [],
            )
            .unwrap();
            db.execute("INSERT INTO sessions VALUES('host-session','host','synthetic','synthetic','fixture',0,?1)", [now()+60000]).unwrap();
            db.execute(
                "INSERT INTO channels(id,name,kind) VALUES('vm-channel','fixture','channel')",
                [],
            )
            .unwrap();
            db.execute("INSERT INTO members VALUES('vm-channel','host')", [])
                .unwrap();
            db.execute(
                "INSERT INTO activities VALUES('vm-channel',?1)",
                [serde_json::to_string(&activity).unwrap()],
            )
            .unwrap();
        }
        state.vm_media = Arc::new(Publisher {
            socket: Some("/fixture/publisher.sock".into()),
            uid: 47192,
            channel: "vm-channel".into(),
            grant: Mutex::new(Some(Grant {
                principal,
                session: "source-session".into(),
                generation: Some("generation".into()),
                peer: Some(7),
                until: Instant::now() + LEASE,
            })),
        });
        state
    }
    #[test]
    fn source_grant_requires_current_host_session_channel_identity_and_deadline() {
        let state = fixture();
        let db = state.db.lock().unwrap();
        assert!(state
            .vm_media
            .authorize(&db, "vm-channel", SOURCE_USER, "source-session"));
        assert!(!state
            .vm_media
            .authorize(&db, "other", SOURCE_USER, "source-session"));
        assert!(!state
            .vm_media
            .authorize(&db, "vm-channel", "host", "source-session"));
        assert!(!state
            .vm_media
            .authorize(&db, "vm-channel", SOURCE_USER, "host-session"));
        state.vm_media.grant.lock().unwrap().as_mut().unwrap().until =
            Instant::now() - Duration::from_millis(1);
        assert!(!state
            .vm_media
            .authorize(&db, "vm-channel", SOURCE_USER, "source-session"));
        state.vm_media.grant.lock().unwrap().as_mut().unwrap().until = Instant::now() + LEASE;
        db.execute("DELETE FROM sessions", []).unwrap();
        assert!(!state
            .vm_media
            .authorize(&db, "vm-channel", SOURCE_USER, "source-session"));
    }
    #[test]
    fn canceled_pending_join_cannot_leave_an_authorized_orphan_or_revoke_replacement() {
        let state = fixture();
        let guard = PendingJoin {
            publisher: state.vm_media.clone(),
            session: "old-session".into(),
            completed: false,
        };
        drop(guard);
        assert!(state.vm_media.grant.lock().unwrap().is_some());
        drop(PendingJoin {
            publisher: state.vm_media.clone(),
            session: "source-session".into(),
            completed: false,
        });
        assert!(state.vm_media.grant.lock().unwrap().is_none());
    }
    #[tokio::test]
    async fn lost_join_response_can_revoke_only_its_matching_generation() {
        let state = fixture();
        let stale = leave(
            State(state.clone()),
            Json(Pulse {
                generation: "old".into(),
                peer_id: None,
            }),
        )
        .await;
        assert_eq!(stale.0["left"], false);
        assert!(state.vm_media.grant.lock().unwrap().is_some());
        let current = leave(
            State(state.clone()),
            Json(Pulse {
                generation: "generation".into(),
                peer_id: None,
            }),
        )
        .await;
        assert_eq!(current.0["left"], true);
        assert!(state.vm_media.grant.lock().unwrap().is_none());
    }
    #[tokio::test]
    async fn missing_interactive_voice_disarms_capture_instead_of_renewing_it() {
        let state = fixture();
        assert!(validated(&state, true, Some("source-session"))
            .await
            .is_none());
        assert!(state.vm_media.grant.lock().unwrap().is_none());
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn socket_restart_recovers_only_recorded_stale_inode_and_preserves_foreign_path() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let directory = tempfile::tempdir().unwrap();
        std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let path = directory.path().join("publisher.sock");
        let (listener, owner) = OwnedSocket::bind(&path).await.unwrap();
        assert!(OwnedSocket::bind(&path).await.is_err());
        drop(listener);
        drop(owner);
        assert!(!path.exists());
        let stale = std::os::unix::net::UnixListener::bind(&path).unwrap();
        let meta = std::fs::metadata(&path).unwrap();
        std::fs::write(
            path.with_extension("lock"),
            format!("{} {}", meta.dev(), meta.ino()),
        )
        .unwrap();
        drop(stale);
        let (listener, owner) = OwnedSocket::bind(&path).await.unwrap();
        drop(listener);
        drop(owner);
        std::fs::write(&path, b"foreign file").unwrap();
        assert!(OwnedSocket::bind(&path).await.is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"foreign file");
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn private_listener_rejects_wrong_unix_peer_uid() {
        use axum::serve::Listener;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("capture.sock");
        let listener = tokio::net::UnixListener::bind(&path).unwrap();
        let client = tokio::net::UnixStream::connect(&path).await.unwrap();
        let own_uid = client.peer_cred().unwrap().uid();
        let mut listener = PrivateListener {
            listener,
            uid: own_uid.wrapping_add(1),
            _owner: None,
        };
        assert!(
            tokio::time::timeout(Duration::from_millis(50), listener.accept())
                .await
                .is_err()
        );
        drop(client);
        listener.uid = own_uid;
        let _client = tokio::net::UnixStream::connect(&path).await.unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(100), listener.accept())
                .await
                .is_ok()
        );
    }
}
