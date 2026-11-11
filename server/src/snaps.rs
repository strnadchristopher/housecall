//! View-once photos. The only way to read snap bytes is `POST /api/snaps/{id}/open`, once per
//! recipient; `GET /api/media/{id}` refuses them. Bytes are deleted once every recipient has
//! opened the snap or after 24 hours, and a tombstone row keeps the message readable.
use crate::{emit, forbidden, member, missing, now, ApiError, AppState, Principal};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::Response,
    routing::post,
    Extension, Router,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::io::Read;
use uuid::Uuid;

/// A snap that nobody opened is deleted this long after it was sent.
pub const LIFETIME_MS: i64 = 24 * 60 * 60 * 1000;
/// `attachments.view_once`: not a snap.
pub const NONE: i64 = 0;
/// `attachments.view_once`: bytes are stored and can still be opened.
pub const LIVE: i64 = 1;
/// `attachments.view_once`: bytes are deleted, the row is a tombstone.
pub const EXPIRED: i64 = 2;

pub fn init(db: &Connection) -> rusqlite::Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS snap_views(upload_id TEXT NOT NULL,user_id TEXT NOT NULL,viewed_at INTEGER NOT NULL,PRIMARY KEY(upload_id,user_id));")?;
    let mut q = db.prepare("PRAGMA table_info(attachments)")?;
    let columns = q
        .query_map([], |r| r.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?;
    if !columns.iter().any(|c| c == "view_once") {
        db.execute(
            "ALTER TABLE attachments ADD COLUMN view_once INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }
    Ok(())
}
pub fn routes() -> Router<AppState> {
    Router::new().route("/snaps/{id}/open", post(open))
}

/// Recipients are the other members of the conversation; viewers who left do not count.
const OPENED: &str = "(SELECT COUNT(*) FROM snap_views v WHERE v.upload_id=a.upload_id AND v.user_id<>m.author_id AND v.user_id IN (SELECT user_id FROM members WHERE channel_id=m.channel_id))";
const RECIPIENTS: &str =
    "(SELECT COUNT(*) FROM members WHERE channel_id=m.channel_id AND user_id<>m.author_id)";

/// The JSON a message carries for a snap attachment: state and counts only, never a path.
pub fn describe(
    db: &Connection,
    upload_id: &str,
    state: i64,
    viewer: &str,
) -> rusqlite::Result<Value> {
    let (opened_count, recipients) = db.query_row(
        &format!("SELECT {OPENED},{RECIPIENTS} FROM attachments a JOIN messages m ON m.id=a.message_id WHERE a.upload_id=?"),
        [upload_id],
        |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
    )?;
    let opened = db
        .query_row(
            "SELECT 1 FROM snap_views WHERE upload_id=? AND user_id=?",
            params![upload_id, viewer],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    Ok(json!({
        "id":upload_id,
        "filename":"Snap",
        "kind":if state == EXPIRED {"snap_expired"} else {"snap"},
        "length":"0",
        "opened":opened,
        "opened_count":opened_count,
        "recipients":recipients,
    }))
}

fn gone() -> ApiError {
    ApiError(StatusCode::GONE, "snap is gone")
}

/// Deletes the bytes of every snap that everyone opened or that is older than 24 hours.
/// Called after each open and hourly. Returns how many snaps were deleted.
pub fn reap(s: &AppState) -> Result<usize, ApiError> {
    let Some(store) = s.media.clone() else {
        return Ok(0);
    };
    let mut db = s.db.lock().unwrap();
    let tx = db.transaction()?;
    let due = {
        let mut q = tx.prepare(&format!("SELECT a.upload_id,m.author_id,m.channel_id,m.id FROM attachments a JOIN messages m ON m.id=a.message_id WHERE a.view_once=?1 AND (m.created_at<?2 OR {OPENED}>={RECIPIENTS})"))?;
        let rows = q
            .query_map(params![LIVE, now() - LIFETIME_MS], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };
    let mut deleted = 0;
    for (upload, author, channel, message) in due {
        let Ok(id) = Uuid::parse_str(&upload) else {
            continue;
        };
        // No media job should exist for a snap, but never leave derived bytes behind.
        if crate::transcode::purge_source(&tx, &store, id, &author).is_err() {
            continue;
        }
        match store.delete(id, &author) {
            Ok(()) | Err(housecall_media::Error::NotFound) => {}
            // Leave the row live so the next pass retries.
            Err(_) => continue,
        }
        tx.execute(
            "UPDATE attachments SET view_once=? WHERE upload_id=?",
            params![EXPIRED, upload],
        )?;
        emit(
            &tx,
            &channel,
            "message.updated",
            json!({"message_id":message}),
        )?;
        deleted += 1;
    }
    tx.commit()?;
    Ok(deleted)
}

/// `reap` touches the filesystem under the DB lock, so request handlers run it off the async runtime.
async fn reap_blocking(s: &AppState) -> Result<usize, ApiError> {
    let state = s.clone();
    tokio::task::spawn_blocking(move || reap(&state))
        .await
        .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "media task failed"))?
}

pub fn spawn_reaper(s: &AppState) {
    let state = s.clone();
    tokio::spawn(async move {
        let mut timer = tokio::time::interval(std::time::Duration::from_secs(3600));
        timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            timer.tick().await;
            let state = state.clone();
            let outcome = tokio::task::spawn_blocking(move || reap(&state)).await;
            if !matches!(outcome, Ok(Ok(_))) {
                tracing::warn!("snap reaper pass failed");
            }
        }
    });
}

struct Target {
    state: i64,
    author: String,
    channel: String,
    message: String,
    created_at: i64,
    filename: String,
}

async fn open(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<Uuid>,
) -> Result<Response, ApiError> {
    let store = s.media.clone().ok_or(ApiError(
        StatusCode::SERVICE_UNAVAILABLE,
        "encrypted media storage is not configured",
    ))?;
    let upload = id.to_string();
    let expired = {
        let mut db = s.db.lock().unwrap();
        let tx = db.transaction()?;
        let target = tx
            .query_row(
                "SELECT a.view_once,m.author_id,m.channel_id,m.id,m.created_at,a.filename FROM attachments a JOIN messages m ON m.id=a.message_id WHERE a.upload_id=? AND a.view_once<>0",
                [&upload],
                |r| {
                    Ok(Target {
                        state: r.get(0)?,
                        author: r.get(1)?,
                        channel: r.get(2)?,
                        message: r.get(3)?,
                        created_at: r.get(4)?,
                        filename: r.get(5)?,
                    })
                },
            )
            .optional()?
            .ok_or_else(missing)?;
        member(&tx, &p.user.id, &target.channel)?;
        if target.author == p.user.id {
            return Err(forbidden());
        }
        if target.state == EXPIRED || target.created_at < now() - LIFETIME_MS {
            None
        } else {
            // The view row is committed before any byte leaves the server.
            let inserted = tx.execute(
                "INSERT OR IGNORE INTO snap_views(upload_id,user_id,viewed_at) VALUES(?,?,?)",
                params![upload, p.user.id, now()],
            )?;
            if inserted == 0 {
                return Err(gone());
            }
            emit(
                &tx,
                &target.channel,
                "message.updated",
                json!({"message_id":target.message}),
            )?;
            tx.commit()?;
            Some(target)
        }
    };
    let Some(target) = expired else {
        reap_blocking(&s).await?;
        return Err(gone());
    };
    let reader_store = store.clone();
    let bytes = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, housecall_media::Error> {
        let length = reader_store.metadata(id)?.length;
        let mut out = Vec::with_capacity(length as usize);
        reader_store
            .read_range(id, 0, length)?
            .read_to_end(&mut out)?;
        Ok(out)
    })
    .await
    .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "media task failed"))?
    .map_err(|e| match e {
        housecall_media::Error::NotFound => gone(),
        other => other.into(),
    })?;
    // Deleting is best effort here; the hourly pass retries any failure.
    let _ = reap_blocking(&s).await;
    let content_type = match target
        .filename
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        Some("avif") => "image/avif",
        _ => "image/jpeg",
    };
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", content_type)
        .header("cache-control", "no-store")
        .header("content-length", bytes.len().to_string())
        .body(axum::body::Body::from(bytes))
        .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "response failed"))
}
