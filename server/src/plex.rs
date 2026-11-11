//! Authorized, same-origin Plex HLS gateway. Provider URLs and credentials never reach clients.
use crate::{activities, emit, now, ApiError, ApiResult, AppState, Principal};
use axum::{
    body::{Body, Bytes},
    extract::{Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Extension, Json, Router,
};
use housecall_activities::{
    plex::{Plex, Resource},
    Kind, Snapshot,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio_stream::wrappers::ReceiverStream;
use uuid::Uuid;
const SESSION_IDLE: Duration = Duration::from_secs(1800);
const MAX_RESOURCES: usize = 32768;
const MAX_SESSION_RESOURCES: usize = 8192;
const MAX_SEGMENT: u64 = 64 * 1024 * 1024;
#[derive(Clone)]
struct Entry {
    playback: String,
    resource: Resource,
    initial: Option<String>,
}
struct Playback {
    id: String,
    media: String,
    subtitle: Option<String>,
    root: String,
    last_used: Instant,
}
#[derive(Default)]
struct Cache {
    rooms: HashMap<String, Playback>,
    resources: HashMap<String, Entry>,
}
pub struct Gateway {
    provider: Arc<Plex>,
    cache: Mutex<Cache>,
    creation: tokio::sync::Mutex<()>,
    streams: Arc<tokio::sync::Semaphore>,
}
impl Gateway {
    pub fn new(provider: Plex) -> Arc<Self> {
        Arc::new(Self {
            provider: Arc::new(provider),
            cache: Mutex::new(Cache::default()),
            creation: tokio::sync::Mutex::new(()),
            streams: Arc::new(tokio::sync::Semaphore::new(32)),
        })
    }
    pub fn stop_channel(&self, channel: &str) {
        let stopped = {
            let mut cache = self.cache.lock().unwrap();
            cache.rooms.remove(channel).map(|p| {
                cache.resources.retain(|_, r| r.playback != p.id);
                p.id
            })
        };
        if let Some(id) = stopped {
            let provider = self.provider.clone();
            tokio::spawn(async move {
                let _ = provider.stop(&id).await;
            });
        }
    }
    fn cleanup(self: &Arc<Self>) {
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(60));
            loop {
                interval.tick().await;
                let Some(gateway) = weak.upgrade() else {
                    break;
                };
                let expired: Vec<String> = {
                    let cache = gateway.cache.lock().unwrap();
                    cache
                        .rooms
                        .iter()
                        .filter(|(_, p)| p.last_used.elapsed() > SESSION_IDLE)
                        .map(|(c, _)| c.clone())
                        .collect()
                };
                for channel in expired {
                    gateway.stop_channel(&channel);
                }
            }
        });
    }
    fn descriptor(channel: &str, p: &Playback) -> Value {
        json!({"playback_id":p.id,"rating_key":p.media,"manifest_url":format!("/api/channels/{channel}/plex/resources/{}",p.root)})
    }
    fn rewrite(
        &self,
        channel: &str,
        playback: &str,
        text: &str,
        base: &url::Url,
    ) -> Result<String, ApiError> {
        let mut cache = self.cache.lock().unwrap();
        if !cache.rooms.get(channel).is_some_and(|p| p.id == playback) {
            return Err(missing());
        }
        let count = cache
            .resources
            .values()
            .filter(|r| r.playback == playback)
            .count();
        let mut additions: HashMap<String, Entry> = HashMap::new();
        let mut known: HashMap<String, String> = cache
            .resources
            .iter()
            .filter(|(_, r)| r.playback == playback)
            .map(|(id, r)| (r.resource.url.to_string(), id.clone()))
            .collect();
        let rewritten = self
            .provider
            .rewrite_manifest(text, base, |resource| {
                let existing = known.get(resource.url.as_str()).cloned();
                let id = match existing {
                    Some(id) => id,
                    None => {
                        if cache.resources.len() + additions.len() >= MAX_RESOURCES
                            || count + additions.len() >= MAX_SESSION_RESOURCES
                        {
                            return Err(housecall_activities::Error::Invalid(
                                "Plex resource capacity",
                            ));
                        }
                        let id = Uuid::new_v4().to_string();
                        known.insert(resource.url.to_string(), id.clone());
                        additions.insert(
                            id.clone(),
                            Entry {
                                playback: playback.into(),
                                resource,
                                initial: None,
                            },
                        );
                        id
                    }
                };
                Ok(format!("/api/channels/{channel}/plex/resources/{id}"))
            })
            .map_err(provider_error)?;
        cache.resources.extend(additions);
        Ok(rewritten)
    }
}
pub fn configure(state: &mut AppState) -> Result<(), String> {
    let origin = std::env::var("PLEX_URL").unwrap_or_default();
    let token = std::env::var("PLEX_TOKEN").unwrap_or_default();
    if origin.is_empty() && token.is_empty() {
        return Ok(());
    }
    if origin.is_empty() || token.is_empty() {
        return Err("set both PLEX_URL and PLEX_TOKEN, or neither".into());
    }
    let gateway =
        Gateway::new(Plex::new(&origin, token).map_err(|_| "invalid Plex configuration")?);
    gateway.cleanup();
    state.plex = Some(gateway);
    Ok(())
}
pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/channels/{id}/plex/sections", get(sections))
        .route("/channels/{id}/plex/items", get(items))
        .route("/channels/{id}/plex/metadata/{rating}", get(metadata))
        .route(
            "/channels/{id}/plex/playback",
            get(current).post(start).delete(stop),
        )
        .route("/channels/{id}/plex/resources/{resource}", get(resource))
}
fn unavailable() -> ApiError {
    ApiError(StatusCode::SERVICE_UNAVAILABLE, "Plex is not configured")
}
fn missing() -> ApiError {
    ApiError(
        StatusCode::NOT_FOUND,
        "Plex playback resource is unavailable",
    )
}
fn provider_error(_: housecall_activities::Error) -> ApiError {
    ApiError(
        StatusCode::BAD_GATEWAY,
        "Plex returned an invalid or unavailable resource",
    )
}
fn gateway(s: &AppState) -> Result<Arc<Gateway>, ApiError> {
    s.plex.clone().ok_or_else(unavailable)
}
async fn authorize(s: &AppState, p: &Principal, channel: &str) -> Result<Snapshot, ApiError> {
    let snapshot = activities::authorized_snapshot(s, p, channel).await?;
    if s.voice.is_none() {
        return Err(ApiError(
            StatusCode::SERVICE_UNAVAILABLE,
            "join a configured voice transport for Plex playback",
        ));
    }
    if snapshot.kind != Kind::Plex {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "start a Plex activity first",
        ));
    }
    Ok(snapshot)
}
async fn sections(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(channel): Path<String>,
) -> ApiResult<Value> {
    authorize(&s, &p, &channel).await?;
    let g = gateway(&s)?;
    Ok(Json(
        json!({"libraries":g.provider.libraries().await.map_err(provider_error)?}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Browse {
    section: String,
    #[serde(default)]
    start: u64,
}
async fn items(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(channel): Path<String>,
    Query(q): Query<Browse>,
) -> ApiResult<Value> {
    authorize(&s, &p, &channel).await?;
    let g = gateway(&s)?;
    Ok(Json(
        json!({"items":g.provider.browse(&q.section,q.start).await.map_err(provider_error)?}),
    ))
}
async fn metadata(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path((channel, rating)): Path<(String, String)>,
) -> ApiResult<Value> {
    authorize(&s, &p, &channel).await?;
    let g = gateway(&s)?;
    Ok(Json(json!(g
        .provider
        .metadata(&rating)
        .await
        .map_err(provider_error)?)))
}
async fn current(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(channel): Path<String>,
) -> ApiResult<Value> {
    let snapshot = authorize(&s, &p, &channel).await?;
    let g = gateway(&s)?;
    let mut cache = g.cache.lock().unwrap();
    let playback = cache
        .rooms
        .get_mut(&channel)
        .filter(|p| {
            Some(&p.media) == snapshot.playback.media_id.as_ref()
                && p.last_used.elapsed() < SESSION_IDLE
        })
        .ok_or_else(missing)?;
    playback.last_used = Instant::now();
    Ok(Json(Gateway::descriptor(&channel, playback)))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Start {
    rating_key: String,
    subtitle_id: Option<String>,
}
async fn start(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(channel): Path<String>,
    Json(input): Json<Start>,
) -> ApiResult<Value> {
    let snapshot = authorize(&s, &p, &channel).await?;
    if snapshot.playback.media_id.as_deref() != Some(&input.rating_key) {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "select this item in the activity first",
        ));
    }
    if input.subtitle_id.is_some() && snapshot.host != p.user.id {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "only the host selects subtitles",
        ));
    }
    let g = gateway(&s)?;
    let _creation = g.creation.lock().await;
    {
        let mut cache = g.cache.lock().unwrap();
        if let Some(playback) = cache.rooms.get_mut(&channel).filter(|v| {
            v.media == input.rating_key
                && (input.subtitle_id.is_none() || v.subtitle == input.subtitle_id)
                && v.last_used.elapsed() < SESSION_IDLE
        }) {
            playback.last_used = Instant::now();
            return Ok(Json(Gateway::descriptor(&channel, playback)));
        }
        if (cache.rooms.len() >= 30 && !cache.rooms.contains_key(&channel))
            || cache.resources.len() >= MAX_RESOURCES
        {
            return Err(ApiError(
                StatusCode::SERVICE_UNAVAILABLE,
                "Plex playback capacity reached",
            ));
        }
    }
    let metadata = g
        .provider
        .metadata(&input.rating_key)
        .await
        .map_err(provider_error)?;
    if input
        .subtitle_id
        .as_ref()
        .is_some_and(|id| !metadata.subtitles.iter().any(|s| &s.id == id))
    {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "subtitle is not part of this item",
        ));
    }
    let id = Uuid::new_v4().to_string();
    let prepared: Result<(Resource, String), ApiError> = async {
        let response = g
            .provider
            .transcode(&input.rating_key, &id, 0, input.subtitle_id.as_deref())
            .await
            .map_err(provider_error)?;
        let source = g
            .provider
            .resource(response.url(), response.url().as_str(), true)
            .map_err(provider_error)?;
        let initial = read_manifest(response).await?;
        let latest = authorize(&s, &p, &channel).await?;
        if latest.playback.media_id.as_deref() != Some(&input.rating_key) {
            return Err(ApiError(StatusCode::CONFLICT, "activity selection changed"));
        }
        Ok((source, initial))
    }
    .await;
    let (source, initial) = match prepared {
        Ok(prepared) => prepared,
        Err(error) => {
            let _ = g.provider.stop(&id).await;
            return Err(error);
        }
    };

    g.stop_channel(&channel);
    let root = Uuid::new_v4().to_string();
    let playback = Playback {
        id: id.clone(),
        media: input.rating_key,
        subtitle: input.subtitle_id,
        root: root.clone(),
        last_used: Instant::now(),
    };
    let descriptor = Gateway::descriptor(&channel, &playback);
    {
        let mut cache = g.cache.lock().unwrap();
        cache.resources.insert(
            root.clone(),
            Entry {
                playback: id.clone(),
                resource: source.clone(),
                initial: Some(initial.clone()),
            },
        );
        cache.rooms.insert(channel.clone(), playback);
    }
    // Validate/register every URI before returning a playable descriptor; commit registration atomically.
    if let Err(error) = g.rewrite(&channel, &id, &initial, &source.url) {
        g.stop_channel(&channel);
        return Err(error);
    }
    {
        let db = s.db.lock().unwrap();
        emit(&db, &channel, "plex.playback", descriptor.clone())?;
    }
    Ok(Json(descriptor))
}
async fn stop(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(channel): Path<String>,
) -> ApiResult<Value> {
    let snapshot = authorize(&s, &p, &channel).await?;
    if snapshot.host != p.user.id {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "only the host stops Plex playback",
        ));
    }
    gateway(&s)?.stop_channel(&channel);
    Ok(Json(json!({"stopped":true})))
}
async fn read_manifest(mut response: reqwest::Response) -> Result<String, ApiError> {
    if !response.status().is_success() || response.content_length().is_some_and(|n| n > 1024 * 1024)
    {
        return Err(provider_error(housecall_activities::Error::Provider));
    }
    let mut data = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| provider_error(housecall_activities::Error::Provider))?
    {
        if data.len() + chunk.len() > 1024 * 1024 {
            return Err(provider_error(housecall_activities::Error::Provider));
        }
        data.extend_from_slice(&chunk);
    }
    String::from_utf8(data).map_err(|_| provider_error(housecall_activities::Error::Provider))
}
async fn resource(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path((channel, id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let snapshot = authorize(&s, &p, &channel).await?;
    let g = gateway(&s)?;
    let entry = {
        let mut cache = g.cache.lock().unwrap();
        let playback = cache
            .rooms
            .get_mut(&channel)
            .filter(|v| {
                Some(&v.media) == snapshot.playback.media_id.as_ref()
                    && v.last_used.elapsed() < SESSION_IDLE
            })
            .ok_or_else(missing)?;
        playback.last_used = Instant::now();
        let playback_id = playback.id.clone();
        let entry = cache
            .resources
            .get_mut(&id)
            .filter(|e| e.playback == playback_id)
            .ok_or_else(missing)?;
        let copy = entry.clone();
        entry.initial = None;
        copy
    };
    let range = headers
        .get(header::RANGE)
        .map(|v| {
            v.to_str()
                .map_err(|_| ApiError(StatusCode::BAD_REQUEST, "invalid range"))
        })
        .transpose()?;
    if entry.resource.playlist && range.is_some() {
        return Err(ApiError(
            StatusCode::RANGE_NOT_SATISFIABLE,
            "manifest ranges are unsupported",
        ));
    }
    if let Some(initial) = entry.initial {
        return manifest_response(g.rewrite(
            &channel,
            &entry.playback,
            &initial,
            &entry.resource.url,
        )?);
    }
    let permit = g
        .streams
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError(StatusCode::TOO_MANY_REQUESTS, "too many Plex streams"))?;
    let response = g
        .provider
        .fetch(&entry.resource, range)
        .await
        .map_err(provider_error)?;
    let mime = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_owned();
    if entry.resource.playlist || mime.to_ascii_lowercase().contains("mpegurl") {
        let url = response.url().clone();
        let text = read_manifest(response).await?;
        drop(permit);
        return manifest_response(g.rewrite(&channel, &entry.playback, &text, &url)?);
    }
    if response.content_length().is_some_and(|n| n > MAX_SEGMENT) {
        return Err(provider_error(housecall_activities::Error::Provider));
    }
    let base_mime = mime
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if !matches!(
        base_mime.as_str(),
        "video/mp2t"
            | "video/mp4"
            | "audio/mp4"
            | "audio/aac"
            | "audio/mpeg"
            | "text/vtt"
            | "application/octet-stream"
            | "application/x-subrip"
    ) {
        return Err(provider_error(housecall_activities::Error::Provider));
    }
    let status = response.status();
    let content_range = response.headers().get(header::CONTENT_RANGE).cloned();
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(2);
    tokio::spawn(async move {
        let _permit = permit;
        let mut response = response;
        let mut total = 0u64;
        let mut last_check = Instant::now() - Duration::from_secs(2);
        loop {
            if last_check.elapsed() >= Duration::from_secs(1) {
                let valid_session = {
                    let db = s.db.lock().unwrap();
                    db.query_row("SELECT EXISTS(SELECT 1 FROM sessions WHERE id=?1 AND user_id=?2 AND expires_at>?3)",rusqlite::params![p.session_id,p.user.id,now()],|r|r.get::<_,bool>(0)).unwrap_or(false)
                };
                let valid_activity = authorize(&s, &p, &channel)
                    .await
                    .is_ok_and(|v| v.playback.media_id == snapshot.playback.media_id);
                let valid_cache = g
                    .cache
                    .lock()
                    .unwrap()
                    .rooms
                    .get(&channel)
                    .is_some_and(|v| v.id == entry.playback);
                if !valid_session || !valid_activity || !valid_cache {
                    let _ = tx
                        .send(Err(std::io::Error::other(
                            "Plex playback authorization revoked",
                        )))
                        .await;
                    break;
                }
                last_check = Instant::now();
            }
            match response.chunk().await {
                Ok(Some(chunk)) => {
                    total = total.saturating_add(chunk.len() as u64);
                    if total > MAX_SEGMENT {
                        let _ = tx
                            .send(Err(std::io::Error::other(
                                "Plex segment exceeds streaming bound",
                            )))
                            .await;
                        break;
                    }
                    if tx.send(Ok(chunk)).await.is_err() {
                        break;
                    }
                }
                Ok(None) => break,
                Err(_) => {
                    let _ = tx
                        .send(Err(std::io::Error::other("Plex segment failed")))
                        .await;
                    break;
                }
            }
        }
    });
    let mut output = (status, Body::from_stream(ReceiverStream::new(rx))).into_response();
    output.headers_mut().insert(
        header::CONTENT_TYPE,
        mime.parse()
            .map_err(|_| provider_error(housecall_activities::Error::Provider))?,
    );
    output
        .headers_mut()
        .insert(header::CACHE_CONTROL, "private, no-store".parse().unwrap());
    output
        .headers_mut()
        .insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
    if let Some(range) = content_range {
        output.headers_mut().insert(header::CONTENT_RANGE, range);
    }
    Ok(output)
}
fn manifest_response(text: String) -> Result<Response, ApiError> {
    Ok((
        [
            (header::CONTENT_TYPE, "application/vnd.apple.mpegurl"),
            (header::CACHE_CONTROL, "private, no-store"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        text,
    )
        .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use tower::ServiceExt;
    fn state() -> AppState {
        let state = AppState::new(":memory:", "fixture").unwrap();
        {
            let db = state.db.lock().unwrap();
            db.execute(
                "INSERT INTO channels(id,name,kind) VALUES('room','Plex fixture','voice')",
                [],
            )
            .unwrap();
            for (name, c, member) in [("alice", 'a', true), ("outsider", 'b', false)] {
                db.execute(
                    "INSERT INTO users(id,username,password,is_owner) VALUES(?1,?1,'unused',0)",
                    [name],
                )
                .unwrap();
                db.execute("INSERT INTO sessions(id,user_id,token_hash,device_hash,device_name,created_at,expires_at) VALUES(?1,?1,?2,?3,'fixture',?4,?5)",rusqlite::params![name,crate::hash(&c.to_string().repeat(64)),crate::hash(&"e".repeat(64)),now(),now()+60000]).unwrap();
                if member {
                    db.execute(
                        "INSERT INTO members(channel_id,user_id) VALUES('room',?1)",
                        [name],
                    )
                    .unwrap();
                }
            }
            let session = housecall_activities::Session::new(
                Kind::Plex,
                "alice".into(),
                ["alice".into()].into(),
                now() as u64,
            )
            .unwrap();
            db.execute(
                "INSERT INTO activities(channel_id,state) VALUES('room',?1)",
                [serde_json::to_string(&session).unwrap()],
            )
            .unwrap();
        }
        state
    }
    #[tokio::test]
    async fn every_plex_route_rejects_anonymous_and_cross_user_before_provider_access() {
        let state = state();
        for (method, path, body) in [
            ("GET", "/api/channels/room/plex/sections", json!(null)),
            (
                "GET",
                "/api/channels/room/plex/items?section=1",
                json!(null),
            ),
            ("GET", "/api/channels/room/plex/metadata/42", json!(null)),
            ("GET", "/api/channels/room/plex/playback", json!(null)),
            (
                "POST",
                "/api/channels/room/plex/playback",
                json!({"rating_key":"42"}),
            ),
            ("DELETE", "/api/channels/room/plex/playback", json!(null)),
            (
                "GET",
                "/api/channels/room/plex/resources/opaque",
                json!(null),
            ),
        ] {
            for (who, expected) in [
                (None, StatusCode::UNAUTHORIZED),
                (Some('b'), StatusCode::FORBIDDEN),
            ] {
                let mut request = Request::builder()
                    .method(method)
                    .uri(path)
                    .header("content-type", "application/json");
                if let Some(c) = who {
                    request = request
                        .header(
                            "authorization",
                            format!("Bearer {}", c.to_string().repeat(64)),
                        )
                        .header("x-device-key", "e".repeat(64));
                }
                let response = crate::app(state.clone(), None)
                    .oneshot(request.body(Body::from(body.to_string())).unwrap())
                    .await
                    .unwrap();
                assert_eq!(response.status(), expected, "{method} {path}");
            }
        }
        let response = crate::app(state, None)
            .oneshot(
                Request::builder()
                    .uri("/api/channels/room/plex/sections")
                    .header("authorization", format!("Bearer {}", "a".repeat(64)))
                    .header("x-device-key", "e".repeat(64))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        assert!(!String::from_utf8_lossy(&bytes).contains("token"));
    }
    #[tokio::test]
    async fn opaque_registry_is_bounded_atomic_and_removed_with_session() {
        let provider = Plex::new("http://127.0.0.1:9", "unused-fixture-token".into()).unwrap();
        let gateway = Gateway::new(provider);
        {
            let mut cache = gateway.cache.lock().unwrap();
            cache.rooms.insert(
                "room".into(),
                Playback {
                    id: "session".into(),
                    media: "42".into(),
                    subtitle: None,
                    root: "root".into(),
                    last_used: Instant::now(),
                },
            );
        }
        let base =
            url::Url::parse("http://127.0.0.1:9/video/:/transcode/universal/session/main.m3u8")
                .unwrap();
        let good = "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\na.ts\n#EXT-X-ENDLIST\n";
        let rewritten = gateway.rewrite("room", "session", good, &base).unwrap();
        assert!(!rewritten.contains("a.ts"));
        assert!(rewritten.contains("/api/channels/room/plex/resources/"));
        assert_eq!(
            gateway.rewrite("room", "session", good, &base).unwrap(),
            rewritten
        );
        assert!(gateway.rewrite("other", "session", good, &base).is_err());
        let bad = "#EXTM3U\nnew.ts\nhttps://evil.invalid/a.ts\n";
        assert!(gateway.rewrite("room", "session", bad, &base).is_err());
        assert_eq!(gateway.cache.lock().unwrap().resources.len(), 1);
        {
            let mut cache = gateway.cache.lock().unwrap();
            for i in 0..MAX_SESSION_RESOURCES {
                cache.resources.insert(
                    format!("fill-{i}"),
                    Entry {
                        playback: "session".into(),
                        resource: gateway
                            .provider
                            .resource(&base, &format!("{i}.ts"), false)
                            .unwrap(),
                        initial: None,
                    },
                );
            }
        }
        assert!(gateway
            .rewrite("room", "session", "#EXTM3U\nextra.ts\n", &base)
            .is_err());
        gateway.stop_channel("room");
        assert!(gateway.cache.lock().unwrap().resources.is_empty());
        assert!(gateway.cache.lock().unwrap().rooms.is_empty());
    }
}
