//! Local DJ production: approved resolver -> bounded CDN download -> local intro+song -> encrypted cache.
//! Provider access is opt-in; tests use loopback fixtures and local media tools only.
use crate::{activities, emit, member, now, ApiError, ApiResult, AppState, Principal};
use axum::{
    body::{Body, Bytes},
    extract::{Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::Response,
    routing::{get, post},
    Extension, Json, Router,
};
use housecall_activities::{
    dj::{
        probe_duration, AudioDownloader, CloneTts, PlaceholderTts, ResolvedTrack, Resolver, Source,
        Switchboard, Tts,
    },
    session::Track,
    Command, Kind, Session, Snapshot,
};
use housecall_media::{Scanner, Store};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{BTreeSet, HashMap},
    io::Read,
    path::{Path as FsPath, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::io::AsyncReadExt;
use tokio_stream::wrappers::ReceiverStream;
use uuid::Uuid;
const OWNER: &str = "housecall-dj-cache";
const MAX_OUTPUT: u64 = 64 * 1024 * 1024;
const CACHE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_ASSETS: i64 = 128;
pub struct Player {
    resolver: Resolver,
    downloader: AudioDownloader,
    switchboard: Switchboard,
    tts: Arc<dyn Tts>,
    ffmpeg: PathBuf,
    ffprobe: PathBuf,
    scratch: PathBuf,
    store: Arc<Store>,
    scanner: Arc<dyn Scanner>,
    db: Arc<Mutex<Connection>>,
    produce: tokio::sync::Semaphore,
    streams: Arc<tokio::sync::Semaphore>,
    generations: Mutex<HashMap<String, Uuid>>,
    #[cfg(test)]
    fixture: Option<ResolvedTrack>,
}
impl Player {
    fn epoch(&self, channel: &str) -> Result<Uuid, ApiError> {
        let mut generations = self.generations.lock().unwrap();
        if generations.len() >= 30 && !generations.contains_key(channel) {
            return Err(busy());
        }
        Ok(*generations
            .entry(channel.into())
            .or_insert_with(Uuid::new_v4))
    }
    /// Call after the activity-stop transaction commits, outside the DB lock.
    pub fn stop_channel(&self, channel: &str) {
        self.generations.lock().unwrap().remove(channel);
        let ids = {
            let db = self.db.lock().unwrap();
            let Ok(mut query) = db.prepare("SELECT media_id FROM dj_assets WHERE channel_id=?1")
            else {
                return;
            };
            let Ok(rows) = query.query_map([channel], |r| r.get::<_, String>(0)) else {
                return;
            };
            let ids: Vec<String> = rows.filter_map(Result::ok).collect();
            let _ = db.execute("DELETE FROM dj_assets WHERE channel_id=?1", [channel]);
            ids
        };
        let store = self.store.clone();
        tokio::task::spawn_blocking(move || {
            for id in ids {
                if let Ok(id) = Uuid::parse_str(&id) {
                    let _ = store.delete(id, OWNER);
                }
            }
        });
    }
    async fn resolve(&self, query: &str) -> Result<ResolvedTrack, ApiError> {
        Source::parse(query).map_err(provider)?;
        #[cfg(test)]
        if let Some(track) = &self.fixture {
            return Ok(track.clone());
        }
        let track = self.resolver.resolve(query).await.map_err(provider)?;
        if track.duration_ms > 900_000 {
            return Err(invalid("DJ tracks are limited to fifteen minutes"));
        }
        Ok(track)
    }
    async fn prepare(
        &self,
        state: &AppState,
        principal: &Principal,
        channel: &str,
        track: ResolvedTrack,
    ) -> Result<Prepared, ApiError> {
        let scratch = Scratch::new(&self.scratch)?;
        let song = scratch.0.join("song.audio");
        authorize(state, principal, channel).await?;
        self.downloader
            .download(&track, &song)
            .await
            .map_err(provider)?;
        let song_ms = probe_duration(&self.ffprobe, &song)
            .await
            .map_err(provider)?;
        if song_ms > 900_000 {
            return Err(invalid("DJ tracks are limited to fifteen minutes"));
        }
        // No prior-title assertion: removals/skips may change the preceding track after preparation.
        authorize(state, principal, channel).await?;
        let banter = self
            .switchboard
            .banter(None, &track.title)
            .await
            .map_err(provider)?;
        let intro = scratch.0.join("intro.wav");
        authorize(state, principal, channel).await?;
        self.tts
            .synthesize(&banter, &intro)
            .await
            .map_err(provider)?;
        let intro_ms = probe_duration(&self.ffprobe, &intro)
            .await
            .map_err(provider)?;
        if intro_ms > 60_000 {
            return Err(invalid("DJ introduction exceeds one minute"));
        }
        let metadata = self
            .store
            .create_generated(OWNER, channel, "dj-track.mp4", MAX_OUTPUT)
            .map_err(ApiError::from)?;
        let asset = Uuid::new_v4().to_string();
        {
            let db = self.db.lock().unwrap();
            // The duration limits above keep both values within SQLite's signed integer range.
            if let Err(error) = db.execute("INSERT INTO dj_assets(id,channel_id,media_id,state,title,source,intro_ms,duration_ms,bytes,created_at) VALUES(?1,?2,?3,'preparing',?4,?5,?6,?7,67108864,?8)", params![asset, channel, metadata.id.to_string(), track.title, track.source, intro_ms as i64, (song_ms + intro_ms) as i64, now()]) { let _ = self.store.delete(metadata.id, OWNER); return Err(error.into()); }
        }
        let encoded = self.encode(metadata.id, &intro, &song).await;
        match encoded {
            Ok(bytes) => {
                // encode caps output at MAX_OUTPUT, well within SQLite's signed range.
                self.db.lock().unwrap().execute(
                    "UPDATE dj_assets SET state='ready',bytes=?1 WHERE id=?2",
                    params![bytes as i64, asset],
                )?;
                Ok(Prepared {
                    id: asset,
                    title: track.title,
                    source: track.source,
                    duration_ms: song_ms + intro_ms,
                    intro_ms,
                })
            }
            Err(error) => {
                let _ = self
                    .db
                    .lock()
                    .unwrap()
                    .execute("DELETE FROM dj_assets WHERE id=?1", [&asset]);
                let _ = self.store.delete(metadata.id, OWNER);
                Err(error)
            }
        }
    }
    async fn encode(&self, media: Uuid, intro: &FsPath, song: &FsPath) -> Result<u64, ApiError> {
        let mut command = tokio::process::Command::new(&self.ffmpeg);
        command.args(["-nostdin", "-hide_banner", "-loglevel", "error", "-threads", "1", "-protocol_whitelist", "file,pipe", "-format_whitelist", "matroska,webm,mov,mp3,ogg,wav,aac,flac", "-probesize", "1048576", "-analyzeduration", "3000000", "-i"]).arg(intro)
            .args(["-protocol_whitelist", "file,pipe", "-format_whitelist", "matroska,webm,mov,mp3,ogg,wav,aac,flac", "-probesize", "1048576", "-analyzeduration", "3000000", "-i"]).arg(song)
            .args(["-filter_complex_threads", "1", "-filter_complex", "[0:a]aformat=sample_rates=48000:channel_layouts=stereo[a0];[1:a]aformat=sample_rates=48000:channel_layouts=stereo[a1];[a0][a1]concat=n=2:v=0:a=1[out]", "-map", "[out]", "-c:a", "libopus", "-b:a", "510k", "-vbr", "on", "-movflags", "+frag_keyframe+empty_moov+default_base_moof", "-frag_duration", "2000000", "-f", "mp4", "pipe:1"])
            .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
        let mut child = command.spawn().map_err(|_| unavailable())?;
        let result = tokio::time::timeout(Duration::from_secs(180), async {
            let mut output = child.stdout.take().ok_or_else(unavailable)?;
            let mut offset = 0;
            loop {
                let mut bytes = vec![0; 256 * 1024];
                let n = output.read(&mut bytes).await.map_err(|_| unavailable())?;
                if n == 0 {
                    break;
                }
                bytes.truncate(n);
                if offset + n as u64 > MAX_OUTPUT {
                    return Err(invalid("DJ cache output limit"));
                }
                let store = self.store.clone();
                tokio::task::spawn_blocking(move || store.append(media, OWNER, offset, &bytes))
                    .await
                    .map_err(|_| unavailable())?
                    .map_err(ApiError::from)?;
                offset += n as u64;
            }
            if offset == 0 || !child.wait().await.map_err(|_| unavailable())?.success() {
                return Err(unavailable());
            }
            let store = self.store.clone();
            let scanner = self.scanner.clone();
            tokio::task::spawn_blocking(move || {
                store.finish_generated(media, OWNER, scanner.as_ref())
            })
            .await
            .map_err(|_| unavailable())?
            .map_err(ApiError::from)?;
            Ok(offset)
        })
        .await
        .map_err(|_| unavailable())?;
        result
    }
}
struct Scratch(PathBuf);
impl Scratch {
    fn new(root: &FsPath) -> Result<Self, ApiError> {
        let path = root.join(format!("job-{}", Uuid::new_v4()));
        std::fs::create_dir(&path).map_err(|_| unavailable())?;
        Ok(Self(path))
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
struct Prepared {
    id: String,
    title: String,
    source: String,
    duration_ms: u64,
    intro_ms: u64,
}
pub fn init(db: &Connection) -> rusqlite::Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS dj_assets(id TEXT PRIMARY KEY,channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,media_id TEXT NOT NULL UNIQUE,state TEXT NOT NULL CHECK(state IN ('preparing','ready')),title TEXT NOT NULL,source TEXT NOT NULL,intro_ms INTEGER NOT NULL,duration_ms INTEGER NOT NULL,bytes INTEGER NOT NULL,created_at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS dj_assets_channel ON dj_assets(channel_id);")
}
pub fn configure(state: &mut AppState) -> Result<(), String> {
    match std::env::var("DJ_ENABLED").as_deref() {
        Err(_) | Ok("false" | "0") => return Ok(()),
        Ok("true" | "1") => {}
        _ => return Err("DJ_ENABLED must be true or false".into()),
    }
    let switchboard_url = std::env::var("SWITCHBOARD_URL").unwrap_or_default();
    if switchboard_url.trim().is_empty() {
        return Err("DJ_ENABLED requires SWITCHBOARD_URL (chat-completions endpoint)".into());
    }
    let switchboard_url = switchboard_url.trim().to_owned();
    let store = state
        .media
        .clone()
        .ok_or("DJ requires encrypted media storage")?;
    if state.voice.is_none() {
        return Err("DJ requires voice SFU".into());
    }
    let scratch = PathBuf::from(
        std::env::var("DJ_TMPFS_DIR").unwrap_or_else(|_| "/dev/shm/housecall-dj".into()),
    );
    std::fs::create_dir_all(&scratch).map_err(|_| "cannot create DJ tmpfs directory")?;
    let scratch = scratch
        .canonicalize()
        .map_err(|_| "invalid DJ tmpfs directory")?;
    if !on_tmpfs(&scratch) {
        return Err(
            "DJ_TMPFS_DIR must be on tmpfs; plaintext media is never staged on disk".into(),
        );
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&scratch, std::fs::Permissions::from_mode(0o700))
            .map_err(|_| "cannot protect DJ scratch")?;
    }
    let tts: Arc<dyn Tts> = if let Ok(command) = std::env::var("DJ_TTS_COMMAND") {
        Arc::new(CloneTts {
            executable: command.into(),
            reference_wav: std::env::var("DJ_REFERENCE_WAV")
                .map_err(|_| "DJ_REFERENCE_WAV required")?
                .into(),
            model_dir: std::env::var("DJ_TTS_MODEL_DIR")
                .map_err(|_| "DJ_TTS_MODEL_DIR required")?
                .into(),
        })
    } else {
        Arc::new(PlaceholderTts {
            espeak_ng: std::env::var("ESPEAK_NG_BIN")
                .unwrap_or_else(|_| "espeak-ng".into())
                .into(),
        })
    };
    // A restart never resumes a half-encoded cache item or leaves plaintext staging files behind.
    let abandoned = {
        let db = state.db.lock().unwrap();
        let mut query = db
            .prepare("SELECT id,media_id FROM dj_assets WHERE state='preparing'")
            .map_err(|_| "DJ recovery database failure")?;
        let rows = query
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|_| "DJ recovery database failure")?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|_| "DJ recovery database failure")?;
        rows
    };
    for (id, media) in abandoned {
        if let Ok(media) = Uuid::parse_str(&media) {
            let _ = store.delete(media, OWNER);
        }
        state
            .db
            .lock()
            .unwrap()
            .execute("DELETE FROM dj_assets WHERE id=?1", [id])
            .map_err(|_| "DJ recovery database failure")?;
    }
    for entry in std::fs::read_dir(&scratch)
        .map_err(|_| "DJ scratch recovery failure")?
        .flatten()
    {
        if entry
            .file_name()
            .to_str()
            .and_then(|name| name.strip_prefix("job-"))
            .is_some_and(|id| Uuid::parse_str(id).is_ok())
        {
            std::fs::remove_dir_all(entry.path()).map_err(|_| "DJ scratch recovery failure")?;
        }
    }
    state.dj = Some(Arc::new(Player {
        resolver: Resolver {
            yt_dlp: std::env::var("YT_DLP_BIN")
                .unwrap_or_else(|_| "yt-dlp".into())
                .into(),
            spotify_access_token: std::env::var("SPOTIFY_ACCESS_TOKEN").ok(),
            js_runtime: std::env::var("DJ_JS_RUNTIME").unwrap_or_else(|_| "node".into()),
        },
        downloader: AudioDownloader::default(),
        switchboard: Switchboard::new(
            &switchboard_url,
            std::env::var("SWITCHBOARD_API_KEY")
                .ok()
                .filter(|key| !key.is_empty()),
        )
        .map_err(|_| "invalid SWITCHBOARD_URL")?,
        tts,
        ffmpeg: std::env::var("FFMPEG_BIN")
            .unwrap_or_else(|_| "ffmpeg".into())
            .into(),
        ffprobe: std::env::var("FFPROBE_BIN")
            .unwrap_or_else(|_| "ffprobe".into())
            .into(),
        scratch,
        store,
        scanner: state.scanner.clone(),
        db: state.db.clone(),
        produce: tokio::sync::Semaphore::new(1),
        streams: Arc::new(tokio::sync::Semaphore::new(32)),
        generations: Mutex::new(HashMap::new()),
        #[cfg(test)]
        fixture: None,
    }));
    Ok(())
}
fn on_tmpfs(path: &FsPath) -> bool {
    let Ok(mounts) = std::fs::read_to_string("/proc/mounts") else {
        return false;
    };
    mounts
        .lines()
        .filter_map(|line| {
            let parts: Vec<_> = line.split_whitespace().collect();
            (parts.len() >= 3).then(|| (FsPath::new(parts[1]), parts[2]))
        })
        .filter(|(mount, _)| path.starts_with(mount))
        .max_by_key(|(mount, _)| mount.as_os_str().len())
        .is_some_and(|(_, kind)| kind == "tmpfs")
}
pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/channels/{id}/dj/search", post(search))
        .route("/channels/{id}/dj/queue", post(enqueue))
        .route("/channels/{id}/dj/playback", get(playback))
        .route("/channels/{id}/dj/audio/{track}", get(audio))
        .route("/channels/{id}/dj/audio/{track}/seek", get(seek))
}
fn player(s: &AppState) -> Result<Arc<Player>, ApiError> {
    s.dj.clone().ok_or(ApiError(
        StatusCode::SERVICE_UNAVAILABLE,
        "DJ playback is not configured",
    ))
}
fn invalid(message: &'static str) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, message)
}
fn unavailable() -> ApiError {
    ApiError(
        StatusCode::BAD_GATEWAY,
        "DJ provider or local audio processing unavailable",
    )
}
fn busy() -> ApiError {
    ApiError(
        StatusCode::TOO_MANY_REQUESTS,
        "DJ preparation is busy; retry later",
    )
}
fn provider(error: housecall_activities::Error) -> ApiError {
    match error {
        housecall_activities::Error::Invalid(reason) => invalid(reason),
        _ => unavailable(),
    }
}
async fn authorize(s: &AppState, p: &Principal, channel: &str) -> Result<Snapshot, ApiError> {
    member(&s.db.lock().unwrap(), &p.user.id, channel)?;
    if s.voice.is_none() {
        return Err(ApiError(
            StatusCode::SERVICE_UNAVAILABLE,
            "DJ playback requires voice transport",
        ));
    }
    let snapshot = activities::authorized_snapshot(s, p, channel).await?;
    if snapshot.kind != Kind::Dj {
        return Err(invalid("start a DJ activity first"));
    }
    let db = s.db.lock().unwrap();
    let active: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sessions WHERE id=?1 AND user_id=?2 AND expires_at>?3)",
        params![p.session_id, p.user.id, now()],
        |r| r.get(0),
    )?;
    if !active {
        return Err(ApiError(StatusCode::UNAUTHORIZED, "session revoked"));
    }
    Ok(snapshot)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TrackQuery {
    query: String,
}
async fn search(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(channel): Path<String>,
    Json(input): Json<TrackQuery>,
) -> ApiResult<Value> {
    authorize(&s, &p, &channel).await?;
    let player = player(&s)?;
    let _permit = player.produce.try_acquire().map_err(|_| busy())?;
    let track = player.resolve(&input.query).await?;
    authorize(&s, &p, &channel).await?;
    Ok(Json(json!({"results":[track]})))
}
async fn enqueue(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(channel): Path<String>,
    Json(input): Json<TrackQuery>,
) -> ApiResult<Value> {
    authorize(&s, &p, &channel).await?;
    let player = player(&s)?;
    let _permit = player.produce.try_acquire().map_err(|_| busy())?;
    let epoch = player.epoch(&channel)?;
    {
        let db = s.db.lock().unwrap();
        let (count, bytes): (i64, u64) = db.query_row(
            "SELECT COUNT(*),COALESCE(SUM(bytes),0) FROM dj_assets",
            [],
            |r| Ok((r.get(0)?, nonnegative_integer(r, 1)?)),
        )?;
        if count >= MAX_ASSETS || bytes + MAX_OUTPUT > CACHE_BYTES {
            return Err(ApiError(
                StatusCode::INSUFFICIENT_STORAGE,
                "DJ cache full; remove queued tracks",
            ));
        }
    }
    let track = player.resolve(&input.query).await?;
    authorize(&s, &p, &channel).await?;
    let prepared = player.prepare(&s, &p, &channel, track).await?;
    let result = async {
        let snapshot = authorize(&s, &p, &channel).await?;
        if player.generations.lock().unwrap().get(&channel) != Some(&epoch) {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "DJ activity changed during preparation",
            ));
        }
        let mut db = s.db.lock().unwrap();
        let tx = db.transaction()?;
        let result = enqueue_prepared(
            &tx,
            &channel,
            &p.user.id,
            snapshot.members,
            &prepared,
            now().max(0) as u64,
        )?;
        tx.commit()?;
        Ok(Json(
            json!({"track_id":prepared.id,"intro_ms":prepared.intro_ms,"activity":result}),
        ))
    }
    .await;
    if result.is_err() {
        discard(&player, &prepared.id);
    }
    result
}
fn enqueue_prepared(
    db: &Connection,
    channel: &str,
    actor: &str,
    members: BTreeSet<String>,
    prepared: &Prepared,
    at: u64,
) -> Result<Snapshot, ApiError> {
    let raw: String = db.query_row(
        "SELECT state FROM activities WHERE channel_id=?1",
        [channel],
        |r| r.get(0),
    )?;
    let mut session: Session = serde_json::from_str(&raw).map_err(|_| unavailable())?;
    session.replace_members(members, at).map_err(provider)?;
    session.tick(at);
    let current = session.snapshot(actor, at).map_err(provider)?;
    if current.kind != Kind::Dj {
        return Err(invalid("DJ activity changed"));
    }
    let snapshot = session
        .apply(
            actor,
            current.revision,
            Command::Enqueue {
                track: Track {
                    id: prepared.id.clone(),
                    title: prepared.title.clone(),
                    source: prepared.source.clone(),
                    duration_ms: prepared.duration_ms,
                    requested_by: actor.into(),
                },
            },
            at,
        )
        .map_err(provider)?;
    db.execute(
        "UPDATE activities SET state=?1 WHERE channel_id=?2",
        params![
            serde_json::to_string(&session).map_err(|_| unavailable())?,
            channel
        ],
    )?;
    emit(
        db,
        channel,
        "activity.updated",
        serde_json::to_value(&snapshot).map_err(|_| unavailable())?,
    )?;
    Ok(snapshot)
}
fn discard(player: &Player, asset: &str) {
    let media: Option<String> = {
        let db = player.db.lock().unwrap();
        let id = db
            .query_row("SELECT media_id FROM dj_assets WHERE id=?1", [asset], |r| {
                r.get(0)
            })
            .optional()
            .ok()
            .flatten();
        let _ = db.execute("DELETE FROM dj_assets WHERE id=?1", [asset]);
        id
    };
    if let Some(id) = media.and_then(|id| Uuid::parse_str(&id).ok()) {
        let _ = player.store.delete(id, OWNER);
    }
}
fn nonnegative_integer(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<u64> {
    let value: i64 = row.get(index)?;
    u64::try_from(value).map_err(|_| rusqlite::Error::IntegralValueOutOfRange(index, value))
}
fn descriptor(db: &Connection, channel: &str, snapshot: &Snapshot) -> Result<Value, ApiError> {
    let Some(id) = snapshot.playback.media_id.as_ref() else {
        return Ok(json!({"track":null,"activity":snapshot}));
    };
    let (intro,duration):(u64,u64)=db.query_row("SELECT intro_ms,duration_ms FROM dj_assets WHERE id=?1 AND channel_id=?2 AND state='ready'",params![id,channel],|r|Ok((nonnegative_integer(r,0)?,nonnegative_integer(r,1)?))).optional()?.ok_or(ApiError(StatusCode::CONFLICT,"current DJ track has no prepared audio"))?;
    Ok(
        json!({"track":{"id":id,"intro_ms":intro,"duration_ms":duration,"audio_url":format!("/api/channels/{channel}/dj/audio/{id}")},"activity":snapshot}),
    )
}
async fn playback(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(channel): Path<String>,
) -> ApiResult<Value> {
    let snapshot = authorize(&s, &p, &channel).await?;
    player(&s)?;
    let value = descriptor(&s.db.lock().unwrap(), &channel, &snapshot)?;
    Ok(Json(value))
}
async fn seek(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path((channel, track)): Path<(String, String)>,
    Query(query): Query<crate::media_index::Query>,
) -> ApiResult<crate::media_index::Window> {
    let snapshot = authorize(&s, &p, &channel).await?;
    if snapshot.playback.media_id.as_ref() != Some(&track) {
        return Err(ApiError(StatusCode::NOT_FOUND, "DJ audio is not current"));
    }
    let player = player(&s)?;
    let _permit = player
        .streams
        .clone()
        .try_acquire_owned()
        .map_err(|_| busy())?;
    let id: String =
        s.db.lock()
            .unwrap()
            .query_row(
                "SELECT media_id FROM dj_assets WHERE id=?1 AND channel_id=?2 AND state='ready'",
                params![track, channel],
                |r| r.get(0),
            )
            .optional()?
            .ok_or(ApiError(StatusCode::NOT_FOUND, "DJ audio unavailable"))?;
    let id = Uuid::parse_str(&id).map_err(|_| unavailable())?;
    let metadata = player.store.metadata(id)?;
    // Preserve already-scanned ready queues created before the MP4 upgrade.
    // New tracks never use this compatibility path.
    if metadata.filename == "dj-track.ogg" {
        return Err(ApiError(StatusCode::CONFLICT, "legacy_dj_ogg"));
    }
    let window = crate::media_index::lookup(player.store.clone(), metadata, query).await?;
    if authorize(&s, &p, &channel)
        .await?
        .playback
        .media_id
        .as_ref()
        != Some(&track)
    {
        return Err(ApiError(StatusCode::NOT_FOUND, "DJ audio is not current"));
    }
    Ok(Json(window))
}
async fn audio(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path((channel, track)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let snapshot = authorize(&s, &p, &channel).await?;
    if snapshot.playback.media_id.as_ref() != Some(&track) {
        return Err(ApiError(StatusCode::NOT_FOUND, "DJ audio is not current"));
    }
    let player = player(&s)?;
    let permit = player
        .streams
        .clone()
        .try_acquire_owned()
        .map_err(|_| busy())?;
    let id: String =
        s.db.lock()
            .unwrap()
            .query_row(
                "SELECT media_id FROM dj_assets WHERE id=?1 AND channel_id=?2 AND state='ready'",
                params![track, channel],
                |r| r.get(0),
            )
            .optional()?
            .ok_or(ApiError(StatusCode::NOT_FOUND, "DJ audio unavailable"))?;
    let id = Uuid::parse_str(&id).map_err(|_| unavailable())?;
    let metadata = player.store.metadata(id).map_err(ApiError::from)?;
    let content_type = if metadata.filename == "dj-track.ogg" {
        "audio/ogg"
    } else {
        "audio/mp4"
    };
    let range = headers.get(header::RANGE);
    let (start, end) = if let Some(range) = range {
        housecall_media::parse_range(
            range.to_str().map_err(|_| invalid("byte range"))?,
            metadata.length,
        )
        .map_err(|_| ApiError(StatusCode::RANGE_NOT_SATISFIABLE, "byte range"))?
    } else {
        (0, metadata.length)
    };
    let mut reader = player
        .store
        .read_range(id, start, end)
        .map_err(ApiError::from)?;
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(2);
    tokio::spawn(async move {
        let _permit = permit;
        let mut checked = Instant::now();
        loop {
            if checked.elapsed() >= Duration::from_secs(1) {
                if !authorize(&s, &p, &channel)
                    .await
                    .is_ok_and(|snapshot| snapshot.playback.media_id.as_ref() == Some(&track))
                {
                    break;
                }
                checked = Instant::now();
            }
            let result = tokio::task::spawn_blocking(move || {
                let mut bytes = vec![0; 64 * 1024];
                let n = reader.read(&mut bytes);
                (reader, bytes, n)
            })
            .await;
            let Ok((next, mut bytes, n)) = result else {
                break;
            };
            reader = next;
            match n {
                Ok(0) => break,
                Ok(n) => {
                    bytes.truncate(n);
                    if tx.send(Ok(Bytes::from(bytes))).await.is_err() {
                        break;
                    }
                }
                Err(error) => {
                    let _ = tx.send(Err(error)).await;
                    break;
                }
            }
        }
    });
    let mut response = Response::builder()
        .status(if range.is_some() {
            StatusCode::PARTIAL_CONTENT
        } else {
            StatusCode::OK
        })
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CONTENT_DISPOSITION, "inline")
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, (end - start).to_string())
        .header(header::CACHE_CONTROL, "private, no-store");
    if range.is_some() {
        response = response.header(
            header::CONTENT_RANGE,
            format!("bytes {}-{}/{}", start, end - 1, metadata.length),
        );
    }
    response
        .body(Body::from_stream(ReceiverStream::new(rx)))
        .map_err(|_| unavailable())
}
/// Clock advancement does no provider I/O; preparation remains authenticated and explicit.
pub fn spawn_worker(state: &AppState) {
    let Some(player) = state.dj.as_ref() else {
        return;
    };
    let weak = Arc::downgrade(player);
    let db = state.db.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(1));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            let Some(player) = weak.upgrade() else {
                break;
            };
            if advance(&db, now().max(0) as u64).is_err() {
                tracing::warn!("DJ activity persistence failed");
            }
            if now() / 1000 % 30 == 0 {
                cleanup(&player);
            }
        }
    });
}
fn advance(db: &Arc<Mutex<Connection>>, at: u64) -> Result<(), ApiError> {
    let mut db = db.lock().unwrap();
    let tx = db.transaction()?;
    let rows = {
        let mut q = tx.prepare("SELECT channel_id,state FROM activities LIMIT 30")?;
        let rows = q
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    for (channel, raw) in rows {
        let Ok(mut session) = serde_json::from_str::<Session>(&raw) else {
            continue;
        };
        if let Some(snapshot) = session.tick(at) {
            if snapshot.kind != Kind::Dj {
                continue;
            }
            tx.execute(
                "UPDATE activities SET state=?1 WHERE channel_id=?2",
                params![
                    serde_json::to_string(&session).map_err(|_| unavailable())?,
                    channel
                ],
            )?;
            emit(
                &tx,
                &channel,
                "activity.updated",
                serde_json::to_value(snapshot).map_err(|_| unavailable())?,
            )?;
        }
    }
    tx.commit()?;
    Ok(())
}
fn cleanup(player: &Player) {
    let stale = {
        let db = player.db.lock().unwrap();
        let Ok(mut q)=db.prepare("SELECT d.id,d.created_at,a.state,d.state FROM dj_assets d LEFT JOIN activities a ON a.channel_id=d.channel_id LIMIT 128")else{return;};
        let Ok(rows) = q.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, String>(3)?,
            ))
        }) else {
            return;
        };
        let found = rows
            .filter_map(Result::ok)
            .filter_map(|(id, at, raw, state)| {
                if now() - at
                    < if state == "preparing" {
                        600_000
                    } else {
                        60_000
                    }
                {
                    return None;
                }
                let queued = raw
                    .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
                    .and_then(|v| {
                        v["state"]["queue"]
                            .as_array()
                            .map(|q| q.iter().any(|track| track["id"] == id))
                    })
                    .unwrap_or(false);
                (!queued).then_some(id)
            })
            .collect::<Vec<_>>();
        found
    };
    for id in stale {
        discard(player, &id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use std::{
        io::{Read, Write},
        net::{TcpListener, UdpSocket},
        sync::atomic::{AtomicBool, Ordering},
    };
    use tower::ServiceExt;
    #[test]
    fn sqlite_unsigned_values_preserve_range_checks() {
        let db = Connection::open_in_memory().unwrap();
        for value in [0, 60_000, 960_000, i64::MAX] {
            assert_eq!(
                db.query_row("SELECT ?1", [value], |row| nonnegative_integer(row, 0))
                    .unwrap(),
                value as u64
            );
        }
        assert!(matches!(
            db.query_row("SELECT -1", [], |row| nonnegative_integer(row, 0)),
            Err(rusqlite::Error::IntegralValueOutOfRange(0, -1))
        ));
        assert!(matches!(
            db.query_row("SELECT 'invalid'", [], |row| nonnegative_integer(row, 0)),
            Err(rusqlite::Error::InvalidColumnType(..))
        ));
    }
    struct CleanFixture;
    impl Scanner for CleanFixture {
        fn scan(&self, input: &mut dyn Read) -> std::io::Result<()> {
            let mut bytes = Vec::new();
            input.read_to_end(&mut bytes)?;
            if bytes.get(4..8) != Some(b"ftyp".as_slice()) {
                return Err(std::io::Error::other("fixture expects MP4"));
            }
            Ok(())
        }
    }
    fn wav(seconds: u32) -> Vec<u8> {
        let samples = 8000u32 * seconds;
        let length = samples * 2;
        let mut b = Vec::new();
        b.extend(b"RIFF");
        b.extend((36 + length).to_le_bytes());
        b.extend(b"WAVEfmt ");
        b.extend(16u32.to_le_bytes());
        b.extend(1u16.to_le_bytes());
        b.extend(1u16.to_le_bytes());
        b.extend(8000u32.to_le_bytes());
        b.extend(16000u32.to_le_bytes());
        b.extend(2u16.to_le_bytes());
        b.extend(16u16.to_le_bytes());
        b.extend(b"data");
        b.extend(length.to_le_bytes());
        for i in 0..samples {
            let sample =
                ((i as f32 * 440.0 * std::f32::consts::TAU / 8000.0).sin() * 2000.0) as i16;
            b.extend(sample.to_le_bytes());
        }
        b
    }
    struct Fixture {
        origin: String,
        seen: Arc<Mutex<Vec<String>>>,
        stop: Arc<AtomicBool>,
        thread: Option<std::thread::JoinHandle<()>>,
    }
    impl Fixture {
        fn start() -> Self {
            Self::with_song_seconds(1)
        }
        fn with_song_seconds(seconds: u32) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let origin = format!("http://{}/", listener.local_addr().unwrap());
            let stop = Arc::new(AtomicBool::new(false));
            let exit = stop.clone();
            let seen = Arc::new(Mutex::new(Vec::new()));
            let captured = seen.clone();
            let thread = std::thread::spawn(move || {
                while !exit.load(Ordering::Relaxed) {
                    let Ok((mut socket, _)) = listener.accept() else {
                        std::thread::sleep(Duration::from_millis(5));
                        continue;
                    };
                    socket
                        .set_read_timeout(Some(Duration::from_secs(3)))
                        .unwrap();
                    let mut request = Vec::new();
                    let mut buf = [0u8; 4096];
                    while let Ok(n) = socket.read(&mut buf) {
                        if n == 0 {
                            break;
                        }
                        request.extend_from_slice(&buf[..n]);
                        let text = String::from_utf8_lossy(&request);
                        if let Some(end) = text.find("\r\n\r\n") {
                            let length = text[..end]
                                .lines()
                                .find_map(|line| {
                                    line.to_lowercase()
                                        .strip_prefix("content-length:")
                                        .and_then(|v| v.trim().parse::<usize>().ok())
                                })
                                .unwrap_or(0);
                            if request.len() >= end + 4 + length {
                                break;
                            }
                        }
                        if request.len() > 8192 {
                            break;
                        }
                    }
                    let request = String::from_utf8_lossy(&request).to_string();
                    let bytes = if request.starts_with("GET /audio ") {
                        wav(seconds)
                    } else {
                        serde_json::to_vec(
                            &json!({"choices":[{"message":{"content":"Here comes your song."}}]}),
                        )
                        .unwrap()
                    };
                    captured.lock().unwrap().push(request);
                    let _ = write!(
                        socket,
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        bytes.len()
                    );
                    let _ = socket.write_all(&bytes);
                }
            });
            Self {
                origin,
                seen,
                stop,
                thread: Some(thread),
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Relaxed);
            if let Some(thread) = self.thread.take() {
                thread.join().unwrap();
            }
        }
    }
    struct Peer {
        rtc: str0m::Rtc,
        socket: UdpSocket,
    }
    impl Peer {
        async fn connect(sfu: &housecall_sfu::Sfu, user: &str) -> Self {
            let socket = UdpSocket::bind("127.0.0.1:0").unwrap();
            socket.set_nonblocking(true).unwrap();
            let mut rtc = str0m::Rtc::new(Instant::now());
            rtc.add_local_candidate(
                str0m::Candidate::host(socket.local_addr().unwrap(), "udp").unwrap(),
            )
            .unwrap();
            let mut change = rtc.sdp_api();
            change.add_channel("housecall-signaling".into());
            change.add_media(
                str0m::media::MediaKind::Audio,
                str0m::media::Direction::SendOnly,
                None,
                None,
                None,
            );
            let (offer, pending) = change.apply().unwrap();
            let joined = sfu
                .join("room".into(), user.into(), user.into(), offer)
                .await
                .unwrap();
            rtc.sdp_api().accept_answer(pending, joined.answer).unwrap();
            Self { rtc, socket }
        }
        fn step(&mut self) {
            let _ = self.rtc.handle_input(str0m::Input::Timeout(Instant::now()));
            for _ in 0..256 {
                match self.rtc.poll_output() {
                    Ok(str0m::Output::Timeout(_)) | Err(_) => break,
                    Ok(str0m::Output::Transmit(t)) => {
                        let _ = self.socket.send_to(&t.contents, t.destination);
                    }
                    Ok(str0m::Output::Event(str0m::Event::ChannelData(d))) => {
                        let offer: housecall_sfu::SdpOffer =
                            serde_json::from_slice(&d.data).unwrap();
                        let answer = self.rtc.sdp_api().accept_offer(offer).unwrap();
                        assert!(self
                            .rtc
                            .channel(d.id)
                            .unwrap()
                            .write(false, &serde_json::to_vec(&answer).unwrap())
                            .unwrap());
                    }
                    _ => {}
                }
            }
            let mut buffer = [0u8; 65536];
            while let Ok((n, source)) = self.socket.recv_from(&mut buffer) {
                let input = str0m::Input::Receive(
                    Instant::now(),
                    str0m::net::Receive {
                        proto: str0m::net::Protocol::Udp,
                        source,
                        destination: self.socket.local_addr().unwrap(),
                        contents: (&buffer[..n]).try_into().unwrap(),
                    },
                );
                if self.rtc.accepts(&input) {
                    let _ = self.rtc.handle_input(input);
                }
            }
        }
    }
    struct VoiceFixture {
        stop: Arc<AtomicBool>,
        thread: Option<std::thread::JoinHandle<()>>,
    }
    impl VoiceFixture {
        async fn start(state: &mut AppState) -> Self {
            let db = state.db.clone();
            let sfu=Arc::new(housecall_sfu::Sfu::start("127.0.0.1:0".parse().unwrap(),"127.0.0.1".parse().unwrap(),Arc::new(move|room,user,session|{let db=db.lock().unwrap();member(&db,user,room).is_ok()&&db.query_row("SELECT EXISTS(SELECT 1 FROM sessions WHERE id=?1 AND user_id=?2 AND expires_at>?3)",params![session,user,now()],|r|r.get::<_,bool>(0)).unwrap_or(false)})).unwrap());
            let mut peers = Vec::new();
            for user in ["alice", "bob", "cara"] {
                peers.push(Peer::connect(&sfu, user).await);
            }
            let stop = Arc::new(AtomicBool::new(false));
            let exit = stop.clone();
            let thread = std::thread::spawn(move || {
                while !exit.load(Ordering::Relaxed) {
                    for peer in &mut peers {
                        peer.step();
                    }
                    std::thread::sleep(Duration::from_millis(2));
                }
            });
            state.voice = Some(sfu.clone());
            let deadline = Instant::now() + Duration::from_secs(8);
            loop {
                if sfu
                    .stats("room".into(), "alice".into())
                    .await
                    .unwrap()
                    .iter()
                    .all(|p| p.connected)
                {
                    break;
                }
                assert!(Instant::now() < deadline, "voice fixture did not connect");
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            Self {
                stop,
                thread: Some(thread),
            }
        }
    }
    impl Drop for VoiceFixture {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Relaxed);
            if let Some(thread) = self.thread.take() {
                thread.join().unwrap();
            }
        }
    }
    fn state() -> AppState {
        let state = AppState::new(":memory:", "fixture-setup").unwrap();
        let db = state.db.lock().unwrap();
        init(&db).unwrap();
        db.execute("INSERT INTO channels(id,name,kind)VALUES('room','DJ fixture','voice'),('other','Other','voice')",[]).unwrap();
        for (name, c, joins) in [
            ("alice", 'a', true),
            ("bob", 'b', true),
            ("cara", 'c', true),
            ("outsider", 'd', false),
        ] {
            db.execute(
                "INSERT INTO users(id,username,password,is_owner)VALUES(?1,?1,'unused',0)",
                [name],
            )
            .unwrap();
            db.execute("INSERT INTO sessions(id,user_id,token_hash,device_hash,device_name,created_at,expires_at)VALUES(?1,?1,?2,?3,'fixture',?4,?5)",params![name,crate::hash(&c.to_string().repeat(64)),crate::hash(&"e".repeat(64)),now(),now()+300_000]).unwrap();
            if joins {
                db.execute(
                    "INSERT INTO members(channel_id,user_id)VALUES('room',?1)",
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
        who: Option<char>,
        method: &str,
        path: &str,
        body: Value,
        range: Option<&str>,
    ) -> (StatusCode, Vec<u8>) {
        let mut request = Request::builder()
            .method(method)
            .uri(path)
            .header("content-type", "application/json");
        if let Some(who) = who {
            request = request
                .header(
                    "authorization",
                    format!("Bearer {}", who.to_string().repeat(64)),
                )
                .header("x-device-key", "e".repeat(64));
        }
        if let Some(range) = range {
            request = request.header("range", range);
        }
        let response = crate::app(state.clone(), None)
            .oneshot(request.body(Body::from(body.to_string())).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (status, bytes.to_vec())
    }
    async fn json_call(
        state: &AppState,
        who: char,
        method: &str,
        path: &str,
        body: Value,
    ) -> Value {
        let (status, bytes) = call(state, Some(who), method, path, body, None).await;
        assert!(
            status.is_success(),
            "{status} {}",
            String::from_utf8_lossy(&bytes)
        );
        serde_json::from_slice(&bytes).unwrap()
    }
    #[tokio::test]
    async fn all_dj_routes_reject_anonymous_cross_channel_and_no_voice() {
        let state = state();
        for (method, path) in [
            ("POST", "/api/channels/room/dj/search"),
            ("POST", "/api/channels/room/dj/queue"),
            ("GET", "/api/channels/room/dj/playback"),
            ("GET", "/api/channels/room/dj/audio/unknown"),
            ("GET", "/api/channels/room/dj/audio/unknown/seek"),
        ] {
            assert_eq!(
                call(&state, None, method, path, json!({"query":"fixture"}), None)
                    .await
                    .0,
                StatusCode::UNAUTHORIZED
            );
            assert_eq!(
                call(
                    &state,
                    Some('d'),
                    method,
                    path,
                    json!({"query":"fixture"}),
                    None
                )
                .await
                .0,
                StatusCode::FORBIDDEN
            );
            assert_eq!(
                call(
                    &state,
                    Some('a'),
                    method,
                    path,
                    json!({"query":"fixture"}),
                    None
                )
                .await
                .0,
                StatusCode::SERVICE_UNAVAILABLE
            );
        }
    }
    #[tokio::test]
    async fn three_voice_members_play_scanned_encrypted_fixture_audio_and_advance_together() {
        let provider = Fixture::start();
        let cache = tempfile::tempdir().unwrap();
        let scratch = tempfile::tempdir_in("/dev/shm").unwrap();
        assert!(on_tmpfs(scratch.path()));
        let mut state = state();
        let _voice = VoiceFixture::start(&mut state).await;
        let store = Arc::new(Store::new(cache.path(), [7; 32]).unwrap());
        state.media = Some(store.clone());
        state.scanner = Arc::new(CleanFixture);
        state.dj = Some(Arc::new(Player {
            resolver: Resolver {
                yt_dlp: "unused-fixture".into(),
                spotify_access_token: None,
                js_runtime: "node".into(),
            },
            downloader: AudioDownloader::loopback_fixture(&provider.origin).unwrap(),
            switchboard: Switchboard::loopback(&format!("{}v1/chat/completions", provider.origin))
                .unwrap(),
            tts: Arc::new(PlaceholderTts {
                espeak_ng: "espeak-ng".into(),
            }),
            ffmpeg: "ffmpeg".into(),
            ffprobe: "ffprobe".into(),
            scratch: scratch.path().into(),
            store,
            scanner: state.scanner.clone(),
            db: state.db.clone(),
            produce: tokio::sync::Semaphore::new(1),
            streams: Arc::new(tokio::sync::Semaphore::new(32)),
            generations: Mutex::new(HashMap::new()),
            fixture: Some(ResolvedTrack {
                title: "Fixture tone".into(),
                duration_ms: 1000,
                source: "https://www.youtube.com/watch?v=aaaaaaaaaaa".into(),
                stream_url: format!("{}audio", provider.origin),
            }),
        }));
        json_call(
            &state,
            'a',
            "POST",
            "/api/channels/room/activity",
            json!({"kind":"dj"}),
        )
        .await;
        let search = json_call(
            &state,
            'b',
            "POST",
            "/api/channels/room/dj/search",
            json!({"query":"fixture"}),
        )
        .await;
        assert_eq!(search["results"][0]["title"], "Fixture tone");
        assert!(!search.to_string().contains(&provider.origin));
        let first = json_call(
            &state,
            'a',
            "POST",
            "/api/channels/room/dj/queue",
            json!({"query":"fixture"}),
        )
        .await;
        let first_id = first["track_id"].as_str().unwrap();
        assert!(first["intro_ms"].as_u64().unwrap() > 0);
        // Pause while preparing a second real fixture, avoiding a wall-clock-dependent end during test setup.
        let mut snapshot = json_call(
            &state,
            'a',
            "GET",
            "/api/channels/room/activity",
            json!(null),
        )
        .await;
        json_call(
            &state,
            'a',
            "POST",
            "/api/channels/room/activity/commands",
            json!({"expected_revision":snapshot["revision"],"command":{"type":"pause"}}),
        )
        .await;
        let second = json_call(
            &state,
            'b',
            "POST",
            "/api/channels/room/dj/queue",
            json!({"query":"fixture two"}),
        )
        .await;
        let mut positions = Vec::new();
        for actor in ['a', 'b', 'c'] {
            let descriptor = json_call(
                &state,
                actor,
                "GET",
                "/api/channels/room/dj/playback",
                json!(null),
            )
            .await;
            assert_eq!(descriptor["track"]["id"], first_id);
            positions.push(
                descriptor["activity"]["playback"]["position_ms"]
                    .as_u64()
                    .unwrap(),
            );
            let url = descriptor["track"]["audio_url"].as_str().unwrap();
            let seek_path = format!("{url}/seek?time=1");
            let seek = json_call(&state, actor, "GET", &seek_path, json!(null)).await;
            assert!(seek["duration"].as_f64().unwrap() > 1.0);
            assert!(!seek["fragments"].as_array().unwrap().is_empty());
            assert_eq!(
                call(&state, Some('d'), "GET", &seek_path, json!(null), None)
                    .await
                    .0,
                StatusCode::FORBIDDEN
            );

            let (status, bytes) = call(
                &state,
                Some(actor),
                "GET",
                url,
                json!(null),
                Some("bytes=0-63"),
            )
            .await;
            assert_eq!(status, StatusCode::PARTIAL_CONTENT);
            assert_eq!(bytes.len(), 64);
            assert_eq!(bytes.get(4..8), Some(b"ftyp".as_slice()));
            assert_eq!(
                call(&state, Some('d'), "GET", url, json!(null), None)
                    .await
                    .0,
                StatusCode::FORBIDDEN
            );
        }
        assert!(positions.iter().all(|p| *p == positions[0]));
        // The complete authenticated stream is valid Opus audio (not just a fabricated header).
        let (_, bytes) = call(
            &state,
            Some('c'),
            "GET",
            &format!("/api/channels/room/dj/audio/{first_id}"),
            json!(null),
            None,
        )
        .await;
        let audio = scratch.path().join("decoded-fixture.mp4");
        std::fs::write(&audio, &bytes).unwrap();
        assert!(
            probe_duration(FsPath::new("ffprobe"), &audio)
                .await
                .unwrap()
                > 1000
        );
        snapshot = json_call(
            &state,
            'a',
            "GET",
            "/api/channels/room/activity",
            json!(null),
        )
        .await;
        for actor in ['b', 'c'] {
            snapshot = json_call(
                &state,
                actor,
                "POST",
                "/api/channels/room/activity/commands",
                json!({"expected_revision":snapshot["revision"],"command":{"type":"vote_skip"}}),
            )
            .await;
        }
        assert_eq!(snapshot["playback"]["media_id"], second["track_id"]);
        assert_eq!(
            call(
                &state,
                Some('a'),
                "GET",
                &format!("/api/channels/room/dj/audio/{first_id}"),
                json!(null),
                None
            )
            .await
            .0,
            StatusCode::NOT_FOUND
        );
        {
            let db = state.db.lock().unwrap();
            let raw: String = db
                .query_row(
                    "SELECT state FROM activities WHERE channel_id='room'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            let mut value: Value = serde_json::from_str(&raw).unwrap();
            value["state"]["playback"]["anchored_at_ms"] = json!(now() - 60_000);
            db.execute(
                "UPDATE activities SET state=?1 WHERE channel_id='room'",
                [value.to_string()],
            )
            .unwrap();
        }
        advance(&state.db, now().max(0) as u64).unwrap();
        for actor in ['a', 'b', 'c'] {
            assert!(json_call(
                &state,
                actor,
                "GET",
                "/api/channels/room/dj/playback",
                json!(null)
            )
            .await["track"]
                .is_null());
        }
        {
            let seen = provider.seen.lock().unwrap();
            assert_eq!(seen.len(), 4);
            for request in seen.iter().filter(|r| r.starts_with("POST")) {
                assert!(request
                    .to_lowercase()
                    .contains("x-inference-task: housecall.dj"));
                assert!(request.contains("\"model\":\"role:chat\""));
            }
        }
        let bytes: u64 = state
            .db
            .lock()
            .unwrap()
            .query_row(
                "SELECT SUM(bytes) FROM dj_assets WHERE state='ready'",
                [],
                |r| nonnegative_integer(r, 0),
            )
            .unwrap();
        assert!(bytes > 1000);
        for entry in std::fs::read_dir(cache.path()).unwrap() {
            for chunk in std::fs::read_dir(entry.unwrap().path()).unwrap() {
                let path = chunk.unwrap().path();
                if path.extension().is_some_and(|ext| ext == "chunk") {
                    let encrypted = std::fs::read(path).unwrap();
                    assert_ne!(encrypted.get(4..8), Some(b"ftyp".as_slice()));
                }
            }
        }
        state
            .db
            .lock()
            .unwrap()
            .execute("DELETE FROM sessions WHERE id='bob'", [])
            .unwrap();
        assert_eq!(
            call(
                &state,
                Some('b'),
                "GET",
                "/api/channels/room/dj/playback",
                json!(null),
                None
            )
            .await
            .0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            call(
                &state,
                Some('b'),
                "GET",
                &format!("/api/channels/room/dj/audio/{first_id}/seek"),
                json!(null),
                None
            )
            .await
            .0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            call(
                &state,
                Some('a'),
                "GET",
                &format!("/api/channels/room/dj/audio/{first_id}/seek"),
                json!(null),
                None
            )
            .await
            .0,
            StatusCode::NOT_FOUND
        );
        println!("DJ fixture:3 actual UDP voice connections;2 local espeak introductions+FFmpeg Opus songs;loopback-only Switchboard/CDN;fixture scanner;encrypted cache;authenticated64-byte range and complete audio probe;sharedvotes/naturaladvance;no live providers");
    }
    #[tokio::test]
    #[ignore = "manual isolated three-browser DJ playback fixture; requires quiet host, Vite and Playwright"]
    async fn three_browsers_decode_and_synchronize_dj_fixture() {
        use std::future::IntoFuture;
        use tokio::io::AsyncWriteExt;
        let provider = Fixture::with_song_seconds(90);
        let cache = tempfile::tempdir().unwrap();
        let scratch = tempfile::tempdir_in("/dev/shm").unwrap();
        let mut state = state();
        let _voice = VoiceFixture::start(&mut state).await;
        state.media = Some(Arc::new(Store::new(cache.path(), [9; 32]).unwrap()));
        state.scanner = Arc::new(CleanFixture);
        state.dj = Some(Arc::new(Player {
            resolver: Resolver {
                yt_dlp: "unused-fixture".into(),
                spotify_access_token: None,
                js_runtime: "node".into(),
            },
            downloader: AudioDownloader::loopback_fixture(&provider.origin).unwrap(),
            switchboard: Switchboard::loopback(&format!("{}v1/chat/completions", provider.origin))
                .unwrap(),
            tts: Arc::new(PlaceholderTts {
                espeak_ng: "espeak-ng".into(),
            }),
            ffmpeg: "ffmpeg".into(),
            ffprobe: "ffprobe".into(),
            scratch: scratch.path().into(),
            store: state.media.clone().unwrap(),
            scanner: state.scanner.clone(),
            db: state.db.clone(),
            produce: tokio::sync::Semaphore::new(1),
            streams: Arc::new(tokio::sync::Semaphore::new(32)),
            generations: Mutex::new(HashMap::new()),
            fixture: Some(ResolvedTrack {
                title: "Ninety second fixture tone".into(),
                duration_ms: 90_000,
                source: "https://www.youtube.com/watch?v=aaaaaaaaaaa".into(),
                stream_url: format!("{}audio", provider.origin),
            }),
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let api =
            tokio::spawn(axum::serve(listener, crate::app(state.clone(), None)).into_future());
        let root = FsPath::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let run = Uuid::new_v4().to_string();
        let log =
            std::fs::File::create(root.join(format!("evidence/media-dj-vite-{run}.log"))).unwrap();
        let mut vite = tokio::process::Command::new("node")
            .arg("node_modules/vite/bin/vite.js")
            .args(["--host", "127.0.0.1", "--port", "1424", "--strictPort"])
            .current_dir(root.join("client"))
            .env("HOUSECALL_API", format!("http://{address}"))
            .stdin(Stdio::null())
            .stdout(Stdio::from(log.try_clone().unwrap()))
            .stderr(Stdio::from(log))
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let until = Instant::now() + Duration::from_secs(15);
        loop {
            if reqwest::get("http://127.0.0.1:1424").await.is_ok() {
                break;
            }
            assert!(Instant::now() < until, "Vite fixture failed to start");
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let mut browser = tokio::process::Command::new("node")
            .arg(root.join("server/tests/dj-browser.mjs"))
            .env(
                "HOUSECALL_DJ_RECEIPT",
                root.join(format!("evidence/media-dj-browser-{run}.json")),
            )
            .current_dir(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let config = json!({"origin":"http://127.0.0.1:1424","sessions":(['a','b','c'].into_iter().map(|c|json!({"token":c.to_string().repeat(64),"device_key":"e".repeat(64)})).collect::<Vec<_>>())});
        browser
            .stdin
            .take()
            .unwrap()
            .write_all(config.to_string().as_bytes())
            .await
            .unwrap();
        let output = tokio::time::timeout(Duration::from_secs(120), browser.wait_with_output())
            .await
            .unwrap()
            .unwrap();
        let _ = vite.kill().await;
        api.abort();
        assert!(
            output.status.success(),
            "browser fixture failed: {} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        println!("{}", String::from_utf8_lossy(&output.stdout));
    }
}
