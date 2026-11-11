//! Bounded CPU media derivation. Plaintext exists only in memory and FFmpeg pipes.
use crate::{bad, member, missing, ApiError, ApiResult, AppState, Principal};
use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::Response,
    routing::{get, post},
    Extension, Json, Router,
};
use housecall_media::{Scanner, Status, Store, Upload, MAX_CHUNK};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::{io::Read, path::PathBuf, process::Stdio, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
    sync::Semaphore,
};
use uuid::Uuid;

pub struct Processor {
    binary: PathBuf,
    timeout: Duration,
    slot: Semaphore,
}
impl Processor {
    pub fn new(binary: impl Into<PathBuf>, timeout: Duration) -> Self {
        Self {
            binary: binary.into(),
            timeout,
            slot: Semaphore::new(1),
        }
    }
}
pub fn init(db: &Connection) -> rusqlite::Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS media_jobs(id TEXT PRIMARY KEY,source_id TEXT NOT NULL,owner_id TEXT NOT NULL REFERENCES users(id),channel_id TEXT NOT NULL REFERENCES channels(id),status TEXT NOT NULL,error TEXT,retryable INTEGER NOT NULL DEFAULT 0,video_id TEXT,thumbnail_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS media_jobs_source ON media_jobs(source_id); UPDATE media_jobs SET status='failed',error='interrupted_by_restart',retryable=1 WHERE status IN ('queued','running');")
}
pub fn configure(s: &mut AppState) -> Result<(), String> {
    if s.media.is_none() {
        return Ok(());
    }
    let binary = std::env::var("HOUSECALL_FFMPEG").unwrap_or_else(|_| "/usr/bin/ffmpeg".into());
    if !std::path::Path::new(&binary).is_file() {
        return Ok(());
    }
    let seconds = std::env::var("HOUSECALL_TRANSCODE_TIMEOUT_SECONDS")
        .unwrap_or_else(|_| "21600".into())
        .parse::<u64>()
        .map_err(|_| "invalid transcode timeout")?;
    if !(1..=86400).contains(&seconds) {
        return Err("transcode timeout must be 1–86400 seconds".into());
    }
    s.transcoder = Some(Arc::new(Processor::new(
        binary,
        Duration::from_secs(seconds),
    )));
    let db = s.db.lock().map_err(|_| "database unavailable")?;
    let mut q=db.prepare("SELECT owner_id,video_id,thumbnail_id FROM media_jobs WHERE error='interrupted_by_restart'").map_err(|_|"media jobs unavailable")?;
    let jobs = q
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(|_| "media jobs unavailable")?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "media jobs unavailable")?;
    for (owner, video, thumbnail) in jobs {
        for id in [video, thumbnail].into_iter().flatten() {
            if let Ok(id) = Uuid::parse_str(&id) {
                let _ = s.media.as_ref().unwrap().delete(id, &owner);
            }
        }
    }
    Ok(())
}
pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/uploads/{id}/derive", post(start))
        .route("/media-jobs/{id}", get(status))
        .route("/media-jobs/{id}/video", get(video))
        .route("/media-jobs/{id}/video/seek", get(seek))
        .route("/media-jobs/{id}/thumbnail", get(thumbnail))
}
fn unavailable() -> ApiError {
    ApiError(
        StatusCode::SERVICE_UNAVAILABLE,
        "CPU media derivation is not configured",
    )
}
async fn start(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<Uuid>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let store = s.media.clone().ok_or_else(unavailable)?;
    let source = store.inspect(id, &p.user.id)?;
    // A snap's bytes leave only through `/snaps/{id}/open`, never through a media job.
    if s.db.lock().unwrap().query_row(
        "SELECT EXISTS(SELECT 1 FROM attachments WHERE upload_id=? AND view_once<>0)",
        [id.to_string()],
        |r| r.get::<_, bool>(0),
    )? {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "a snap can't be processed into a media job",
        ));
    }
    let engine = s.transcoder.clone().ok_or_else(unavailable)?;
    if source.status != Status::Ready {
        return Err(ApiError(
            StatusCode::LOCKED,
            "source must pass scanning before processing",
        ));
    }
    let job_id = Uuid::new_v4().to_string();
    {
        let mut db = s.db.lock().unwrap();
        let tx = db.transaction()?;
        member(&tx, &p.user.id, &source.channel_id)?;
        if tx.query_row(
            "SELECT COUNT(*) FROM media_jobs WHERE status IN ('queued','running')",
            [],
            |r| r.get::<_, i64>(0),
        )? >= 32
        {
            return Err(ApiError(
                StatusCode::TOO_MANY_REQUESTS,
                "media job queue is full",
            ));
        }
        if tx.query_row("SELECT EXISTS(SELECT 1 FROM media_jobs WHERE source_id=? AND status IN ('queued','running'))",[id.to_string()],|r|r.get::<_,bool>(0))?{return Err(ApiError(StatusCode::CONFLICT,"source is already being processed"))}
        tx.execute("INSERT INTO media_jobs(id,source_id,owner_id,channel_id,status,created_at,updated_at) VALUES(?,?,?,?,'queued',?,?)",params![job_id,id.to_string(),p.user.id,source.channel_id,crate::now(),crate::now()])?;
        tx.commit()?;
    }
    let running_id = job_id.clone();
    tokio::spawn(async move {
        run_job(s, engine, store, running_id, source).await;
    });
    Ok((
        StatusCode::ACCEPTED,
        Json(json!({"id":job_id,"status":"queued"})),
    ))
}
fn job(db: &Connection, id: &str) -> Result<Value, ApiError> {
    db.query_row("SELECT id,source_id,owner_id,channel_id,status,error,retryable,created_at,updated_at FROM media_jobs WHERE id=?",[id],|r|Ok(json!({"id":r.get::<_,String>(0)?,"source_id":r.get::<_,String>(1)?,"owner_id":r.get::<_,String>(2)?,"channel_id":r.get::<_,String>(3)?,"status":r.get::<_,String>(4)?,"error":r.get::<_,Option<String>>(5)?,"retryable":r.get::<_,bool>(6)?,"created_at":r.get::<_,i64>(7)?,"updated_at":r.get::<_,i64>(8)?}))).optional()?.ok_or_else(missing)
}
async fn status(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Value> {
    let db = s.db.lock().unwrap();
    let mut value = job(&db, &id)?;
    if value["owner_id"] != p.user.id {
        return Err(crate::forbidden());
    }
    member(&db, &p.user.id, value["channel_id"].as_str().unwrap())?;
    if value["status"] == "ready" {
        value["video_path"] = json!(format!("/api/media-jobs/{id}/video"));
        value["thumbnail_path"] = json!(format!("/api/media-jobs/{id}/thumbnail"));
    }
    Ok(Json(value))
}
async fn video(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    derived(s, p, id, headers, false).await
}
async fn seek(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
    Query(query): Query<crate::media_index::Query>,
) -> ApiResult<crate::media_index::Window> {
    let output = authorized_output(&s, &p, &id, false)?;
    let store = s.media.clone().ok_or_else(unavailable)?;
    let uid = Uuid::parse_str(&output).map_err(|_| bad("invalid stored derivative"))?;
    let meta = store.metadata(uid)?;
    let window = crate::media_index::lookup(store, meta, query).await?;
    // Index reads run off-thread. Recheck after I/O just as a new range request
    // does, so unsend/revocation during lookup cannot return stale metadata.
    authorized_output(&s, &p, &id, false)?;
    Ok(Json(window))
}
fn authorized_output(
    s: &AppState,
    p: &Principal,
    id: &str,
    thumbnail: bool,
) -> Result<String, ApiError> {
    let db = s.db.lock().unwrap();
    let active: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sessions WHERE id=? AND user_id=? AND expires_at>?)",
        params![p.session_id, p.user.id, crate::now()],
        |r| r.get(0),
    )?;
    if !active {
        return Err(crate::unauthorized());
    }
    let row = job(&db, id)?;
    member(&db, &p.user.id, row["channel_id"].as_str().unwrap())?;
    if row["status"] != "ready" {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "media derivation is not ready",
        ));
    }
    Ok(db.query_row(
        if thumbnail {
            "SELECT thumbnail_id FROM media_jobs WHERE id=?"
        } else {
            "SELECT video_id FROM media_jobs WHERE id=?"
        },
        [id],
        |r| r.get::<_, String>(0),
    )?)
}
async fn thumbnail(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    derived(s, p, id, headers, true).await
}
async fn derived(
    s: AppState,
    p: Principal,
    id: String,
    headers: HeaderMap,
    thumbnail: bool,
) -> Result<Response, ApiError> {
    let output = authorized_output(&s, &p, &id, thumbnail)?;
    let store = s.media.clone().ok_or_else(unavailable)?;
    let uid = Uuid::parse_str(&output).map_err(|_| bad("invalid stored derivative"))?;
    let meta = store.metadata(uid)?;
    let mut response = crate::media::authorized_stream(store, meta, headers).await?;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        if thumbnail { "image/jpeg" } else { "video/mp4" }
            .parse()
            .unwrap(),
    );
    response
        .headers_mut()
        .insert(header::CONTENT_DISPOSITION, "inline".parse().unwrap());
    Ok(response)
}

