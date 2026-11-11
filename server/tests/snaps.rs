use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use housecall_server::{app, AppState};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use std::{
    io::{self, Read},
    sync::Arc,
};
use tower::ServiceExt;
use uuid::Uuid;

const SETUP: &str = "bootstrap-long-enough-for-test-secret";
const PHOTO: [u8; 16] = [
    0xFF, 0xD8, 0xFF, 0xE0, 0, 16, b'J', b'F', b'I', b'F', 0, 1, 2, 3, 4, 5,
];

struct Clean;
impl housecall_media::Scanner for Clean {
    fn scan(&self, input: &mut dyn Read) -> io::Result<()> {
        io::copy(input, &mut io::sink())?;
        Ok(())
    }
}
struct Reply {
    status: StatusCode,
    content_type: Option<String>,
    cache: Option<String>,
    bytes: Vec<u8>,
}
impl Reply {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.bytes).unwrap_or(Value::Null)
    }
}
async fn raw(
    api: &Router,
    method: &str,
    path: &str,
    auth: Option<&Value>,
    body: Vec<u8>,
    offset: Option<&str>,
) -> Reply {
    let mut b = Request::builder().method(method).uri(path).header(
        "content-type",
        if method == "PATCH" {
            "application/octet-stream"
        } else {
            "application/json"
        },
    );
    if let Some(a) = auth {
        b = b
            .header(
                "authorization",
                format!("Bearer {}", a["token"].as_str().unwrap()),
            )
            .header("x-device-key", a["device_key"].as_str().unwrap());
    }
    if let Some(offset) = offset {
        b = b.header("upload-offset", offset);
    }
    let response = api
        .clone()
        .oneshot(b.body(Body::from(body)).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let header = |name: &str| {
        response
            .headers()
            .get(name)
            .map(|v| v.to_str().unwrap().to_owned())
    };
    let (content_type, cache) = (header("content-type"), header("cache-control"));
    let bytes = response
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes()
        .to_vec();
    Reply {
        status,
        content_type,
        cache,
        bytes,
    }
}
async fn call(api: &Router, method: &str, path: &str, auth: Option<&Value>, body: Value) -> Reply {
    raw(api, method, path, auth, body.to_string().into_bytes(), None).await
}

struct World {
    api: Router,
    state: AppState,
    store: Arc<housecall_media::Store>,
    owner: Value,
    alice: Value,
    bob: Value,
    outsider: Value,
    channel: String,
    _dir: tempfile::TempDir,
}
async fn join(api: &Router, owner: &Value, name: &str) -> Value {
    let invite = call(
        api,
        "POST",
        "/api/invites",
        Some(owner),
        json!({"email":format!("{name}@example.test"),"expires_in_seconds":60}),
    )
    .await
    .json();
    call(
        api,
        "POST",
        "/api/invites/accept",
        None,
        json!({"token":invite["token"],"username":name,"password":"password-long-enough","device_name":"test"}),
    )
    .await
    .json()
}
/// The owner is the sender. Alice and Bob are the two recipients; the outsider is not in the channel.
async fn world() -> World {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(housecall_media::Store::new(dir.path(), [9; 32]).unwrap());
    let mut state = AppState::new(":memory:", SETUP).unwrap();
    state.media = Some(store.clone());
    state.scanner = Arc::new(Clean);
    state.public_auth_limit = 1000;
    let api = app(state.clone(), None);
    let owner = call(
        &api,
        "POST",
        "/api/setup",
        None,
        json!({"setup_token":SETUP,"username":"owner","password":"password-long-enough","device_name":"test"}),
    )
    .await
    .json();
    let alice = join(&api, &owner, "alice").await;
    let bob = join(&api, &owner, "bob").await;
    let outsider = join(&api, &owner, "carol").await;
    let channel = call(
        &api,
        "POST",
        "/api/channels",
        Some(&owner),
        json!({"name":"snaps","kind":"channel","member_ids":[alice["user"]["id"],bob["user"]["id"]]}),
    )
    .await
    .json();
    World {
        api,
        state,
        store,
        owner,
        alice,
        bob,
        outsider,
        channel: channel["id"].as_str().unwrap().to_owned(),
        _dir: dir,
    }
}
async fn upload(w: &World, filename: &str, bytes: &[u8]) -> String {
    let created = call(
        &w.api,
        "POST",
        "/api/uploads",
        Some(&w.owner),
        json!({"channel_id":w.channel,"filename":filename,"length":bytes.len().to_string()}),
    )
    .await
    .json();
    let id = created["id"].as_str().unwrap().to_owned();
    let path = format!("/api/uploads/{id}");
    assert_eq!(
        raw(
            &w.api,
            "PATCH",
            &path,
            Some(&w.owner),
            bytes.to_vec(),
            Some("0")
        )
        .await
        .status,
        StatusCode::OK
    );
    let done = call(
        &w.api,
        "POST",
        &format!("{path}/complete"),
        Some(&w.owner),
        json!({}),
    )
    .await;
    assert_eq!(done.status, StatusCode::OK, "{}", done.json());
    id
}
async fn send(w: &World, ids: &[&str], view_once: bool, body: &str) -> Reply {
    call(
        &w.api,
        "POST",
        &format!("/api/channels/{}/messages", w.channel),
        Some(&w.owner),
        json!({"body":body,"attachment_ids":ids,"view_once":view_once}),
    )
    .await
}
async fn snap(w: &World) -> (String, String) {
    let id = upload(w, "photo.jpg", &PHOTO).await;
    let sent = send(w, &[&id], true, "").await;
    assert_eq!(sent.status, StatusCode::OK, "{}", sent.json());
    (id, sent.json()["id"].as_str().unwrap().to_owned())
}
async fn open(w: &World, who: &Value, id: &str) -> Reply {
    call(
        &w.api,
        "POST",
        &format!("/api/snaps/{id}/open"),
        Some(who),
        json!({}),
    )
    .await
}
async fn attachment(w: &World, who: &Value, message: &str) -> Value {
    let list = call(
        &w.api,
        "GET",
        &format!("/api/channels/{}/messages", w.channel),
        Some(who),
        json!({}),
    )
    .await
    .json();
    list["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["id"] == message)
        .unwrap()["attachments"][0]
        .clone()
}
fn gone(w: &World, id: &str) -> bool {
    matches!(
        w.store.metadata(Uuid::parse_str(id).unwrap()),
        Err(housecall_media::Error::NotFound)
    )
}

#[tokio::test]
async fn each_recipient_opens_once_and_the_bytes_go_when_everyone_has() {
    let w = world().await;
    let (id, message) = snap(&w).await;
    let before = attachment(&w, &w.alice, &message).await;
    assert_eq!(before["kind"], "snap");
    assert_eq!(before["opened"], false);
    assert_eq!(before["opened_count"], 0);
    assert_eq!(before["recipients"], 2);
    assert!(before.get("video_path").is_none() && before.get("thumbnail_path").is_none());
    assert!(
        !before.to_string().contains("/api/"),
        "no path may leak: {before}"
    );

    let first = open(&w, &w.alice, &id).await;
    assert_eq!(first.status, StatusCode::OK);
    assert_eq!(first.bytes, PHOTO);
    assert_eq!(first.content_type.as_deref(), Some("image/jpeg"));
    assert_eq!(first.cache.as_deref(), Some("no-store"));
    assert_eq!(open(&w, &w.alice, &id).await.status, StatusCode::GONE);

    assert_eq!(attachment(&w, &w.alice, &message).await["opened"], true);
    assert_eq!(attachment(&w, &w.bob, &message).await["opened"], false);
    let sender = attachment(&w, &w.owner, &message).await;
    assert_eq!(
        (sender["opened_count"].clone(), sender["recipients"].clone()),
        (json!(1), json!(2))
    );
    assert!(
        !gone(&w, &id),
        "bytes stay until the last recipient has opened it"
    );

    let second = open(&w, &w.bob, &id).await;
    assert_eq!(second.status, StatusCode::OK);
    assert_eq!(second.bytes, PHOTO);
    assert!(
        gone(&w, &id),
        "the upload is deleted once everyone has opened it"
    );
    assert_eq!(
        attachment(&w, &w.owner, &message).await["kind"],
        "snap_expired"
    );
    assert_eq!(attachment(&w, &w.owner, &message).await["opened_count"], 2);
    assert_eq!(open(&w, &w.bob, &id).await.status, StatusCode::GONE);

    let events = w.state.db.lock().unwrap().query_row(
        "SELECT COUNT(*) FROM events WHERE kind='message.updated'",
        [],
        |r| r.get::<_, i64>(0),
    );
    assert!(events.unwrap() > 0, "opening emits message.updated");
}

#[tokio::test]
async fn media_download_refuses_snaps_for_everyone_and_normal_files_still_download() {
    let w = world().await;
    let (id, _) = snap(&w).await;
    for who in [&w.owner, &w.alice, &w.outsider] {
        assert_eq!(
            call(
                &w.api,
                "GET",
                &format!("/api/media/{id}"),
                Some(who),
                json!({})
            )
            .await
            .status,
            StatusCode::FORBIDDEN
        );
    }
    let plain = upload(&w, "plain.png", &PHOTO).await;
    assert_eq!(
        send(&w, &[&plain], false, "hello").await.status,
        StatusCode::OK
    );
    let got = call(
        &w.api,
        "GET",
        &format!("/api/media/{plain}"),
        Some(&w.alice),
        json!({}),
    )
    .await;
    assert_eq!((got.status, got.bytes), (StatusCode::OK, PHOTO.to_vec()));
    assert_eq!(
        open(&w, &w.alice, &plain).await.status,
        StatusCode::NOT_FOUND,
        "only snaps can be opened"
    );
}

#[tokio::test]
async fn the_sender_and_non_members_cannot_open_and_failed_opens_burn_nothing() {
    let w = world().await;
    let (id, message) = snap(&w).await;
    assert_eq!(open(&w, &w.owner, &id).await.status, StatusCode::FORBIDDEN);
    assert_eq!(
        open(&w, &w.outsider, &id).await.status,
        StatusCode::FORBIDDEN
    );
    let none = Uuid::new_v4().to_string();
    assert_eq!(
        open(&w, &w.alice, &none).await.status,
        StatusCode::NOT_FOUND
    );
    let anonymous = call(
        &w.api,
        "POST",
        &format!("/api/snaps/{id}/open"),
        None,
        json!({}),
    )
    .await;
    assert_eq!(anonymous.status, StatusCode::UNAUTHORIZED);
    assert_eq!(attachment(&w, &w.owner, &message).await["opened_count"], 0);
    assert_eq!(open(&w, &w.alice, &id).await.status, StatusCode::OK);
}

#[tokio::test]
async fn a_snap_is_one_photo() {
    let w = world().await;
    let a = upload(&w, "a.jpg", &PHOTO).await;
    let b = upload(&w, "b.jpg", &PHOTO).await;
    let note = upload(&w, "notes.txt", b"words").await;
    let clip = upload(&w, "loop.gif", &PHOTO).await;
    assert_eq!(
        send(&w, &[], true, "no photo").await.status,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        send(&w, &[&a, &b], true, "").await.status,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        send(&w, &[&note], true, "").await.status,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        send(&w, &[&clip], true, "").await.status,
        StatusCode::BAD_REQUEST
    );
    let ok = send(&w, &[&a], true, "").await;
    assert_eq!(
        ok.status,
        StatusCode::OK,
        "an empty body is fine for a snap"
    );
    assert_eq!(ok.json()["body"], "");
}

#[tokio::test]
async fn an_unopened_snap_expires_after_24_hours() {
    let w = world().await;
    let (id, message) = snap(&w).await;
    let (fresh, message_two) = snap(&w).await;
    w.state
        .db
        .lock()
        .unwrap()
        .execute(
            "UPDATE messages SET created_at=created_at-?1 WHERE id=?2",
            rusqlite::params![25 * 60 * 60 * 1000_i64, message],
        )
        .unwrap();
    assert_eq!(housecall_server::snaps::reap(&w.state).ok(), Some(1));
    assert!(gone(&w, &id));
    assert!(!gone(&w, &fresh), "a recent snap is untouched");
    let expired = attachment(&w, &w.alice, &message).await;
    assert_eq!(
        (expired["kind"].clone(), expired["opened"].clone()),
        (json!("snap_expired"), json!(false))
    );
    assert_eq!(open(&w, &w.alice, &id).await.status, StatusCode::GONE);
    assert_eq!(attachment(&w, &w.alice, &message_two).await["kind"], "snap");
}

#[tokio::test]
async fn opening_an_overdue_snap_deletes_it_instead_of_serving_it() {
    let w = world().await;
    let (id, message) = snap(&w).await;
    w.state
        .db
        .lock()
        .unwrap()
        .execute(
            "UPDATE messages SET created_at=?1 WHERE id=?2",
            rusqlite::params![0_i64, message],
        )
        .unwrap();
    assert_eq!(open(&w, &w.alice, &id).await.status, StatusCode::GONE);
    assert!(gone(&w, &id));
    assert_eq!(attachment(&w, &w.alice, &message).await["opened"], false);
}

#[tokio::test]
async fn unsending_a_snap_removes_its_bytes_and_views() {
    let w = world().await;
    let (id, message) = snap(&w).await;
    assert_eq!(open(&w, &w.alice, &id).await.status, StatusCode::OK);
    let removed = call(
        &w.api,
        "DELETE",
        &format!("/api/messages/{message}"),
        Some(&w.owner),
        json!({}),
    )
    .await;
    assert_eq!(removed.status, StatusCode::OK);
    assert!(gone(&w, &id));
    let views = w.state.db.lock().unwrap().query_row(
        "SELECT COUNT(*) FROM snap_views WHERE upload_id=?",
        [&id],
        |r| r.get::<_, i64>(0),
    );
    assert_eq!(views.unwrap(), 0);
}
