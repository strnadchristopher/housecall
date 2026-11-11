//! Durable ID-only push intents. Provider acceptance never means an OS notification was erased.
use crate::{now, ApiError, ApiResult, AppState, Principal};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::{get, post},
    Extension, Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use openssl::{
    ecdsa::EcdsaSig,
    hash::MessageDigest,
    nid::Nid,
    pkey::{PKey, Private},
    sign::Signer,
    symm::{decrypt_aead, encrypt_aead, Cipher},
};
use rand::RngCore;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    sync::{Arc, Mutex},
    time::{Duration, SystemTime},
};
use uuid::Uuid;
const MAX_EVENTS: i64 = 16384;
const MAX_ATTEMPTS: i64 = 5;
const DAY: i64 = 86400000;
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Kind {
    Apns,
    Fcm,
}
impl Kind {
    fn name(self) -> &'static str {
        match self {
            Self::Apns => "apns",
            Self::Fcm => "fcm",
        }
    }
}
struct Credentials {
    key: PKey<Private>,
    key_id: String,
    issuer: String,
    topic: String,
}
struct CachedToken {
    value: String,
    expires_at: i64,
}
struct Provider {
    kind: Kind,
    origin: url::Url,
    oauth: url::Url,
    credentials: Credentials,
    cached: tokio::sync::Mutex<Option<CachedToken>>,
    fixture: bool,
}
pub struct Worker {
    key: Option<[u8; 32]>,
    providers: Vec<Provider>,
    http: reqwest::Client,
    gate: tokio::sync::Mutex<()>,
}
fn unavailable() -> ApiError {
    ApiError(StatusCode::SERVICE_UNAVAILABLE, "push provider unavailable")
}
fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(10))
        .build()
        .expect("static push HTTP configuration")
}
impl Worker {
    pub fn disabled() -> Arc<Self> {
        Arc::new(Self {
            key: None,
            providers: vec![],
            http: http_client(),
            gate: tokio::sync::Mutex::new(()),
        })
    }
    pub fn is_enabled(&self) -> bool {
        self.key.is_some() && !self.providers.is_empty()
    }
    fn provider(&self, kind: &str) -> Option<&Provider> {
        self.providers.iter().find(|p| p.kind.name() == kind)
    }
    pub async fn tick(&self, db: &Arc<Mutex<Connection>>) -> Result<(), ApiError> {
        if !self.is_enabled() {
            return Ok(());
        }
        let Ok(_gate) = self.gate.try_lock() else {
            return Ok(());
        };
        let event = {
            let mut db = db.lock().unwrap();
            let tx = db.transaction()?;
            let row=tx.query_row("SELECT e.id,e.device_id,e.user_id,e.message_id,e.channel_id,e.kind,e.attempts,e.created_at,d.provider,d.token_cipher FROM push_events e JOIN push_devices d ON d.id=e.device_id WHERE (e.state='queued' AND e.next_at<=?1) OR (e.state='inflight' AND e.lease_until<=?1) ORDER BY CASE e.kind WHEN 'retract' THEN 0 ELSE 1 END,e.next_at,e.created_at LIMIT 1",[now()],|r|Ok(Event{id:r.get(0)?,device:r.get(1)?,user:r.get(2)?,message:r.get(3)?,channel:r.get(4)?,kind:r.get(5)?,attempts:r.get(6)?,created:r.get(7)?,provider:r.get(8)?,cipher:r.get(9)?})).optional()?;
            if let Some(ref e) = row {
                tx.execute("UPDATE push_events SET state='inflight',attempts=attempts+1,lease_until=?1,updated_at=?2 WHERE id=?3",params![now()+30000,now(),e.id])?;
            }
            tx.commit()?;
            row
        };
        let Some(mut e) = event else { return Ok(()) };
        e.attempts += 1;
        if e.attempts > MAX_ATTEMPTS
            || now() - e.created > if e.kind == "alert" { 3600000 } else { 7 * DAY }
        {
            return finish(db, &e, Outcome::Failed("delivery_expired"));
        }
        if !authorized(&db.lock().unwrap(), &e)? {
            return finish(db, &e, Outcome::Failed("authorization_revoked"));
        }
        let Some(provider) = self.provider(&e.provider) else {
            return finish(db, &e, Outcome::Failed("provider_not_configured"));
        };
        let token = match open_token(self.key.as_ref().unwrap(), &e.device, &e.cipher) {
            Ok(v) => v,
            Err(_) => return finish(db, &e, Outcome::Failed("token_key_changed")),
        };
        let bearer = match provider.bearer(&self.http).await {
            Ok(v) => v,
            Err(outcome) => return finish(db, &e, outcome),
        };
        // OAuth/signing can take time; recheck before the external delivery operation.
        if !authorized(&db.lock().unwrap(), &e)? {
            return finish(db, &e, Outcome::Failed("authorization_revoked"));
        }
        let outcome = provider.send(&self.http, &bearer, &token, &e).await;
        finish(db, &e, outcome)
    }
}
struct Event {
    id: String,
    device: String,
    user: String,
    message: String,
    channel: String,
    kind: String,
    attempts: i64,
    created: i64,
    provider: String,
    cipher: Vec<u8>,
}
enum Outcome {
    Accepted,
    Retry(i64, &'static str),
    Failed(&'static str),
    InvalidToken,
}
fn authorized(db: &Connection, e: &Event) -> rusqlite::Result<bool> {
    let valid:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM push_devices d JOIN sessions s ON s.id=d.session_id JOIN members m ON m.user_id=s.user_id AND m.channel_id=?1 WHERE d.id=?2 AND s.user_id=?3 AND s.expires_at>?4)",params![e.channel,e.device,e.user,now()],|r|r.get(0))?;
    if !valid {
        return Ok(false);
    }
    let active: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM push_events WHERE id=?1 AND state='inflight')",
        [&e.id],
        |r| r.get(0),
    )?;
    if !active {
        return Ok(false);
    }
    if e.kind == "alert" {
        db.query_row("SELECT EXISTS(SELECT 1 FROM notifications n JOIN messages m ON m.id=n.message_id WHERE n.message_id=?1 AND n.user_id=?2 AND n.channel_id=?3)",params![e.message,e.user,e.channel],|r|r.get(0))
    } else {
        Ok(true)
    }
}
fn finish(db: &Arc<Mutex<Connection>>, e: &Event, outcome: Outcome) -> Result<(), ApiError> {
    let mut db = db.lock().unwrap();
    let tx = db.transaction()?;
    let exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM push_events WHERE id=?1)",
        [&e.id],
        |r| r.get(0),
    )?;
    if !exists && e.kind == "alert" {
        // Unsend deleted this write-ahead alert while its request was in flight. Never resurrect it.
        // Queue the stable tombstone after the late completion, even if another executor acknowledged it.
        tx.execute("UPDATE push_events SET state='queued',next_at=?1,lease_until=0,updated_at=?1,last_error=NULL WHERE device_id=?2 AND message_id=?3 AND kind='retract'",params![now(),e.device,e.message])?;
        tx.commit()?;
        return Ok(());
    }
    let (state, next, error) = match outcome {
        Outcome::Accepted => ("accepted", 0, None),
        Outcome::Retry(delay, _)
            if now().saturating_add(delay)
                > e.created
                    .saturating_add(if e.kind == "alert" { 3600000 } else { 7 * DAY }) =>
        {
            ("failed", 0, Some("retry_window_expired"))
        }
        Outcome::Retry(delay, reason) if e.attempts < MAX_ATTEMPTS => {
            ("queued", now().saturating_add(delay), Some(reason))
        }
        Outcome::Retry(_, _) => ("failed", 0, Some("retry_limit_reached")),
        Outcome::Failed(reason) => ("failed", 0, Some(reason)),
        Outcome::InvalidToken => {
            tx.execute("DELETE FROM push_devices WHERE id=?1", [&e.device])?;
            tx.commit()?;
            return Ok(());
        }
    };
    tx.execute("UPDATE push_events SET state=?1,next_at=?2,lease_until=0,last_error=?3,updated_at=?4 WHERE id=?5 AND state='inflight'",params![state,next,error,now(),e.id])?;
    tx.commit()?;
    Ok(())
}
pub fn init(db: &Connection) -> rusqlite::Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS push_devices(id TEXT PRIMARY KEY,session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id),provider TEXT NOT NULL CHECK(provider IN ('apns','fcm')),token_hash TEXT NOT NULL,token_cipher BLOB NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(provider,token_hash));
    CREATE TABLE IF NOT EXISTS push_events(id TEXT PRIMARY KEY,device_id TEXT NOT NULL REFERENCES push_devices(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id),message_id TEXT NOT NULL,channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,kind TEXT NOT NULL CHECK(kind IN ('alert','retract')),state TEXT NOT NULL CHECK(state IN ('queued','inflight','accepted','acknowledged','failed')),attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL,lease_until INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,last_error TEXT,UNIQUE(device_id,message_id,kind));
    CREATE INDEX IF NOT EXISTS push_due ON push_events(state,next_at);CREATE INDEX IF NOT EXISTS push_message ON push_events(message_id);
    CREATE TABLE IF NOT EXISTS push_meta(id INTEGER PRIMARY KEY CHECK(id=1),overflow_count INTEGER NOT NULL DEFAULT 0);INSERT OR IGNORE INTO push_meta(id) VALUES(1);")
}
fn insert_event(
    db: &Connection,
    device: &str,
    user: &str,
    message: &str,
    channel: &str,
    kind: &str,
) -> rusqlite::Result<()> {
    if db.query_row(
        "SELECT EXISTS(SELECT 1 FROM push_events WHERE device_id=?1 AND message_id=?2 AND kind=?3)",
        params![device, message, kind],
        |r| r.get::<_, bool>(0),
    )? {
        return Ok(());
    }
    db.execute(
        "DELETE FROM push_events WHERE updated_at<?1 AND state NOT IN ('queued','inflight')",
        [now() - 14 * DAY],
    )?;
    if db.query_row("SELECT count(*) FROM push_events", [], |r| {
        r.get::<_, i64>(0)
    })? >= MAX_EVENTS
    {
        db.execute(
            "UPDATE push_meta SET overflow_count=overflow_count+1 WHERE id=1",
            [],
        )?;
        db.execute("DELETE FROM push_events WHERE id IN (SELECT id FROM push_events WHERE state IN ('accepted','acknowledged','failed') OR (kind='alert' AND ?1='retract') ORDER BY updated_at LIMIT 256)",[kind])?;
        if db.query_row("SELECT count(*) FROM push_events", [], |r| {
            r.get::<_, i64>(0)
        })? >= MAX_EVENTS
        {
            db.execute(
                "UPDATE push_meta SET overflow_count=overflow_count+1 WHERE id=1",
                [],
            )?;
            return Ok(());
        }
    }
    db.execute("INSERT INTO push_events(id,device_id,user_id,message_id,channel_id,kind,state,next_at,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,'queued',?7,?7,?7)",params![Uuid::new_v4().to_string(),device,user,message,channel,kind,now()])?;
    Ok(())
}
/// Call inside the same transaction that inserts a durable mention notification.
pub fn enqueue_alert(
    db: &Connection,
    user: &str,
    message: &str,
    channel: &str,
) -> rusqlite::Result<()> {
    let mut q=db.prepare("SELECT d.id FROM push_devices d JOIN sessions s ON s.id=d.session_id WHERE d.user_id=?1 AND s.expires_at>?2")?;
    let ids = q
        .query_map(params![user, now()], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for device in ids {
        insert_event(db, &device, user, message, channel, "alert")?
    }
    Ok(())
}
/// Call BEFORE message/notification deletion, in that same transaction. No message FK on tombstones.
pub fn enqueue_retract(db: &Connection, message: &str, channel: &str) -> rusqlite::Result<()> {
    let mut q=db.prepare("SELECT DISTINCT d.id,d.user_id FROM push_devices d JOIN sessions s ON s.id=d.session_id WHERE s.expires_at>?1 AND (EXISTS(SELECT 1 FROM notifications n WHERE n.message_id=?2 AND n.user_id=d.user_id) OR EXISTS(SELECT 1 FROM push_events e WHERE e.message_id=?2 AND e.device_id=d.id))")?;
    let devices = q
        .query_map(params![now(), message], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    db.execute(
        "DELETE FROM push_events WHERE message_id=?1 AND kind='alert'",
        [message],
    )?;
    for (device, user) in devices {
        insert_event(db, &device, &user, message, channel, "retract")?
    }
    Ok(())
}
pub fn spawn_worker(s: &AppState) {
    let worker = Arc::downgrade(&s.push);
    let db = s.db.clone();
    tokio::spawn(async move {
        let mut timer = tokio::time::interval(Duration::from_millis(250));
        loop {
            timer.tick().await;
            let Some(worker) = worker.upgrade() else {
                break;
            };
            if worker.tick(&db).await.is_err() {
                tracing::warn!("push outbox database operation failed");
            }
        }
    });
}
pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/push/device", get(device).put(register).delete(unregister))
        .route("/push/events", get(events))
        .route("/push/events/{id}/ack", post(acknowledge))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Registration {
    provider: Kind,
    token: String,
}
fn token_valid(kind: Kind, token: &str) -> bool {
    match kind {
        Kind::Apns => {
            (32..=512).contains(&token.len())
                && token.len().is_multiple_of(2)
                && token.bytes().all(|b| b.is_ascii_hexdigit())
        }
        Kind::Fcm => {
            (32..=4096).contains(&token.len())
                && token
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_:".contains(&b))
        }
    }
}
async fn register(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Json(input): Json<Registration>,
) -> ApiResult<Value> {
    let key = s.push.key.as_ref().ok_or_else(unavailable)?;
    if s.push.provider(input.provider.name()).is_none() {
        return Err(unavailable());
    }
    if !token_valid(input.provider, &input.token) {
        return Err(crate::bad("invalid push token"));
    }
    let mut db = s.db.lock().unwrap();
    let tx = db.transaction()?;
    tx.execute("DELETE FROM push_devices WHERE session_id IN (SELECT id FROM sessions WHERE expires_at<=?1)",[now()])?;
    // APNs tokens are hexadecimal bytes: casing must not bypass unique device binding.
    let token = if input.provider == Kind::Apns {
        input.token.to_ascii_lowercase()
    } else {
        input.token
    };
    let token_hash = crate::hash(&token);
    let existing: Option<(String, String)> = tx
        .query_row(
            "SELECT id,session_id FROM push_devices WHERE provider=?1 AND token_hash=?2",
            params![input.provider.name(), token_hash],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    if existing
        .as_ref()
        .is_some_and(|(_, session)| session != &p.session_id)
    {
        return Err(crate::conflict(
            "push token belongs to another active session",
        ));
    }
    let id = if let Some((id, _)) = existing {
        id
    } else {
        tx.execute(
            "DELETE FROM push_devices WHERE session_id=?1 AND user_id=?2",
            params![p.session_id, p.user.id],
        )?;
        if tx.query_row("SELECT count(*) FROM push_devices", [], |r| {
            r.get::<_, i64>(0)
        })? >= 512
        {
            return Err(ApiError(
                StatusCode::TOO_MANY_REQUESTS,
                "push device capacity reached",
            ));
        }
        Uuid::new_v4().to_string()
    };
    let cipher = seal_token(key, &id, &token).map_err(|_| unavailable())?;
    tx.execute("INSERT INTO push_devices VALUES(?1,?2,?3,?4,?5,?6,?7,?7) ON CONFLICT(id) DO UPDATE SET token_cipher=excluded.token_cipher,updated_at=excluded.updated_at",params![id,p.session_id,p.user.id,input.provider.name(),token_hash,cipher,now()])?;
    tx.commit()?;
    Ok(Json(
        json!({"registered":true,"id":id,"provider":input.provider,"delivery_enabled":true}),
    ))
}
async fn device(State(s): State<AppState>, Extension(p): Extension<Principal>) -> ApiResult<Value> {
    let db = s.db.lock().unwrap();
    let row=db.query_row("SELECT id,provider,updated_at FROM push_devices WHERE session_id=?1 AND user_id=?2",params![p.session_id,p.user.id],|r|Ok(json!({"id":r.get::<_,String>(0)?,"provider":r.get::<_,String>(1)?,"updated_at":r.get::<_,i64>(2)?}))).optional()?;
    Ok(Json(
        json!({"registered":row.is_some(),"device":row,"delivery_enabled":s.push.is_enabled()}),
    ))
}
async fn unregister(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
) -> ApiResult<Value> {
    s.db.lock().unwrap().execute(
        "DELETE FROM push_devices WHERE session_id=?1 AND user_id=?2",
        params![p.session_id, p.user.id],
    )?;
    Ok(Json(json!({"ok":true})))
}
async fn events(State(s): State<AppState>, Extension(p): Extension<Principal>) -> ApiResult<Value> {
    let db = s.db.lock().unwrap();
    let mut q=db.prepare("SELECT e.id,e.message_id,e.channel_id,e.kind,e.state,e.attempts,e.last_error,e.updated_at FROM push_events e JOIN push_devices d ON d.id=e.device_id WHERE d.session_id=?1 AND d.user_id=?2 ORDER BY CASE e.state WHEN 'acknowledged' THEN 1 ELSE 0 END,CASE e.kind WHEN 'retract' THEN 0 ELSE 1 END,e.updated_at DESC,e.id LIMIT 101")?;
    let mut rows=q.query_map(params![p.session_id,p.user.id],|r|{let kind:String=r.get(3)?;let state:String=r.get(4)?;Ok(json!({"id":r.get::<_,String>(0)?,"message_id":r.get::<_,String>(1)?,"channel_id":r.get::<_,String>(2)?,"kind":kind,"epoch":if kind=="retract" {1}else{0},"state":state,"attempts":r.get::<_,i64>(5)?,"error":r.get::<_,Option<String>>(6)?,"updated_at":r.get::<_,i64>(7)?,"retraction_pending":kind=="retract"&&state!="acknowledged"}))})?.collect::<rusqlite::Result<Vec<_>>>()?;
    let history_truncated = rows.len() > 100;
    rows.truncate(100);
    let overflow: i64 =
        db.query_row("SELECT overflow_count FROM push_meta WHERE id=1", [], |r| {
            r.get(0)
        })?;
    Ok(Json(
        json!({"events":rows,"history_truncated":history_truncated,"reconciliation_required":overflow>0 || history_truncated}),
    ))
}
async fn acknowledge(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Value> {
    let changed=s.db.lock().unwrap().execute("UPDATE push_events SET state='acknowledged',updated_at=?1 WHERE id=?2 AND device_id IN (SELECT id FROM push_devices WHERE session_id=?3 AND user_id=?4)",params![now(),id,p.session_id,p.user.id])?;
    if changed == 0 {
        return Err(crate::missing());
    }
    Ok(Json(json!({"ok":true})))
}
fn seal_token(
    key: &[u8; 32],
    device: &str,
    token: &str,
) -> Result<Vec<u8>, openssl::error::ErrorStack> {
    let mut nonce = [0u8; 12];
    rand::rngs::OsRng.fill_bytes(&mut nonce);
    let mut tag = [0u8; 16];
    let cipher = encrypt_aead(
        Cipher::aes_256_gcm(),
        key,
        Some(&nonce),
        device.as_bytes(),
        token.as_bytes(),
        &mut tag,
    )?;
    Ok([nonce.to_vec(), tag.to_vec(), cipher].concat())
}
fn open_token(key: &[u8; 32], device: &str, cipher: &[u8]) -> Result<String, ()> {
    if cipher.len() < 28 {
        return Err(());
    }
    let plain = decrypt_aead(
        Cipher::aes_256_gcm(),
        key,
        Some(&cipher[..12]),
        device.as_bytes(),
        &cipher[28..],
        &cipher[12..28],
    )
    .map_err(|_| ())?;
    String::from_utf8(plain).map_err(|_| ())
}
fn jwt(c: &Credentials, kind: Kind, at: i64) -> Result<String, ()> {
    let header =
        json!({"alg":if kind==Kind::Apns {"ES256"}else{"RS256"},"kid":c.key_id,"typ":"JWT"});
    let claims = if kind == Kind::Apns {
        json!({"iss":c.issuer,"iat":at})
    } else {
        json!({"iss":c.issuer,"scope":"https://www.googleapis.com/auth/firebase.messaging","aud":"https://oauth2.googleapis.com/token","iat":at,"exp":at+3600})
    };
    let input = format!(
        "{}.{}",
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&header).map_err(|_| ())?),
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).map_err(|_| ())?)
    );
    let mut signer = Signer::new(MessageDigest::sha256(), &c.key).map_err(|_| ())?;
    signer.update(input.as_bytes()).map_err(|_| ())?;
    let signed = signer.sign_to_vec().map_err(|_| ())?;
    let signature = if kind == Kind::Apns {
        let parsed = EcdsaSig::from_der(&signed).map_err(|_| ())?;
        let mut out = vec![0u8; 64];
        for (start, n) in [(0, parsed.r()), (32, parsed.s())] {
            let bytes = n.to_vec();
            if bytes.len() > 32 {
                return Err(());
            }
            out[start + 32 - bytes.len()..start + 32].copy_from_slice(&bytes);
        }
        out
    } else {
        signed
    };
    Ok(format!("{input}.{}", URL_SAFE_NO_PAD.encode(signature)))
}
async fn bounded_body(mut response: reqwest::Response) -> Result<Vec<u8>, ()> {
    if response.content_length().is_some_and(|n| n > 65536) {
        return Err(());
    }
    let mut out = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| ())? {
        if out.len() + chunk.len() > 65536 {
            return Err(());
        }
        out.extend_from_slice(&chunk);
    }
    Ok(out)
}
fn retry_after(headers: &reqwest::header::HeaderMap, attempt: i64) -> i64 {
    let fallback = (60000_i64.saturating_mul(1_i64 << attempt.min(5))).min(1800000);
    let requested = headers
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| {
            v.parse::<u64>().ok().map(Duration::from_secs).or_else(|| {
                httpdate::parse_http_date(v)
                    .ok()
                    .map(|at| at.duration_since(SystemTime::now()).unwrap_or_default())
            })
        })
        .map(|d| d.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0);
    // Never shorten Retry-After; the durable job TTL may expire first instead.
    requested
        .max(fallback)
        .saturating_add((rand::random::<u16>() % 1000) as i64)
}
impl Provider {
    async fn bearer(&self, http: &reqwest::Client) -> Result<String, Outcome> {
        let mut cache = self.cached.lock().await;
        if let Some(token) = cache.as_ref().filter(|t| t.expires_at > now() + 60000) {
            return Ok(token.value.clone());
        }
        let assertion = jwt(&self.credentials, self.kind, now() / 1000)
            .map_err(|_| Outcome::Failed("credential_signing_failed"))?;
        let token = if self.kind == Kind::Apns {
            CachedToken {
                value: assertion,
                expires_at: now() + 1800000,
            }
        } else {
            let response = http
                .post(self.oauth.clone())
                .form(&[
                    ("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"),
                    ("assertion", assertion.as_str()),
                ])
                .send()
                .await
                .map_err(|_| Outcome::Retry(60000, "oauth_transport_unknown"))?;
            let status = response.status();
            let delay = retry_after(response.headers(), 0);
            if status == reqwest::StatusCode::TOO_MANY_REQUESTS || status.is_server_error() {
                return Err(Outcome::Retry(delay, "oauth_provider_unavailable"));
            }
            if status != reqwest::StatusCode::OK {
                return Err(Outcome::Failed("oauth_credentials_rejected"));
            }
            let body = bounded_body(response)
                .await
                .map_err(|_| Outcome::Failed("oauth_reply_invalid"))?;
            let value: Value = serde_json::from_slice(&body)
                .map_err(|_| Outcome::Failed("oauth_reply_invalid"))?;
            let token = value
                .get("access_token")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty() && s.len() <= 8192 && !s.chars().any(char::is_control))
                .ok_or(Outcome::Failed("oauth_reply_invalid"))?;
            let seconds = value
                .get("expires_in")
                .and_then(Value::as_i64)
                .filter(|v| (120..=86400).contains(v))
                .ok_or(Outcome::Failed("oauth_reply_invalid"))?;
            CachedToken {
                value: token.into(),
                expires_at: now() + seconds * 1000,
            }
        };
        let result = token.value.clone();
        *cache = Some(token);
        Ok(result)
    }
    async fn send(&self, http: &reqwest::Client, bearer: &str, token: &str, e: &Event) -> Outcome {
        let data = json!({"event_id":e.id,"message_id":e.message,"channel_id":e.channel,"operation":e.kind,"epoch":if e.kind=="retract" {"1"}else{"0"}});
        let ttl = if e.kind == "retract" { 604800 } else { 3600 };
        let request = if self.kind == Kind::Apns {
            let url = match self.origin.join(&format!("3/device/{token}")) {
                Ok(url) => url,
                Err(_) => return Outcome::Failed("invalid_device_token"),
            };
            let mut body = data;
            body["aps"] = json!({"content-available":1});
            http.post(url)
                .bearer_auth(bearer)
                .header("apns-topic", &self.credentials.topic)
                .header("apns-push-type", "background")
                .header("apns-priority", "5")
                .header("apns-id", &e.id)
                .header("apns-collapse-id", crate::hash(&e.message))
                .header("apns-expiration", ((e.created / 1000) + ttl).to_string())
                .json(&body)
        } else {
            let url = match self.origin.join(&format!(
                "v1/projects/{}/messages:send",
                self.credentials.topic
            )) {
                Ok(url) => url,
                Err(_) => return Outcome::Failed("invalid_project"),
            };
            http.post(url).bearer_auth(bearer).json(&json!({"message":{"token":token,"data":data,"android":{"priority":"HIGH","ttl":format!("{ttl}s")}}}))
        };
        let response = match request.send().await {
            Ok(r) => r,
            Err(_) => return Outcome::Retry(60000, "delivery_outcome_unknown"),
        };
        if self.kind == Kind::Apns
            && !self.fixture
            && response.version() != reqwest::Version::HTTP_2
        {
            return Outcome::Failed("apns_requires_http2");
        }
        let status = response.status();
        let delay = retry_after(response.headers(), e.attempts);
        let body = match bounded_body(response).await {
            Ok(b) => b,
            Err(_) => return Outcome::Failed("provider_reply_invalid"),
        };
        let value: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
        if status == reqwest::StatusCode::OK {
            if self.kind == Kind::Fcm
                && !value["name"].as_str().is_some_and(|s| {
                    s.starts_with("projects/") && s.contains("/messages/") && s.len() <= 4096
                })
            {
                return Outcome::Failed("provider_reply_invalid");
            }
            return Outcome::Accepted;
        }
        if self.kind == Kind::Apns
            && status == reqwest::StatusCode::GONE
            && value["reason"] == "Unregistered"
        {
            return Outcome::InvalidToken;
        }
        if self.kind == Kind::Fcm
            && value["error"]["details"]
                .as_array()
                .is_some_and(|details| details.iter().any(|d| d["errorCode"] == "UNREGISTERED"))
        {
            return Outcome::InvalidToken;
        }
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS
            || status == reqwest::StatusCode::SERVICE_UNAVAILABLE
            || status == reqwest::StatusCode::INTERNAL_SERVER_ERROR
        {
            return Outcome::Retry(delay, "provider_retryable");
        }
        Outcome::Failed("provider_rejected")
    }
}
fn identifier(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".-_@".contains(&b))
}
pub fn configure(s: &mut AppState) -> Result<(), String> {
    configure_from(s, |name| std::env::var(name).ok())
}
fn configure_from(s: &mut AppState, env: impl Fn(&str) -> Option<String>) -> Result<(), String> {
    if !matches!(env("PUSH_ENABLED").as_deref(), Some("true" | "1")) {
        return Ok(());
    }
    let key: [u8; 32] = hex::decode(env("PUSH_TOKEN_KEY").ok_or("PUSH_TOKEN_KEY required")?)
        .map_err(|_| "invalid PUSH_TOKEN_KEY")?
        .try_into()
        .map_err(|_| "PUSH_TOKEN_KEY must contain64 hex characters")?;
    let mut providers = vec![];
    if let Some(pem) = env("APNS_PRIVATE_KEY_PEM").filter(|s| !s.trim().is_empty()) {
        let key_id = env("APNS_KEY_ID").ok_or("APNS_KEY_ID required")?;
        let issuer = env("APNS_TEAM_ID").ok_or("APNS_TEAM_ID required")?;
        let topic = env("APNS_TOPIC").ok_or("APNS_TOPIC required")?;
        if pem.len() > 16384
            || !identifier(&key_id, 10)
            || key_id.len() != 10
            || !identifier(&issuer, 10)
            || issuer.len() != 10
            || !identifier(&topic, 255)
        {
            return Err("invalid APNs credential fields".into());
        }
        let key = PKey::private_key_from_pem(pem.as_bytes()).map_err(|_| "invalid APNs key")?;
        if key
            .ec_key()
            .map_err(|_| "APNs requires EC key")?
            .group()
            .curve_name()
            != Some(Nid::X9_62_PRIME256V1)
        {
            return Err("APNs requires P-256 key".into());
        }
        let origin = if matches!(env("APNS_SANDBOX").as_deref(), Some("true" | "1")) {
            "https://api.sandbox.push.apple.com/"
        } else {
            "https://api.push.apple.com/"
        };
        providers.push(Provider {
            kind: Kind::Apns,
            origin: origin.parse().unwrap(),
            oauth: "https://oauth2.googleapis.com/token".parse().unwrap(),
            credentials: Credentials {
                key,
                key_id,
                issuer,
                topic,
            },
            cached: tokio::sync::Mutex::new(None),
            fixture: false,
        });
    }
    if let Some(encoded) = env("FCM_SERVICE_ACCOUNT_JSON").filter(|s| !s.trim().is_empty()) {
        if encoded.len() > 65536 {
            return Err("FCM credential too large".into());
        }
        let v: Value = serde_json::from_str(&encoded).map_err(|_| "invalid FCM credential JSON")?;
        let field = |name: &str| {
            v[name]
                .as_str()
                .filter(|v| !v.is_empty())
                .map(str::to_owned)
                .ok_or_else(|| format!("FCM credential missing {name}"))
        };
        let issuer = field("client_email")?;
        let topic = field("project_id")?;
        let key_id = field("private_key_id")?;
        if !identifier(&issuer, 320)
            || !issuer.ends_with(".gserviceaccount.com")
            || !identifier(&topic, 128)
            || !identifier(&key_id, 128)
        {
            return Err("invalid FCM credential fields".into());
        }
        let key = PKey::private_key_from_pem(field("private_key")?.as_bytes())
            .map_err(|_| "invalid FCM RSA key")?;
        let bits = key.rsa().map_err(|_| "FCM requires RSA key")?.size() * 8;
        if !(2048..=4096).contains(&bits) {
            return Err("FCM RSA key must be2048–4096 bits".into());
        }
        providers.push(Provider {
            kind: Kind::Fcm,
            origin: "https://fcm.googleapis.com/".parse().unwrap(),
            oauth: "https://oauth2.googleapis.com/token".parse().unwrap(),
            credentials: Credentials {
                key,
                key_id,
                issuer,
                topic,
            },
            cached: tokio::sync::Mutex::new(None),
            fixture: false,
        });
    }
    if providers.is_empty() {
        return Err("PUSH_ENABLED requires at least one provider credential".into());
    }
    s.push = Arc::new(Worker {
        key: Some(key),
        providers,
        http: http_client(),
        gate: tokio::sync::Mutex::new(()),
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;
    use openssl::{
        bn::BigNum,
        ec::{EcGroup, EcKey},
        rsa::Rsa,
        sign::Verifier,
    };
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::atomic::{AtomicBool, Ordering},
        thread,
    };
    use tower::ServiceExt;
    #[test]
    fn configuration_skips_empty_providers_and_redacts_bad_credentials() {
        let mut state = AppState::new(":memory:", "fixture").unwrap();
        configure_from(&mut state, |_| None).unwrap();
        assert!(!state.push.is_enabled());
        let mut env = std::collections::HashMap::from([
            ("PUSH_ENABLED", "true".to_owned()),
            ("PUSH_TOKEN_KEY", "42".repeat(32)),
            ("APNS_PRIVATE_KEY_PEM", String::new()),
            ("FCM_SERVICE_ACCOUNT_JSON", " ".to_owned()),
        ]);
        assert_eq!(
            configure_from(&mut state, |k| env.get(k).cloned()).unwrap_err(),
            "PUSH_ENABLED requires at least one provider credential"
        );
        env.insert("PUSH_TOKEN_KEY", "private-invalid-secret".into());
        assert_eq!(
            configure_from(&mut state, |k| env.get(k).cloned()).unwrap_err(),
            "invalid PUSH_TOKEN_KEY"
        );
        env.insert("PUSH_TOKEN_KEY", "42".repeat(32));
        env.insert(
            "APNS_PRIVATE_KEY_PEM",
            String::from_utf8(
                credentials(Kind::Apns)
                    .key
                    .private_key_to_pem_pkcs8()
                    .unwrap(),
            )
            .unwrap(),
        );
        env.insert("APNS_KEY_ID", "KEY1234567".into());
        env.insert("APNS_TEAM_ID", "TEAM123456".into());
        env.insert("APNS_TOPIC", "com.housecall.fixture".into());
        configure_from(&mut state, |k| env.get(k).cloned()).unwrap();
        assert!(state.push.is_enabled());
        assert_eq!(state.push.providers.len(), 1);
        env.insert("APNS_PRIVATE_KEY_PEM", "private-invalid-pem-secret".into());
        assert_eq!(
            configure_from(&mut state, |k| env.get(k).cloned()).unwrap_err(),
            "invalid APNs key"
        );
    }
    struct Fixture {
        origin: String,
        seen: Arc<Mutex<Vec<String>>>,
        arrived: Arc<AtomicBool>,
        release: Arc<AtomicBool>,
        stop: Arc<AtomicBool>,
        thread: Option<thread::JoinHandle<()>>,
    }
    impl Fixture {
        fn new(statuses: Vec<u16>, pause: bool) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let origin = format!("http://{}/", listener.local_addr().unwrap());
            let seen = Arc::new(Mutex::new(vec![]));
            let arrived = Arc::new(AtomicBool::new(false));
            let release = Arc::new(AtomicBool::new(!pause));
            let stop = Arc::new(AtomicBool::new(false));
            let (log, started, allow, done) =
                (seen.clone(), arrived.clone(), release.clone(), stop.clone());
            let thread = thread::spawn(move || {
                let mut sent = 0usize;
                while !done.load(Ordering::Relaxed) {
                    let (mut stream, _) = match listener.accept() {
                        Ok(v) => v,
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(5));
                            continue;
                        }
                        Err(_) => break,
                    };
                    stream
                        .set_read_timeout(Some(Duration::from_secs(3)))
                        .unwrap();
                    let mut bytes = vec![];
                    let mut buffer = [0u8; 4096];
                    loop {
                        let n = stream.read(&mut buffer).unwrap();
                        if n == 0 {
                            break;
                        }
                        bytes.extend_from_slice(&buffer[..n]);
                        assert!(bytes.len() <= 32768);
                        let text = String::from_utf8_lossy(&bytes);
                        if let Some(end) = text.find("\r\n\r\n") {
                            let length = text[..end]
                                .lines()
                                .find_map(|line| {
                                    line.to_ascii_lowercase()
                                        .strip_prefix("content-length:")
                                        .and_then(|v| v.trim().parse::<usize>().ok())
                                })
                                .unwrap_or(0);
                            if bytes.len() >= end + 4 + length {
                                break;
                            }
                        }
                    }
                    let text = String::from_utf8(bytes).unwrap();
                    let oauth = text.starts_with("POST /token ");
                    log.lock().unwrap().push(text);
                    let (status, value) = if oauth {
                        (
                            200,
                            json!({"access_token":"fixture-access-token","expires_in":3600}),
                        )
                    } else {
                        started.store(true, Ordering::SeqCst);
                        while !allow.load(Ordering::SeqCst) && !done.load(Ordering::SeqCst) {
                            thread::sleep(Duration::from_millis(5));
                        }
                        let status = *statuses.get(sent).unwrap_or(&200);
                        sent += 1;
                        (
                            status,
                            if status == 410 {
                                json!({"reason":"Unregistered"})
                            } else {
                                json!({"name":"projects/fixture/messages/accepted"})
                            },
                        )
                    };
                    let body = value.to_string();
                    let extra = if status == 503 {
                        "Retry-After: 180\r\n"
                    } else {
                        ""
                    };
                    write!(stream,"HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{extra}Connection: close\r\n\r\n{body}",body.len()).unwrap();
                }
            });
            Self {
                origin,
                seen,
                arrived,
                release,
                stop,
                thread: Some(thread),
            }
        }
        async fn wait_arrived(&self) {
            tokio::time::timeout(Duration::from_secs(5), async {
                while !self.arrived.load(Ordering::SeqCst) {
                    tokio::time::sleep(Duration::from_millis(5)).await
                }
            })
            .await
            .unwrap();
        }
        fn payloads(&self) -> Vec<Value> {
            self.seen
                .lock()
                .unwrap()
                .iter()
                .filter(|v| !v.starts_with("POST /token "))
                .map(|v| serde_json::from_str(v.split_once("\r\n\r\n").unwrap().1).unwrap())
                .collect()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::SeqCst);
            self.release.store(true, Ordering::SeqCst);
            self.thread.take().unwrap().join().unwrap();
        }
    }
    fn credentials(kind: Kind) -> Credentials {
        let key = if kind == Kind::Apns {
            let group = EcGroup::from_curve_name(Nid::X9_62_PRIME256V1).unwrap();
            PKey::from_ec_key(EcKey::generate(&group).unwrap()).unwrap()
        } else {
            PKey::from_rsa(Rsa::generate(2048).unwrap()).unwrap()
        };
        Credentials {
            key,
            key_id: "FIXTURE123".into(),
            issuer: if kind == Kind::Apns {
                "TEAM123456".into()
            } else {
                "fixture@fixture.iam.gserviceaccount.com".into()
            },
            topic: if kind == Kind::Apns {
                "com.housecall.fixture".into()
            } else {
                "fixture-project".into()
            },
        }
    }
    fn worker(kind: Kind, origin: &str) -> Arc<Worker> {
        let url: url::Url = origin.parse().unwrap();
        assert_eq!(url.scheme(), "http");
        assert!(url
            .host_str()
            .unwrap()
            .parse::<std::net::IpAddr>()
            .unwrap()
            .is_loopback());
        Arc::new(Worker {
            key: Some([42; 32]),
            providers: vec![Provider {
                kind,
                origin: url.clone(),
                oauth: url.join("token").unwrap(),
                credentials: credentials(kind),
                cached: tokio::sync::Mutex::new(None),
                fixture: true,
            }],
            http: http_client(),
            gate: tokio::sync::Mutex::new(()),
        })
    }
    fn seed(path: &str) -> AppState {
        let s = AppState::new(path, "fixture").unwrap();
        {
            let db = s.db.lock().unwrap();
            db.execute(
                "INSERT OR IGNORE INTO channels(id,name,kind) VALUES('room','Fixture','channel')",
                [],
            )
            .unwrap();
            for (user, session, token, joins) in [
                ("alice", "alice", 'a', true),
                ("bob", "bob", 'b', true),
                ("outsider", "outsider", 'c', false),
                ("bob", "bob2", 'd', true),
            ] {
                db.execute("INSERT OR IGNORE INTO users(id,username,password,is_owner) VALUES(?1,?1,'unused',0)",[user]).unwrap();
                db.execute("INSERT OR IGNORE INTO sessions(id,user_id,token_hash,device_hash,device_name,created_at,expires_at) VALUES(?1,?2,?3,?4,'fixture',?5,?6)",params![session,user,crate::hash(&token.to_string().repeat(64)),crate::hash(&"e".repeat(64)),now(),now()+600000]).unwrap();
                if joins {
                    db.execute(
                        "INSERT OR IGNORE INTO members(channel_id,user_id) VALUES('room',?1)",
                        [user],
                    )
                    .unwrap();
                }
            }
        }
        s
    }
    async fn call(
        s: &AppState,
        actor: Option<char>,
        method: &str,
        path: &str,
        body: Value,
    ) -> (StatusCode, Value) {
        let mut request = Request::builder()
            .method(method)
            .uri(path)
            .header("content-type", "application/json");
        if let Some(actor) = actor {
            request = request
                .header(
                    "authorization",
                    format!("Bearer {}", actor.to_string().repeat(64)),
                )
                .header("x-device-key", "e".repeat(64));
        }
        let response = crate::app(s.clone(), None)
            .oneshot(request.body(Body::from(body.to_string())).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&bytes).unwrap())
    }
    async fn register_bob(s: &AppState, kind: Kind) {
        assert_eq!(
            call(
                s,
                Some('b'),
                "PUT",
                "/api/push/device",
                json!({"provider":kind,"token":"1".repeat(64)})
            )
            .await
            .0,
            StatusCode::OK
        );
    }
    async fn message(s: &AppState) -> String {
        let (status, body) = call(
            s,
            Some('a'),
            "POST",
            "/api/channels/room/messages",
            json!({"body":"secret fixture message contents","mention_ids":["bob"]}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        body["id"].as_str().unwrap().into()
    }
    async fn states(s: &AppState) -> Value {
        let (status, value) = call(s, Some('b'), "GET", "/api/push/events", json!(null)).await;
        assert_eq!(status, StatusCode::OK);
        value
    }
    #[tokio::test]
    async fn routes_are_session_bound_and_tokens_never_returned() {
        let mut s = seed(":memory:");
        for (method, path, body) in [
            ("GET", "/api/push/device", json!(null)),
            (
                "PUT",
                "/api/push/device",
                json!({"provider":"apns","token":"1".repeat(64)}),
            ),
            ("DELETE", "/api/push/device", json!(null)),
            ("GET", "/api/push/events", json!(null)),
            ("POST", "/api/push/events/missing/ack", json!(null)),
        ] {
            assert_eq!(
                call(&s, None, method, path, body).await.0,
                StatusCode::UNAUTHORIZED
            );
        }
        assert_eq!(
            call(
                &s,
                Some('b'),
                "PUT",
                "/api/push/device",
                json!({"provider":"apns","token":"1".repeat(64)})
            )
            .await
            .0,
            StatusCode::SERVICE_UNAVAILABLE
        );
        s.push = worker(Kind::Apns, "http://127.0.0.1:9/");
        register_bob(&s, Kind::Apns).await;
        assert_eq!(
            call(
                &s,
                Some('d'),
                "PUT",
                "/api/push/device",
                json!({"provider":"apns","token":"1".repeat(64)})
            )
            .await
            .0,
            StatusCode::CONFLICT
        );
        let registration = call(&s, Some('b'), "GET", "/api/push/device", json!(null))
            .await
            .1;
        assert!(registration["registered"].as_bool().unwrap());
        assert!(!registration.to_string().contains(&"1".repeat(64)));
        assert_eq!(
            call(&s, Some('a'), "GET", "/api/push/device", json!(null))
                .await
                .1["registered"],
            false
        );
        let _message = message(&s).await;
        let events = states(&s).await;
        let id = events["events"][0]["id"].as_str().unwrap();
        for actor in ['a', 'c', 'd'] {
            assert!(
                call(&s, Some(actor), "GET", "/api/push/events", json!(null))
                    .await
                    .1["events"]
                    .as_array()
                    .unwrap()
                    .is_empty()
            );
            assert_eq!(
                call(
                    &s,
                    Some(actor),
                    "POST",
                    &format!("/api/push/events/{id}/ack"),
                    json!(null)
                )
                .await
                .0,
                StatusCode::NOT_FOUND
            );
        }
        call(&s, Some('d'), "DELETE", "/api/push/device", json!(null)).await;
        assert_eq!(
            call(&s, Some('b'), "GET", "/api/push/device", json!(null))
                .await
                .1["registered"],
            true
        );
        let db = s.db.lock().unwrap();
        let cipher: Vec<u8> = db
            .query_row(
                "SELECT token_cipher FROM push_devices WHERE session_id='bob'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(!cipher
            .windows(32)
            .any(|v| v == b"11111111111111111111111111111111"));
    }
    #[test]
    fn jwt_signatures_and_encrypted_tokens_use_expected_algorithms() {
        for kind in [Kind::Apns, Kind::Fcm] {
            let c = credentials(kind);
            let signed = jwt(&c, kind, 1700000000).unwrap();
            let parts: Vec<_> = signed.split('.').collect();
            assert_eq!(parts.len(), 3);
            let header: Value =
                serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[0]).unwrap()).unwrap();
            let claims: Value =
                serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).unwrap()).unwrap();
            assert_eq!(claims["iat"], 1700000000);
            let raw = URL_SAFE_NO_PAD.decode(parts[2]).unwrap();
            let signature = if kind == Kind::Apns {
                assert_eq!(header["alg"], "ES256");
                assert_eq!(raw.len(), 64);
                EcdsaSig::from_private_components(
                    BigNum::from_slice(&raw[..32]).unwrap(),
                    BigNum::from_slice(&raw[32..]).unwrap(),
                )
                .unwrap()
                .to_der()
                .unwrap()
            } else {
                assert_eq!(header["alg"], "RS256");
                assert_eq!(
                    claims["scope"],
                    "https://www.googleapis.com/auth/firebase.messaging"
                );
                raw
            };
            let mut verify = Verifier::new(MessageDigest::sha256(), &c.key).unwrap();
            verify
                .update(format!("{}.{}", parts[0], parts[1]).as_bytes())
                .unwrap();
            assert!(verify.verify(&signature).unwrap());
        }
        let cipher = seal_token(&[42; 32], "device", "fixture-token").unwrap();
        assert_eq!(
            open_token(&[42; 32], "device", &cipher).unwrap(),
            "fixture-token"
        );
        assert!(open_token(&[42; 32], "other-device", &cipher).is_err());
        assert!(open_token(&[41; 32], "device", &cipher).is_err());
        let mut changed = cipher;
        changed[30] ^= 1;
        assert!(open_token(&[42; 32], "device", &changed).is_err());
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            "retry-after",
            httpdate::fmt_http_date(SystemTime::now() + Duration::from_secs(300))
                .parse()
                .unwrap(),
        );
        assert!(retry_after(&headers, 0) >= 299000);
    }
    #[tokio::test]
    async fn history_is_bounded_tombstones_first_and_apns_tokens_are_canonical() {
        let mut s = seed(":memory:");
        s.push = worker(Kind::Apns, "http://127.0.0.1:9/");
        assert_eq!(
            call(
                &s,
                Some('b'),
                "PUT",
                "/api/push/device",
                json!({"provider":"apns","token":"ab".repeat(32)})
            )
            .await
            .0,
            StatusCode::OK
        );
        assert_eq!(
            call(
                &s,
                Some('d'),
                "PUT",
                "/api/push/device",
                json!({"provider":"apns","token":"AB".repeat(32)})
            )
            .await
            .0,
            StatusCode::CONFLICT
        );
        {
            let db = s.db.lock().unwrap();
            let id: String = db
                .query_row("SELECT id FROM push_devices", [], |r| r.get(0))
                .unwrap();
            for n in 0..101 {
                insert_event(&db, &id, "bob", &format!("fixture-{n}"), "room", "alert").unwrap();
            }
            insert_event(&db, &id, "bob", "tombstone", "room", "retract").unwrap();
        }
        let body = states(&s).await;
        assert_eq!(body["events"].as_array().unwrap().len(), 100);
        assert_eq!(body["events"][0]["kind"], "retract");
        assert_eq!(body["history_truncated"], true);
        assert_eq!(body["reconciliation_required"], true);
    }
    #[tokio::test]
    async fn acknowledged_history_cannot_starve_pending_native_events() {
        let mut s = seed(":memory:");
        s.push = worker(Kind::Apns, "http://127.0.0.1:9/");
        register_bob(&s, Kind::Apns).await;
        {
            let db = s.db.lock().unwrap();
            let device: String = db
                .query_row("SELECT id FROM push_devices", [], |r| r.get(0))
                .unwrap();
            for n in 0..101 {
                insert_event(&db, &device, "bob", &format!("old-{n}"), "room", "retract").unwrap();
            }
            db.execute("UPDATE push_events SET state='acknowledged'", [])
                .unwrap();
            insert_event(&db, &device, "bob", "new-retract", "room", "retract").unwrap();
        }
        let message_id = message(&s).await;
        let pending = states(&s).await;
        assert_eq!(pending["events"][0]["message_id"], "new-retract");
        assert_eq!(pending["events"][1]["message_id"], message_id);
        assert_eq!(pending["history_truncated"], true);
        for event in pending["events"].as_array().unwrap().iter().take(2) {
            assert_eq!(
                call(
                    &s,
                    Some('b'),
                    "POST",
                    &format!("/api/push/events/{}/ack", event["id"].as_str().unwrap()),
                    json!({})
                )
                .await
                .0,
                StatusCode::OK
            );
        }
        let next_message = message(&s).await;
        assert_eq!(states(&s).await["events"][0]["message_id"], next_message);
    }
    #[tokio::test]
    async fn apns_accept_unsend_and_ack_keep_tombstone_pending_until_device_applies_it() {
        let fixture = Fixture::new(vec![200, 200], false);
        let mut s = seed(":memory:");
        s.push = worker(Kind::Apns, &fixture.origin);
        register_bob(&s, Kind::Apns).await;
        let id = message(&s).await;
        s.push.tick(&s.db).await.unwrap();
        assert_eq!(states(&s).await["events"][0]["state"], "accepted");
        // Restart-equivalent provider worker does not replay a provider-accepted alert.
        s.push = worker(Kind::Apns, &fixture.origin);
        s.push.tick(&s.db).await.unwrap();
        assert_eq!(fixture.payloads().len(), 1);
        assert_eq!(
            call(
                &s,
                Some('a'),
                "DELETE",
                &format!("/api/messages/{id}"),
                json!(null)
            )
            .await
            .0,
            StatusCode::OK
        );
        let pending = states(&s).await;
        assert_eq!(pending["events"].as_array().unwrap().len(), 1);
        assert_eq!(pending["events"][0]["kind"], "retract");
        assert_eq!(pending["events"][0]["retraction_pending"], true);
        s.push.tick(&s.db).await.unwrap();
        let accepted = states(&s).await;
        assert_eq!(accepted["events"][0]["state"], "accepted");
        assert_eq!(accepted["events"][0]["retraction_pending"], true);
        let event = accepted["events"][0]["id"].as_str().unwrap();
        assert_eq!(
            call(
                &s,
                Some('b'),
                "POST",
                &format!("/api/push/events/{event}/ack"),
                json!(null)
            )
            .await
            .0,
            StatusCode::OK
        );
        assert_eq!(states(&s).await["events"][0]["retraction_pending"], false);
        let payloads = fixture.payloads();
        assert_eq!(payloads.len(), 2);
        assert_eq!(payloads[0]["operation"], "alert");
        assert_eq!(payloads[1]["operation"], "retract");
        assert_eq!(payloads[1]["epoch"], "1");
        for body in payloads {
            assert!(body.get("alert").is_none());
            assert!(body["aps"].get("alert").is_none());
            assert!(!body.to_string().contains("secret fixture"));
            assert!(!body.to_string().contains("bob"));
        }
        for request in fixture.seen.lock().unwrap().iter() {
            let lower = request.to_ascii_lowercase();
            assert!(lower.contains("apns-push-type: background"));
            assert!(lower.contains("apns-priority: 5"));
            assert!(lower.contains("apns-collapse-id:"));
        }
    }
    #[tokio::test]
    async fn unsend_before_dispatch_removes_alert_and_transaction_rollback_removes_intents() {
        let fixture = Fixture::new(vec![200], false);
        let mut s = seed(":memory:");
        s.push = worker(Kind::Apns, &fixture.origin);
        register_bob(&s, Kind::Apns).await;
        {
            let mut db = s.db.lock().unwrap();
            let tx = db.transaction().unwrap();
            tx.execute("INSERT INTO messages(id,channel_id,author_id,body,created_at) VALUES('rolledback','room','alice','private',?1)",[now()]).unwrap();
            tx.execute(
                "INSERT INTO notifications VALUES('rolledback','bob','rolledback','room',?1)",
                [now()],
            )
            .unwrap();
            enqueue_alert(&tx, "bob", "rolledback", "room").unwrap();
            tx.rollback().unwrap();
            assert_eq!(
                db.query_row("SELECT count(*) FROM push_events", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                0
            );
        }
        let id = message(&s).await;
        call(
            &s,
            Some('a'),
            "DELETE",
            &format!("/api/messages/{id}"),
            json!(null),
        )
        .await;
        s.push.tick(&s.db).await.unwrap();
        assert_eq!(fixture.payloads().len(), 1);
        assert_eq!(fixture.payloads()[0]["operation"], "retract");
    }
    #[tokio::test]
    async fn in_flight_alert_cannot_resurrect_unsent_state_and_retract_follows_completion() {
        let fixture = Fixture::new(vec![200, 200], true);
        let mut s = seed(":memory:");
        s.push = worker(Kind::Apns, &fixture.origin);
        register_bob(&s, Kind::Apns).await;
        let id = message(&s).await;
        let (worker, db) = (s.push.clone(), s.db.clone());
        let active = tokio::spawn(async move { worker.tick(&db).await.unwrap() });
        fixture.wait_arrived().await;
        assert_eq!(
            call(
                &s,
                Some('a'),
                "DELETE",
                &format!("/api/messages/{id}"),
                json!(null)
            )
            .await
            .0,
            StatusCode::OK
        );
        fixture.release.store(true, Ordering::SeqCst);
        active.await.unwrap();
        let pending = states(&s).await;
        assert_eq!(pending["events"].as_array().unwrap().len(), 1);
        assert_eq!(pending["events"][0]["kind"], "retract");
        assert_eq!(pending["events"][0]["state"], "queued");
        s.push.tick(&s.db).await.unwrap();
        let payloads = fixture.payloads();
        assert_eq!(payloads.len(), 2);
        assert_eq!(payloads[0]["epoch"], "0");
        assert_eq!(payloads[1]["epoch"], "1");
        assert_eq!(states(&s).await["events"][0]["state"], "accepted");
    }
    #[tokio::test]
    async fn fcm_oauth_retry_and_database_restart_preserve_the_event_id() {
        let fixture = Fixture::new(vec![503, 200], false);
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("push.sqlite");
        let mut s = seed(database.to_str().unwrap());
        s.push = worker(Kind::Fcm, &fixture.origin);
        register_bob(&s, Kind::Fcm).await;
        let _id = message(&s).await;
        s.push.tick(&s.db).await.unwrap();
        let first = states(&s).await;
        assert_eq!(first["events"][0]["state"], "queued");
        assert_eq!(first["events"][0]["attempts"], 1);
        {
            let db = s.db.lock().unwrap();
            let next: i64 = db
                .query_row("SELECT next_at FROM push_events", [], |r| r.get(0))
                .unwrap();
            assert!(next >= now() + 179000);
            db.execute("UPDATE push_events SET next_at=0", []).unwrap();
        }
        drop(s);
        let mut reopened = seed(database.to_str().unwrap());
        reopened.push = worker(Kind::Fcm, &fixture.origin);
        reopened.push.tick(&reopened.db).await.unwrap();
        let second = states(&reopened).await;
        assert_eq!(second["events"][0]["id"], first["events"][0]["id"]);
        assert_eq!(second["events"][0]["state"], "accepted");
        assert_eq!(second["events"][0]["attempts"], 2);
        let payloads = fixture.payloads();
        assert_eq!(payloads.len(), 2);
        assert_eq!(
            payloads[0]["message"]["data"]["event_id"],
            payloads[1]["message"]["data"]["event_id"]
        );
        assert!(payloads[0]["message"].get("notification").is_none());
        assert!(!payloads[0].to_string().contains("secret fixture"));
        assert_eq!(
            fixture
                .seen
                .lock()
                .unwrap()
                .iter()
                .filter(|r| r.starts_with("POST /token "))
                .count(),
            2
        );
    }
    #[tokio::test]
    async fn revoked_sessions_removed_members_and_provider_invalid_tokens_stop_delivery() {
        let fixture = Fixture::new(vec![410], false);
        let mut s = seed(":memory:");
        s.push = worker(Kind::Apns, &fixture.origin);
        register_bob(&s, Kind::Apns).await;
        let _id = message(&s).await;
        s.db.lock()
            .unwrap()
            .execute(
                "DELETE FROM members WHERE channel_id='room' AND user_id='bob'",
                [],
            )
            .unwrap();
        s.push.tick(&s.db).await.unwrap();
        assert!(fixture.payloads().is_empty());
        assert_eq!(
            states(&s).await["events"][0]["error"],
            "authorization_revoked"
        );
        s.db.lock()
            .unwrap()
            .execute("INSERT INTO members VALUES('room','bob')", [])
            .unwrap();
        let _second = message(&s).await;
        s.push.tick(&s.db).await.unwrap();
        assert_eq!(fixture.payloads().len(), 1);
        assert_eq!(
            call(&s, Some('b'), "GET", "/api/push/device", json!(null))
                .await
                .1["registered"],
            false
        );
        register_bob(&s, Kind::Apns).await;
        let _third = message(&s).await;
        s.db.lock()
            .unwrap()
            .execute("DELETE FROM sessions WHERE id='bob'", [])
            .unwrap();
        s.push.tick(&s.db).await.unwrap();
        assert_eq!(fixture.payloads().len(), 1);
        assert_eq!(
            s.db.lock()
                .unwrap()
                .query_row("SELECT count(*) FROM push_devices", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
}
