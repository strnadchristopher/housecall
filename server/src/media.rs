use crate::{bad, member, ApiError, ApiResult, AppState, Principal};
use axum::{
    body::{Body, Bytes},
    extract::{DefaultBodyLimit, Path, State},
    http::{HeaderMap, StatusCode},
    response::Response,
    routing::{get, post},
    Extension, Json, Router,
};
use housecall_media::{Error, Upload, MAX_CHUNK};
use rusqlite::OptionalExtension;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{io::Read, sync::Arc};
use uuid::Uuid;
impl From<Error> for ApiError {
    fn from(e: Error) -> Self {
        match e {
            Error::NotFound => Self(StatusCode::NOT_FOUND, "upload not found"),
            Error::TooLarge => Self(StatusCode::PAYLOAD_TOO_LARGE, "upload too large"),
            Error::Capacity => Self(
                StatusCode::INSUFFICIENT_STORAGE,
                "media capacity unavailable",
            ),
            Error::PendingLimit => {
                Self(StatusCode::TOO_MANY_REQUESTS, "too many incomplete uploads")
            }
            Error::Invalid => bad("invalid upload input"),
            Error::Conflict => Self(StatusCode::CONFLICT, "upload offset or state conflict"),
            Error::Quarantined => Self(StatusCode::LOCKED, "media remains quarantined"),
            Error::Io(ref e) if matches!(e.raw_os_error(), Some(28) | Some(122)) => {
                Self(StatusCode::INSUFFICIENT_STORAGE, "media disk is full")
            }
            _ => Self(StatusCode::INTERNAL_SERVER_ERROR, "media storage error"),
        }
    }
}
pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/uploads", post(create))
        .route(
            "/uploads/{id}",
            get(inspect)
                .patch(append)
                .delete(remove)
                .layer(DefaultBodyLimit::max(MAX_CHUNK)),
        )
        .route("/uploads/{id}/complete", post(complete))
        .route("/media/{id}", get(download))
}
fn store(s: &AppState) -> Result<Arc<housecall_media::Store>, ApiError> {
    s.media.clone().ok_or(ApiError(
        StatusCode::SERVICE_UNAVAILABLE,
        "encrypted media storage is not configured",
    ))
}
fn dto(m: Upload) -> Value {
    let scan = m.scan.as_ref().map(|report| json!({"attempt_id":report.attempt_id,"engine":report.engine,"verdict":report.verdict,"reason":report.reason,"coverage":report.coverage,"bytes_consumed":report.bytes_consumed.to_string(),"finished_at_ms":report.finished_at_ms}));
    json!({"id":m.id,"channel_id":m.channel_id,"filename":m.filename,"length":m.length.to_string(),"offset":m.offset.to_string(),"status":m.status,"scan":scan})
}
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, Error> + Send + 'static,
) -> Result<T, ApiError> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "media task failed"))?
        .map_err(Into::into)
}
#[derive(Deserialize)]
struct Create {
    channel_id: String,
    filename: String,
    length: String,
    class: Option<String>,
}
/// Largest sealed upload: 100 MiB of plaintext plus 16 bytes of tag per 4 MiB chunk and the
/// 16-byte stream header allowance (DM-V1 7.2).
const SEALED_MAX: u64 = 104_883_220;
/// Sealed uploads are opaque ciphertext: nothing to scan. The stream is read to its end so the
/// store still checks its own chunk integrity, but no verdict about the content is made.
struct Opaque;
impl housecall_media::Scanner for Opaque {
    fn scan(&self, source: &mut dyn std::io::Read) -> std::io::Result<()> {
        std::io::copy(source, &mut std::io::sink()).map(|_| ())
    }
}
async fn create(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Json(v): Json<Create>,
) -> ApiResult<Value> {
    let length = v
        .length
        .parse::<u64>()
        .map_err(|_| bad("length must be a decimal string"))?;
    let sealed = match v.class.as_deref() {
        None => false,
        Some("sealed") => true,
        Some(_) => return Err(bad("invalid class")),
    };
    {
        let db = s.db.lock().unwrap();
        member(&db, &p.user.id, &v.channel_id)?;
        if sealed {
            if !crate::identity::is_encrypted_dm(&db, &v.channel_id)? {
                return Err(crate::identity::not_available());
            }
            if v.filename != "sealed" {
                return Err(bad("sealed uploads are named sealed"));
            }
            if length > SEALED_MAX {
                return Err(ApiError(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "sealed upload too large",
                ));
            }
        }
    }
    let store = store(&s)?;
    let m = blocking(move || store.create(&p.user.id, &v.channel_id, &v.filename, length)).await?;
    if sealed {
        s.db.lock().unwrap().execute(
            "INSERT INTO sealed_uploads(upload_id) VALUES(?)",
            [m.id.to_string()],
        )?;
    }
    let mut out = dto(m);
    if sealed {
        out["class"] = json!("sealed");
    }
    Ok(Json(out))
}
async fn inspect(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<Uuid>,
) -> ApiResult<Value> {
    let store = store(&s)?;
    let m = blocking(move || store.inspect(id, &p.user.id)).await?;
    Ok(Json(dto(m)))
}
async fn append(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Value> {
    let offset = headers
        .get("upload-offset")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .ok_or_else(|| bad("Upload-Offset is required"))?;
    let store = store(&s)?;
    let m = blocking(move || store.append(id, &p.user.id, offset, &body)).await?;
    Ok(Json(dto(m)))
}
async fn complete(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<Uuid>,
) -> ApiResult<Value> {
    let store = store(&s)?;
    let sealed = crate::identity::is_sealed(&s.db.lock().unwrap(), &id)?;
    let scanner = s.scanner.clone();
    let m = blocking(move || {
        if sealed {
            store.finalize(id, &p.user.id, &Opaque)
        } else {
            store.finalize(id, &p.user.id, scanner.as_ref())
        }
    })
    .await?;
    let mut out = dto(m);
    if sealed {
        out["scan"] = Value::Null;
        out["class"] = json!("sealed");
    }
    Ok(Json(out))
}
async fn remove(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<Uuid>,
) -> ApiResult<Value> {
    let store = store(&s)?;
    store.inspect(id, &p.user.id)?;
    crate::transcode::purge_source(&s.db.lock().unwrap(), &store, id, &p.user.id)?;
    blocking(move || store.delete(id, &p.user.id)).await?;
    Ok(Json(json!({"ok":true})))
}
async fn download(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let store = store(&s)?;
    let metadata_store = store.clone();
    let m = blocking(move || metadata_store.metadata(id)).await?;
    {
        let db = s.db.lock().unwrap();
        member(&db, &p.user.id, &m.channel_id)?;
        // Snap bytes leave only through POST /api/snaps/{id}/open, once per recipient.
        if db
            .query_row(
                "SELECT 1 FROM attachments WHERE upload_id=? AND view_once<>0",
                [id.to_string()],
                |_| Ok(()),
            )
            .optional()?
            .is_some()
        {
            return Err(crate::forbidden());
        }
    }
    authorized_stream(store, m, headers).await
}
/// Caller must authorize either channel membership or owner-only report access.
pub(crate) async fn authorized_stream(
    store: Arc<housecall_media::Store>,
    m: Upload,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let id = m.id;
    let partial = headers.contains_key("range");
    let (start, end) = if let Some(range) = headers.get("range") {
        housecall_media::parse_range(
            range.to_str().map_err(|_| bad("invalid byte range"))?,
            m.length,
        )
        .map_err(|_| ApiError(StatusCode::RANGE_NOT_SATISFIABLE, "invalid byte range"))?
    } else {
        (0, m.length)
    };
    let mut reader = blocking(move || store.read_range(id, start, end)).await?;
    let (sender, receiver) = tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(4);
    tokio::task::spawn_blocking(move || loop {
        let mut chunk = vec![0u8; 64 * 1024];
        match reader.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                chunk.truncate(n);
                if sender.blocking_send(Ok(Bytes::from(chunk))).is_err() {
                    break;
                }
            }
            Err(e) => {
                let _ = sender.blocking_send(Err(e));
                break;
            }
        }
    });
    let mut builder = Response::builder()
        .status(if partial {
            StatusCode::PARTIAL_CONTENT
        } else {
            StatusCode::OK
        })
        .header("content-type", "application/octet-stream")
        .header("content-disposition", "attachment")
        .header("accept-ranges", "bytes")
        .header("content-length", (end - start).to_string());
    if partial {
        builder = builder.header(
            "content-range",
            format!("bytes {}-{}/{}", start, end - 1, m.length),
        );
    }
    builder
        .body(Body::from_stream(
            tokio_stream::wrappers::ReceiverStream::new(receiver),
        ))
        .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "response failed"))
}
