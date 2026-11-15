use crate::{conflict, emit, member, now, ApiError, ApiResult, AppState, Principal};
use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, Path, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, post, put},
    Extension, Json, Router,
};
use rusqlite::{params, Connection};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap},
    sync::{Arc, Mutex},
};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/channels/{id}/voice/join", post(join))
        .route("/channels/{id}/voice/stats", get(stats))
        .route("/channels/{id}/voice/state", put(put_state))
        .route(
            "/channels/{id}/voice/preview",
            put(put_preview).layer(DefaultBodyLimit::max(MAX_PREVIEW_BYTES)),
        )
        .route("/channels/{id}/voice/preview/{user_id}", get(get_preview))
        .route("/voice/rooms", get(rooms))
        .route("/channels/{id}/voice/{peer}", delete(leave))
}

/// A peer the SFU stopped listing is only reaped once it is this old, so a snapshot taken just
/// before a join finished cannot evict the person who just joined.
const REAP_GRACE_MS: i64 = 5_000;

/// What other people see about someone in a call. Memory only: gone on leave, timeout or restart.
#[derive(Clone, Copy)]
pub struct VoiceState {
    pub muted: bool,
    pub deafened: bool,
    pub camera: bool,
    pub sharing: bool,
    pub joined_at: i64,
}
/// A screen-share thumbnail. Memory only.
pub struct Preview {
    pub bytes: Vec<u8>,
    pub stored_at: i64,
}
/// Live call state, keyed by `(channel_id, user_id)`. Lock order: the database first, then these.
#[derive(Default)]
pub struct Live {
    pub states: Mutex<BTreeMap<(String, String), VoiceState>>,
    pub previews: Mutex<HashMap<(String, String), Preview>>,
}
fn state_fields(user: &str, st: &VoiceState) -> Value {
    json!({"user_id":user,"muted":st.muted,"deafened":st.deafened,"camera":st.camera,"sharing":st.sharing,"joined_at":st.joined_at})
}
/// The event and `PUT .../voice/state` payload: the record plus the channel it belongs to.
fn state_payload(room: &str, user: &str, st: &VoiceState) -> Value {
    let mut v = state_fields(user, st);
    v["channel_id"] = json!(room);
    v
}
/// Someone is now in a call. Announces it once per person, however many devices they join from.
pub fn peer_joined(s: &AppState, room: &str, user: &str) {
    let db = s.db.lock().unwrap();
    let fresh = {
        let mut states = s.live.states.lock().unwrap();
        let key = (room.to_owned(), user.to_owned());
        if let std::collections::btree_map::Entry::Vacant(entry) = states.entry(key) {
            let st = VoiceState {
                muted: false,
                deafened: false,
                camera: false,
                sharing: false,
                joined_at: now(),
            };
            entry.insert(st);
            Some(st)
        } else {
            None
        }
    };
    if let Some(st) = fresh {
        let _ = emit(&db, room, "voice.joined", state_payload(room, user, &st));
    }
}
/// Someone is no longer in a call (left, or their connection timed out). Clears their state and
/// preview and announces it. Returns whether they were there.
pub fn peer_left(db: &Connection, live: &Live, room: &str, user: &str) -> bool {
    let key = (room.to_owned(), user.to_owned());
    live.previews.lock().unwrap().remove(&key);
    let was = live.states.lock().unwrap().remove(&key).is_some();
    if was {
        let _ = emit(
            db,
            room,
            "voice.left",
            json!({"channel_id":room,"user_id":user}),
        );
    }
    was
}
/// Drop everyone the SFU no longer lists (`present` is its `(room, user)` list) who has been in
/// for longer than the grace period.
pub fn reconcile(s: &AppState, present: &[(String, String)], at: i64) {
    let gone: Vec<(String, String)> = s
        .live
        .states
        .lock()
        .unwrap()
        .iter()
        .filter(|((room, user), st)| {
            at - st.joined_at > REAP_GRACE_MS
                && !present.iter().any(|(r, u)| r == room && u == user)
        })
        .map(|(k, _)| k.clone())
        .collect();
    if gone.is_empty() {
        return;
    }
    let db = s.db.lock().unwrap();
    for (room, user) in gone {
        peer_left(&db, &s.live, &room, &user);
    }
}
/// Check the SFU every few seconds so a peer that timed out stops showing in the channel.
pub fn spawn_sweeper(s: &AppState) {
    let state = s.clone();
    tokio::spawn(async move {
        let mut timer = tokio::time::interval(std::time::Duration::from_secs(3));
        timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            timer.tick().await;
            let Some(engine) = state.voice.clone() else {
                continue;
            };
            if let Ok(peers) = engine.rooms().await {
                reconcile(&state, &peers, now());
            }
        }
    });
}
/// `GET /api/voice/rooms`: `rooms` is exactly what 0.3.0 returned; `states` is new.
pub fn rooms_json(db: &Connection, live: &Live, user: &str, peers: &[(String, String)]) -> Value {
    let mut rooms: BTreeMap<String, Vec<String>> = Default::default();
    for (room, who) in peers {
        if member(db, user, room).is_err() {
            continue;
        }
        let users = rooms.entry(room.clone()).or_default();
        if !users.contains(who) {
            users.push(who.clone());
        }
    }
    let mut by_room: BTreeMap<String, Vec<(i64, String, Value)>> = Default::default();
    for ((room, who), st) in live.states.lock().unwrap().iter() {
        if member(db, user, room).is_err() {
            continue;
        }
        by_room.entry(room.clone()).or_default().push((
            st.joined_at,
            who.clone(),
            state_fields(who, st),
        ));
    }
    let states: BTreeMap<String, Vec<Value>> = by_room
        .into_iter()
        .map(|(room, mut rows)| {
            rows.sort_by(|a, b| (a.0, &a.1).cmp(&(b.0, &b.1)));
            (room, rows.into_iter().map(|r| r.2).collect())
        })
        .collect();
    json!({"rooms":rooms,"states":states})
}
const MAX_PREVIEW_BYTES: usize = 64 * 1024;
const PREVIEW_INTERVAL_MS: i64 = 10_000;
/// Store a JPEG thumbnail of your own screen share, for the channel's member list. Only while
/// your state says `sharing`, at most one per 10 seconds, memory only.
async fn put_preview(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(room): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Value> {
    let db = s.db.lock().unwrap();
    member(&db, &p.user.id, &room)?;
    let key = (room, p.user.id);
    let sharing = s
        .live
        .states
        .lock()
        .unwrap()
        .get(&key)
        .is_some_and(|st| st.sharing);
    if !sharing {
        return Err(conflict("not sharing a screen"));
    }
    let is_jpeg_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.trim().eq_ignore_ascii_case("image/jpeg"));
    if !is_jpeg_type || !body.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Err(ApiError(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "previews must be image/jpeg",
        ));
    }
    let at = now();
    let mut previews = s.live.previews.lock().unwrap();
    if previews
        .get(&key)
        .is_some_and(|old| at - old.stored_at < PREVIEW_INTERVAL_MS)
    {
        return Err(ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            "one preview every 10 seconds",
        ));
    }
    previews.insert(
        key,
        Preview {
            bytes: body.to_vec(),
            stored_at: at,
        },
    );
    Ok(Json(json!({"ok":true,"stored_at":at})))
}
async fn get_preview(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path((room, user)): Path<(String, String)>,
) -> Result<Response, ApiError> {
    {
        let db = s.db.lock().unwrap();
        member(&db, &p.user.id, &room)?;
    }
    let bytes = s
        .live
        .previews
        .lock()
        .unwrap()
        .get(&(room, user))
        .map(|pv| pv.bytes.clone())
        .ok_or_else(crate::missing)?;
    let mut response = bytes.into_response();
    let h = response.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static("image/jpeg"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    Ok(response)
}
#[derive(Deserialize)]
struct StateBody {
    muted: Option<bool>,
    deafened: Option<bool>,
    camera: Option<bool>,
    sharing: Option<bool>,
}
/// Set your own mute, deafen, camera and share flags while you are in the call. Flags you leave
/// out keep their value.
async fn put_state(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(room): Path<String>,
    Json(v): Json<StateBody>,
) -> ApiResult<Value> {
    let db = s.db.lock().unwrap();
    member(&db, &p.user.id, &room)?;
    let key = (room.clone(), p.user.id.clone());
    let new = {
        let mut states = s.live.states.lock().unwrap();
        let Some(cur) = states.get_mut(&key) else {
            return Err(conflict("not in this call"));
        };
        cur.muted = v.muted.unwrap_or(cur.muted);
        cur.deafened = v.deafened.unwrap_or(cur.deafened);
        cur.camera = v.camera.unwrap_or(cur.camera);
        cur.sharing = v.sharing.unwrap_or(cur.sharing);
        *cur
    };
    if !new.sharing {
        s.live.previews.lock().unwrap().remove(&key);
    }
    let payload = state_payload(&room, &p.user.id, &new);
    emit(&db, &room, "voice.state", payload.clone())?;
    Ok(Json(payload))
}
/// Enable explicitly with the UDP bind address and routable advertised IP from environment.
pub fn configure(state: &mut AppState) -> Result<(), String> {
    let bind = std::env::var("SFU_BIND").ok();
    let public = std::env::var("SFU_PUBLIC_IP").ok();
    match (bind, public) {
        (None, None) => Ok(()),
        (Some(bind), Some(public)) => {
            let bind = bind.parse().map_err(|_| "invalid SFU_BIND")?;
            let public = public.parse().map_err(|_| "invalid SFU_PUBLIC_IP")?;
            let db = state.db.clone();
            let publisher = state.vm_media.clone();
            let authorize: housecall_sfu::Authorize = Arc::new(move |room, user, session| {
                let Ok(db) = db.lock() else {
                    return false;
                };
                if publisher.authorize(&db, room, user, session) {
                    return true;
                }
                db.query_row("SELECT EXISTS(SELECT 1 FROM sessions s JOIN members m ON m.user_id=s.user_id WHERE s.id=?1 AND s.user_id=?2 AND s.expires_at>?3 AND m.channel_id=?4)", params![session, user, now(), room], |r| r.get::<_, bool>(0)).unwrap_or(false)
            });
            let sfu =
                housecall_sfu::Sfu::start(bind, public, authorize).map_err(|e| e.to_string())?;
            tracing::info!(address=%sfu.address(), "private WebRTC SFU enabled");
            state.voice = Some(Arc::new(sfu));
            Ok(())
        }
        _ => Err("set both SFU_BIND and SFU_PUBLIC_IP, or neither".into()),
    }
}
fn engine(s: &AppState) -> Result<Arc<housecall_sfu::Sfu>, ApiError> {
    s.voice.clone().ok_or(ApiError(
        StatusCode::SERVICE_UNAVAILABLE,
        "voice transport is not configured",
    ))
}
fn error(e: housecall_sfu::Error) -> ApiError {
    match e {
        housecall_sfu::Error::Forbidden => {
            ApiError(StatusCode::FORBIDDEN, "voice session unauthorized")
        }
        housecall_sfu::Error::Invalid => ApiError(StatusCode::BAD_REQUEST, "invalid voice offer"),
        housecall_sfu::Error::Busy => {
            ApiError(StatusCode::SERVICE_UNAVAILABLE, "voice capacity reached")
        }
        housecall_sfu::Error::Io => {
            ApiError(StatusCode::INTERNAL_SERVER_ERROR, "voice transport failed")
        }
    }
}
async fn join(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(room): Path<String>,
    Json(offer): Json<Value>,
) -> ApiResult<Value> {
    {
        let db = s.db.lock().unwrap();
        member(&db, &p.user.id, &room)?;
    }
    let engine = engine(&s)?;
    let offer = serde_json::from_value::<housecall_sfu::SdpOffer>(offer)
        .map_err(|_| ApiError(StatusCode::BAD_REQUEST, "invalid SDP offer"))?;
    let joined = engine
        .join(room.clone(), p.user.id.clone(), p.session_id, offer)
        .await
        .map_err(error)?;
    peer_joined(&s, &room, &p.user.id);
    Ok(Json(json!(joined)))
}
/// Who is in a call (`rooms`: user ids only, no peer ids, no diagnostics) and what state each
/// person is in (`states`), per channel the caller belongs to.
async fn rooms(State(s): State<AppState>, Extension(p): Extension<Principal>) -> ApiResult<Value> {
    let peers = match s.voice.clone() {
        Some(engine) => {
            let peers = engine.rooms().await.map_err(error)?;
            reconcile(&s, &peers, now());
            peers
        }
        None => Vec::new(),
    };
    let db = s.db.lock().unwrap();
    Ok(Json(rooms_json(&db, &s.live, &p.user.id, &peers)))
}
async fn stats(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(room): Path<String>,
) -> ApiResult<Value> {
    {
        let db = s.db.lock().unwrap();
        member(&db, &p.user.id, &room)?;
    }
    let stats = engine(&s)?.stats(room, p.session_id).await.map_err(error)?;
    Ok(Json(json!({"peers":stats})))
}
async fn leave(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path((room, peer)): Path<(String, u64)>,
) -> ApiResult<Value> {
    {
        let db = s.db.lock().unwrap();
        member(&db, &p.user.id, &room)?;
    }
    let engine = engine(&s)?;
    engine
        .leave(room.clone(), p.session_id, peer)
        .await
        .map_err(error)?;
    // Someone with two devices in the call is still in it until the last one leaves.
    if let Ok(peers) = engine.rooms().await {
        if !peers.iter().any(|(r, u)| *r == room && *u == p.user.id) {
            let db = s.db.lock().unwrap();
            peer_left(&db, &s.live, &room, &p.user.id);
        }
    }
    Ok(Json(json!({"left":true})))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use tower::ServiceExt;
    #[tokio::test]
    async fn all_voice_routes_require_authentication_and_membership_even_when_disabled() {
        let state = AppState::new(":memory:", "fixture").unwrap();
        {
            let db = state.db.lock().unwrap();
            db.execute("INSERT INTO users(id,username,password,is_owner) VALUES('outsider','outsider','unused',0)", []).unwrap();
            db.execute(
                "INSERT INTO channels(id,name,kind) VALUES('room','Room','channel')",
                [],
            )
            .unwrap();
            db.execute("INSERT INTO sessions(id,user_id,token_hash,device_hash,device_name,created_at,expires_at) VALUES('s','outsider',?1,?2,'fixture',?3,?4)", params![crate::hash(&"a".repeat(64)),crate::hash(&"b".repeat(64)), now(), now()+60_000]).unwrap();
        }
        for (method, path) in [
            ("POST", "/api/channels/room/voice/join"),
            ("GET", "/api/channels/room/voice/stats"),
            ("DELETE", "/api/channels/room/voice/1"),
        ] {
            for authenticated in [false, true] {
                let mut req = Request::builder()
                    .method(method)
                    .uri(path)
                    .header("content-type", "application/json");
                if authenticated {
                    req = req
                        .header("authorization", format!("Bearer {}", "a".repeat(64)))
                        .header("x-device-key", "b".repeat(64));
                }
                let response = crate::app(state.clone(), None)
                    .oneshot(req.body(Body::from("{}")).unwrap())
                    .await
                    .unwrap();
                assert_eq!(
                    response.status(),
                    if authenticated {
                        StatusCode::FORBIDDEN
                    } else {
                        StatusCode::UNAUTHORIZED
                    },
                    "{method} {path}"
                );
            }
        }
    }
}
