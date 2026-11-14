use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use housecall_media::{Scanner, Store};
use housecall_server::{app, transcode::Processor, AppState};
use http_body_util::BodyExt;
use rusqlite::params;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    io::{self, Read},
    sync::Arc,
    time::Duration,
};
use tower::ServiceExt;
struct Clean;
impl Scanner for Clean {
    fn scan(&self, r: &mut dyn Read) -> io::Result<()> {
        io::copy(r, &mut io::sink())?;
        Ok(())
    }
}
fn hash(s: &str) -> String {
    hex::encode(Sha256::digest(s.as_bytes()))
}
fn fixture(timeout: Duration) -> (tempfile::TempDir, AppState, Router) {
    let dir = tempfile::tempdir().unwrap();
    let mut state = AppState::new(":memory:", "test").unwrap();
    state.media = Some(Arc::new(Store::new(dir.path(), [31; 32]).unwrap()));
    state.scanner = Arc::new(Clean);
    state.transcoder = Some(Arc::new(Processor::new("/usr/bin/ffmpeg", timeout)));
    {
        let db = state.db.lock().unwrap();
        db.execute("INSERT INTO channels(id,name,kind,server_id) VALUES('room','Private','channel','home')",[]).unwrap();
        for (name, token, device) in [
            ("owner", "a", "d"),
            ("friend", "b", "e"),
            ("outsider", "c", "f"),
        ] {
            db.execute(
                "INSERT INTO users(id,username,password,is_owner) VALUES(?,?,?,?)",
                params![name, name, "unused", name == "owner"],
            )
            .unwrap();
            db.execute(
                "INSERT INTO sessions(id,user_id,token_hash,device_hash,device_name,created_at,expires_at) VALUES(?,?,?,?,?,?,?)",
                params![
                    name,
                    name,
                    hash(&token.repeat(64)),
                    hash(&device.repeat(64)),
                    name,
                    0,
                    housecall_server::now() + 600000
                ],
            )
            .unwrap();
        }
        for name in ["owner", "friend"] {
            db.execute("INSERT INTO members VALUES('room',?)", [name])
                .unwrap();
        }
    }
    let router = app(state.clone(), None);
    (dir, state, router)
}
async fn request(
    api: &Router,
    method: &str,
    path: &str,
    user: Option<&str>,
) -> (StatusCode, Vec<u8>, String) {
    let mut b = Request::builder().method(method).uri(path);
    if let Some(user) = user {
        let (token, device) = match user {
            "owner" => ("a", "d"),
            "friend" => ("b", "e"),
            _ => ("c", "f"),
        };
        b = b
            .header("authorization", format!("Bearer {}", token.repeat(64)))
            .header("x-device-key", device.repeat(64));
    }
    let res = api
        .clone()
        .oneshot(b.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = res.status();
    let content_type = res
        .headers()
        .get("content-type")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("")
        .to_string();
    let bytes = res.into_body().collect().await.unwrap().to_bytes().to_vec();
    (status, bytes, content_type)
}
async fn json_req(
    api: &Router,
    method: &str,
    path: &str,
    user: Option<&str>,
) -> (StatusCode, Value) {
    let (s, b, _) = request(api, method, path, user).await;
    (s, serde_json::from_slice(&b).unwrap_or(Value::Null))
}
fn source(state: &AppState, bytes: &[u8]) -> uuid::Uuid {
    let store = state.media.as_ref().unwrap();
    let upload = store
        .create("owner", "room", "original.mp4", bytes.len() as u64)
        .unwrap();
    for chunk in bytes.chunks(housecall_media::MAX_CHUNK) {
        let offset = store.inspect(upload.id, "owner").unwrap().offset;
        store.append(upload.id, "owner", offset, chunk).unwrap();
    }
    store.finalize(upload.id, "owner", &Clean).unwrap();
    upload.id
}
fn video_fixture() -> Vec<u8> {
    let output = std::process::Command::new("/usr/bin/ffmpeg")
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=160x90:rate=10",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000",
            "-t",
            "0.6",
            "-c:v",
            "libx264",
            "-threads",
            "1",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-movflags",
            "+frag_keyframe+empty_moov",
            "-f",
            "mp4",
            "pipe:1",
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    output.stdout
}
async fn terminal(api: &Router, id: &str) -> Value {
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let (s, v) =
                json_req(api, "GET", &format!("/api/media-jobs/{id}"), Some("owner")).await;
            assert_eq!(s, StatusCode::OK);
            if v["status"] == "ready" || v["status"] == "failed" {
                break v;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("job did not finish")
}
fn assert_only_ciphertext(root: &std::path::Path, plain_mp4: &[u8]) {
    fn walk(path: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
        for e in std::fs::read_dir(path).unwrap() {
            let p = e.unwrap().path();
            if p.is_dir() {
                walk(&p, out)
            } else {
                out.push(p)
            }
        }
    }
    let mut files = vec![];
    walk(root, &mut files);
    for p in files {
        let b = std::fs::read(&p).unwrap();
        if p.extension().is_some_and(|e| e == "chunk") {
            assert!(!b.starts_with(&[0xff, 0xd8]));
            assert!(!b.windows(16).any(|w| w == &plain_mp4[..16]));
        } else {
            assert_eq!(p.file_name().unwrap(), "meta.json");
        }
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn actual_ffmpeg_derives_encrypted_fmp4_and_jpeg_with_auth_and_source_lifecycle() {
    let (dir, state, api) = fixture(Duration::from_secs(20));
    let original = video_fixture();
    let source_id = source(&state, &original);
    let start = format!("/api/uploads/{source_id}/derive");
    for (method, path) in [
        ("POST", start.clone()),
        ("GET", "/api/embeds?url=https%3A%2F%2F127.0.0.1%2F".into()),
        ("GET", "/api/media-jobs/id".into()),
        ("GET", "/api/media-jobs/id/video".into()),
        ("GET", "/api/media-jobs/id/video/seek?time=0".into()),
        ("GET", "/api/media-jobs/id/thumbnail".into()),
    ] {
        assert_eq!(
            json_req(&api, method, &path, None).await.0,
            StatusCode::UNAUTHORIZED
        )
    }
    assert!(matches!(
        json_req(
            &api,
            "GET",
            "/api/embeds?url=https%3A%2F%2F127.0.0.1%2F",
            Some("owner")
        )
        .await
        .0,
        StatusCode::BAD_REQUEST | StatusCode::FORBIDDEN
    ));
    assert_eq!(
        json_req(&api, "POST", &start, Some("friend")).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        json_req(&api, "POST", &start, Some("outsider")).await.0,
        StatusCode::NOT_FOUND
    );
    let (status, job) = json_req(&api, "POST", &start, Some("owner")).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{job}");
    let id = job["id"].as_str().unwrap();
    assert_eq!(
        json_req(
            &api,
            "GET",
            &format!("/api/media-jobs/{id}"),
            Some("friend")
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let completed = terminal(&api, id).await;
    assert_eq!(completed["status"], "ready", "{completed}");
    let seek_path = format!("/api/media-jobs/{id}/video/seek?time=0.3");
    let (seek_status, seek) = json_req(&api, "GET", &seek_path, Some("friend")).await;
    assert_eq!(seek_status, StatusCode::OK, "{seek}");
    assert!(seek["duration"].as_f64().unwrap() >= 0.6);
    assert!(!seek["fragments"].as_array().unwrap().is_empty());
    assert_eq!(
        json_req(&api, "GET", &seek_path, None).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        json_req(&api, "GET", &seek_path, Some("outsider")).await.0,
        StatusCode::FORBIDDEN
    );
    for time in ["-1", "NaN", "inf"] {
        assert_eq!(
            json_req(
                &api,
                "GET",
                &format!("/api/media-jobs/{id}/video/seek?time={time}"),
                Some("friend")
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
    }
    let (status, mp4, mime) = request(
        &api,
        "GET",
        completed["video_path"].as_str().unwrap(),
        Some("friend"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(mime, "video/mp4");
    assert!(mp4.windows(4).any(|w| w == b"moof"));
    assert!(mp4.windows(4).any(|w| w == b"moov"));
    let (status, jpeg, mime) = request(
        &api,
        "GET",
        completed["thumbnail_path"].as_str().unwrap(),
        Some("friend"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(mime, "image/jpeg");
    assert!(jpeg.starts_with(&[0xff, 0xd8]));
    assert!(jpeg.ends_with(&[0xff, 0xd9]));
    for suffix in ["video", "thumbnail"] {
        assert_eq!(
            json_req(
                &api,
                "GET",
                &format!("/api/media-jobs/{id}/{suffix}"),
                Some("outsider")
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        )
    }
    // Returned ranges point at real container boundaries from the FFmpeg output.
    let first = &seek["fragments"][0];
    let offset: usize = first["offset"].as_str().unwrap().parse().unwrap();
    let init_end: usize = seek["init_end"].as_str().unwrap().parse().unwrap();
    assert_eq!(&mp4[offset + 4..offset + 8], b"moof");
    assert!(init_end <= offset);
    state
        .db
        .lock()
        .unwrap()
        .execute("DELETE FROM sessions WHERE id='friend'", [])
        .unwrap();
    assert_eq!(
        json_req(&api, "GET", &seek_path, Some("friend")).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_only_ciphertext(dir.path(), &mp4);
    let mut decoder = std::process::Command::new("/usr/bin/ffmpeg")
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            "pipe:0",
            "-f",
            "null",
            "-",
        ])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .spawn()
        .unwrap();
    {
        use std::io::Write;
        decoder.stdin.take().unwrap().write_all(&mp4).unwrap();
    }
    assert!(
        decoder.wait().unwrap().success(),
        "derived MP4 must actually decode"
    );
    assert_eq!(
        json_req(
            &api,
            "DELETE",
            &format!("/api/uploads/{source_id}"),
            Some("owner")
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        json_req(
            &api,
            "GET",
            &format!("/api/media-jobs/{id}/video"),
            Some("owner")
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        json_req(&api, "GET", &seek_path, Some("owner")).await.0,
        StatusCode::CONFLICT
    );
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    println!("actual FFmpeg encrypted derivation: input={} bytes fragmented_mp4={} bytes jpeg={} bytes; decoded successfully; source deletion purged all ciphertext",original.len(),mp4.len(),jpeg.len());
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn scanner_rejection_bad_input_and_timeout_never_publish_derivatives() {
    let (_dir, mut state, _) = fixture(Duration::from_secs(20));
    let bytes = video_fixture();
    let source_id = source(&state, &bytes);
    state.scanner = Arc::new(housecall_media::RejectScanner);
    let api = app(state.clone(), None);
    let (_, j) = json_req(
        &api,
        "POST",
        &format!("/api/uploads/{source_id}/derive"),
        Some("owner"),
    )
    .await;
    let end = terminal(&api, j["id"].as_str().unwrap()).await;
    assert_eq!(end["status"], "failed");
    assert_eq!(end["error"], "scanner_rejected");
    assert!(end["retryable"].as_bool().unwrap());
    assert_eq!(
        json_req(
            &api,
            "GET",
            &format!("/api/media-jobs/{}/video", j["id"].as_str().unwrap()),
            Some("friend")
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let bad = source(&state, b"not a video at all");
    let (_, j) = json_req(
        &api,
        "POST",
        &format!("/api/uploads/{bad}/derive"),
        Some("owner"),
    )
    .await;
    let end = terminal(&api, j["id"].as_str().unwrap()).await;
    assert_eq!(end["status"], "failed");
    assert_ne!(end["error"], Value::Null);
    state.scanner = Arc::new(Clean);
    state.transcoder = Some(Arc::new(Processor::new(
        "/usr/bin/ffmpeg",
        Duration::from_nanos(1),
    )));
    let api = app(state, None);
    let (_, j) = json_req(
        &api,
        "POST",
        &format!("/api/uploads/{source_id}/derive"),
        Some("owner"),
    )
    .await;
    let end = terminal(&api, j["id"].as_str().unwrap()).await;
    assert_eq!(end["error"], "processing_timeout");
}
#[test]
fn restart_marks_jobs_failed_retryable_and_length_finalize_is_server_only() {
    let (_dir, state, _) = fixture(Duration::from_secs(20));
    let db = state.db.lock().unwrap();
    for status in ["queued", "running"] {
        db.execute("INSERT INTO media_jobs(id,source_id,owner_id,channel_id,status,created_at,updated_at) VALUES(?,?,'owner','room',?,0,0)",params![status,"source",status]).unwrap();
    }
    housecall_server::transcode::init(&db).unwrap();
    let count:i64=db.query_row("SELECT COUNT(*) FROM media_jobs WHERE status='failed' AND retryable=1 AND error='interrupted_by_restart'",[],|r|r.get(0)).unwrap();
    assert_eq!(count, 2);
    let store = state.media.as_ref().unwrap();
    let normal = store.create("owner", "room", "normal", 2).unwrap();
    store.append(normal.id, "owner", 0, b"ok").unwrap();
    assert!(store.finish_generated(normal.id, "owner", &Clean).is_err());
    let generated = store
        .create("owner", "room", "generated", u64::MAX)
        .unwrap();
    store.append(generated.id, "owner", 0, b"ok").unwrap();
    let ready = store
        .finish_generated(generated.id, "owner", &Clean)
        .unwrap();
    assert_eq!(ready.length, 2);
    assert_eq!(ready.status, housecall_media::Status::Ready);
}

#[test]
fn deleting_during_scan_does_not_block_other_uploads_or_resurrect_file() {
    struct WaitScanner {
        entered: std::sync::mpsc::Sender<()>,
        release: std::sync::Mutex<std::sync::mpsc::Receiver<()>>,
    }
    impl Scanner for WaitScanner {
        fn scan(&self, r: &mut dyn Read) -> io::Result<()> {
            io::copy(r, &mut io::sink())?;
            self.entered.send(()).unwrap();
            self.release
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(3))
                .unwrap();
            Ok(())
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::new(dir.path(), [4; 32]).unwrap());
    let upload = store.create("owner", "room", "pending", 2).unwrap();
    store.append(upload.id, "owner", 0, b"ok").unwrap();
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let scanner = WaitScanner {
        entered: entered_tx,
        release: std::sync::Mutex::new(release_rx),
    };
    let scan_store = store.clone();
    let scan = std::thread::spawn(move || scan_store.finalize(upload.id, "owner", &scanner));
    entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    let other = store.create("owner", "room", "other", 1).unwrap();
    store.append(other.id, "owner", 0, b"x").unwrap();
    store.delete(upload.id, "owner").unwrap();
    release_tx.send(()).unwrap();
    assert!(scan.join().unwrap().is_err());
    assert!(store.inspect(upload.id, "owner").is_err());
}