/// Called under the same DB transaction as source unsend/deletion. Jobs never outlive their source.
pub fn purge_source(
    db: &Connection,
    store: &Store,
    source: Uuid,
    owner: &str,
) -> Result<(), ApiError> {
    let mut q = db
        .prepare("SELECT video_id,thumbnail_id FROM media_jobs WHERE source_id=? AND owner_id=?")?;
    let rows = q
        .query_map(params![source.to_string(), owner], |r| {
            Ok((
                r.get::<_, Option<String>>(0)?,
                r.get::<_, Option<String>>(1)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    db.execute("UPDATE media_jobs SET status='failed',error='source_deleted',retryable=0,updated_at=? WHERE source_id=? AND owner_id=?",params![crate::now(),source.to_string(),owner])?;
    for (video, thumb) in rows {
        for id in [video, thumb].into_iter().flatten() {
            let uid = Uuid::parse_str(&id).map_err(|_| bad("invalid stored derivative"))?;
            match store.delete(uid, owner) {
                Ok(()) | Err(housecall_media::Error::NotFound) => {}
                Err(e) => return Err(e.into()),
            }
        }
    }
    Ok(())
}
fn set_failed(s: &AppState, id: &str, error: &'static str, retryable: bool) {
    let db = s.db.lock().unwrap();
    let _=db.execute("UPDATE media_jobs SET status='failed',error=?,retryable=?,updated_at=? WHERE id=? AND status IN ('queued','running')",params![error,retryable,crate::now(),id]);
}
async fn run_job(
    s: AppState,
    engine: Arc<Processor>,
    store: Arc<Store>,
    id: String,
    source: Upload,
) {
    let Ok(_permit) = engine.slot.acquire().await else {
        return;
    };
    {
        let db = s.db.lock().unwrap();
        if member(&db, &source.owner_id, &source.channel_id).is_err() {
            drop(db);
            set_failed(&s, &id, "membership_revoked", false);
            return;
        }
        if db.execute("UPDATE media_jobs SET status='running',updated_at=? WHERE id=? AND status='queued'",params![crate::now(),id]).unwrap_or(0)!=1{return}
    }
    let video = match store.create(
        &source.owner_id,
        &source.channel_id,
        "playback.mp4",
        u64::MAX,
    ) {
        Ok(v) => v,
        Err(_) => {
            set_failed(&s, &id, "storage_error", true);
            return;
        }
    };
    let thumbnail = match store.create(
        &source.owner_id,
        &source.channel_id,
        "thumbnail.jpg",
        u64::MAX,
    ) {
        Ok(v) => v,
        Err(_) => {
            let _ = store.delete(video.id, &source.owner_id);
            set_failed(&s, &id, "storage_error", true);
            return;
        }
    };
    {
        let db = s.db.lock().unwrap();
        if db
            .execute(
                "UPDATE media_jobs SET video_id=?,thumbnail_id=? WHERE id=? AND status='running'",
                params![video.id.to_string(), thumbnail.id.to_string(), id],
            )
            .unwrap_or(0)
            != 1
        {
            let _ = store.delete(video.id, &source.owner_id);
            let _ = store.delete(thumbnail.id, &source.owner_id);
            return;
        }
    }
    let work = async {
        derive_one(&engine, store.clone(), &source, &video, false).await?;
        derive_one(&engine, store.clone(), &source, &thumbnail, true).await?;
        scan_generated(store.clone(), s.scanner.clone(), video.clone()).await?;
        scan_generated(store.clone(), s.scanner.clone(), thumbnail.clone()).await?;
        Ok::<(), &'static str>(())
    };
    // Even a highly compressed source may already be buffered in FFmpeg. Check
    // authorization independently of pipe progress so deletion/revocation kills it.
    let cancelled = async {
        loop {
            tokio::time::sleep(Duration::from_millis(250)).await;
            let db = s.db.lock().unwrap();
            let running = db
                .query_row(
                    "SELECT status='running' FROM media_jobs WHERE id=?",
                    [&id],
                    |r| r.get::<_, bool>(0),
                )
                .unwrap_or(false);
            if !running || member(&db, &source.owner_id, &source.channel_id).is_err() {
                break;
            }
        }
    };
    let outcome = tokio::select! {
        result = tokio::time::timeout(engine.timeout, work) => result.unwrap_or(Err("processing_timeout")),
        () = cancelled => Err("source_or_membership_removed"),
    };
    if let Err(error) = outcome {
        let _ = store.delete(video.id, &source.owner_id);
        let _ = store.delete(thumbnail.id, &source.owner_id);
        set_failed(&s, &id, error, error != "source_or_membership_removed");
        return;
    }
    let db = s.db.lock().unwrap();
    if member(&db, &source.owner_id, &source.channel_id).is_err()
        || store.inspect(source.id, &source.owner_id).is_err()
    {
        drop(db);
        let _ = store.delete(video.id, &source.owner_id);
        let _ = store.delete(thumbnail.id, &source.owner_id);
        set_failed(&s, &id, "source_or_membership_removed", false);
        return;
    }
    if db.execute("UPDATE media_jobs SET status='ready',error=NULL,retryable=0,updated_at=? WHERE id=? AND status='running'",params![crate::now(),id]).unwrap_or(0)!=1{let _=store.delete(video.id,&source.owner_id);let _=store.delete(thumbnail.id,&source.owner_id);}else{let _=crate::emit(&db,&source.channel_id,"media.ready",json!({"upload_id":source.id,"job_id":id}));}
}
async fn scan_generated(
    store: Arc<Store>,
    scanner: Arc<dyn Scanner>,
    output: Upload,
) -> Result<(), &'static str> {
    tokio::task::spawn_blocking(move || {
        store.finish_generated(output.id, &output.owner_id, scanner.as_ref())
    })
    .await
    .map_err(|_| "storage_error")?
    .map_err(|_| "scanner_rejected")?;
    Ok(())
}
async fn derive_one(
    engine: &Processor,
    store: Arc<Store>,
    source: &Upload,
    output: &Upload,
    thumbnail: bool,
) -> Result<(), &'static str> {
    let mut reader = store
        .read_range(source.id, 0, source.length)
        .map_err(|_| "source_unavailable")?;
    let mut cmd = Command::new(&engine.binary);
    cmd.env_clear().current_dir("/");
    cmd.args([
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        "-max_alloc",
        "67108864",
        "-probesize",
        "8388608",
        "-analyzeduration",
        "10000000",
        "-protocol_whitelist",
        "pipe",
        "-threads",
        "1",
        "-filter_threads",
        "1",
        "-filter_complex_threads",
        "1",
        "-i",
        "pipe:0",
        "-map",
        "0:v:0",
    ]);
    if thumbnail {
        cmd.args([
            "-frames:v",
            "1",
            "-an",
            "-vf",
            "scale=320:-2",
            "-c:v",
            "mjpeg",
            "-threads",
            "1",
            "-f",
            "image2pipe",
            "pipe:1",
        ]);
    } else {
        cmd.args([
            "-map",
            "0:a:0?",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-threads",
            "1",
            "-pix_fmt",
            "yuv420p",
            "-vf",
            "scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
            "-g",
            "60",
            "-force_key_frames",
            "expr:gte(t,n_forced*2)",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-movflags",
            "+frag_keyframe+empty_moov+default_base_moof",
            "-f",
            "mp4",
            "pipe:1",
        ]);
    }
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| "ffmpeg_unavailable")?;
    let mut stdin = child.stdin.take().ok_or("ffmpeg_unavailable")?;
    let mut stdout = child.stdout.take().ok_or("ffmpeg_unavailable")?;
    let (sender, mut receiver) = tokio::sync::mpsc::channel::<Result<Vec<u8>, std::io::Error>>(2);
    tokio::task::spawn_blocking(move || loop {
        let mut bytes = vec![0u8; 64 * 1024];
        match reader.read(&mut bytes) {
            Ok(0) => break,
            Ok(n) => {
                bytes.truncate(n);
                if sender.blocking_send(Ok(bytes)).is_err() {
                    break;
                }
            }
            Err(e) => {
                let _ = sender.blocking_send(Err(e));
                break;
            }
        }
    });
    let input = async move {
        while let Some(chunk) = receiver.recv().await {
            let bytes = chunk.map_err(|_| "source_integrity_error")?;
            if let Err(error) = stdin.write_all(&bytes).await {
                if thumbnail && error.kind() == std::io::ErrorKind::BrokenPipe {
                    return Ok(());
                }
                return Err("input_not_streamable");
            }
        }
        stdin.shutdown().await.map_err(|_| "input_not_streamable")?;
        Ok::<(), &'static str>(())
    };
    let sink_store = store.clone();
    let owner = output.owner_id.clone();
    let uid = output.id;
    let sink = async move {
        let mut offset = 0u64;
        loop {
            let mut bytes = vec![0u8; MAX_CHUNK];
            let mut filled = 0;
            while filled < bytes.len() {
                let n = stdout
                    .read(&mut bytes[filled..])
                    .await
                    .map_err(|_| "output_pipe_failed")?;
                if n == 0 {
                    break;
                }
                filled += n;
            }
            if filled == 0 {
                break;
            }
            bytes.truncate(filled);
            let append = sink_store.clone();
            let user = owner.clone();
            let count = filled as u64;
            tokio::task::spawn_blocking(move || append.append(uid, &user, offset, &bytes))
                .await
                .map_err(|_| "storage_error")?
                .map_err(|_| "storage_error")?;
            offset += count;
            if filled < MAX_CHUNK {
                break;
            }
        }
        if offset == 0 {
            return Err("input_unsupported_or_ffmpeg_failed");
        }
        Ok::<(), &'static str>(())
    };
    let process = async {
        let status = child.wait().await.map_err(|_| "ffmpeg_failed")?;
        if status.success() {
            Ok(())
        } else {
            Err("input_unsupported_or_ffmpeg_failed")
        }
    };
    tokio::try_join!(input, sink, process)?;
    Ok(())
}
