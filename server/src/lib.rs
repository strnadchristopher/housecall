pub mod access;
pub mod activities;
pub mod attach_kind;
pub mod dj;
pub mod embeds;
pub mod gimme;
pub mod giphy;
pub mod image_blob;
pub mod media;
pub(crate) mod media_index;
pub mod passkeys;
pub mod plex;
pub mod preflight;
pub mod profile;
pub mod push;
/// 1:1 calls: ring and decline in a direct conversation.
pub mod ring;
pub mod servers;
pub mod setup;
/// View-once photos: open once per recipient, deleted when everyone has or after 24 hours.
pub mod snaps;
pub mod transcode;
pub mod vm;
pub mod vm_media;
pub mod vm_reset;
pub mod voice;
use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use axum::{
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{HeaderMap, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{delete, get, patch, post},
    Extension, Json, Router,
};
use rand::{rngs::OsRng, RngCore};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

pub type ApiResult<T> = Result<Json<T>, ApiError>;
#[derive(Debug)]
pub struct ApiError(StatusCode, &'static str);
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error":self.1}))).into_response()
    }
}
impl From<rusqlite::Error> for ApiError {
    fn from(e: rusqlite::Error) -> Self {
        tracing::error!(error=%e,"database operation failed");
        Self(StatusCode::INTERNAL_SERVER_ERROR, "storage error")
    }
}
fn bad(msg: &'static str) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, msg)
}
fn forbidden() -> ApiError {
    ApiError(StatusCode::FORBIDDEN, "forbidden")
}
fn unauthorized() -> ApiError {
    ApiError(StatusCode::UNAUTHORIZED, "invalid or expired session")
}
fn missing() -> ApiError {
    ApiError(StatusCode::NOT_FOUND, "not found")
}
fn conflict(msg: &'static str) -> ApiError {
    ApiError(StatusCode::CONFLICT, msg)
}
pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
fn secret() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    hex::encode(bytes)
}
fn hash(v: &str) -> String {
    hex::encode(Sha256::digest(v.as_bytes()))
}
#[derive(Clone)]
pub struct AppState {
    pub db: Arc<Mutex<Connection>>,
    setup_hash: Option<String>,
    limits: Arc<Mutex<HashMap<String, (i64, u32)>>>,
    pub public_auth_limit: u32,
    pub auth_slots: Arc<tokio::sync::Semaphore>,
    pub client_origins: Vec<axum::http::HeaderValue>,
    pub media: Option<Arc<housecall_media::Store>>,
    pub scanner: Arc<dyn housecall_media::Scanner>,
    pub passkeys: Option<Arc<passkeys::Passkeys>>,
    pub voice: Option<Arc<housecall_sfu::Sfu>>,
    pub transcoder: Option<Arc<transcode::Processor>>,
    pub plex: Option<Arc<plex::Gateway>>,
    pub gimme: Arc<gimme::Worker>,
    pub dj: Option<Arc<dj::Player>>,
    pub push: Arc<push::Worker>,
    pub vm: Option<Arc<vm::Gateway>>,
    pub vm_media: Arc<vm_media::Publisher>,
    pub vm_operations: Arc<tokio::sync::Mutex<()>>,
    pub invite_mail: Arc<InviteMailConfig>,
    /// Last ring time (ms) per conversation, for the one-ring-per-10-seconds limit.
    pub rings: Arc<Mutex<HashMap<String, i64>>>,
    /// Who is in which call and in what state, and screen-share previews. Memory only.
    pub live: Arc<voice::Live>,
}
#[derive(Clone)]
pub struct InviteMailConfig {
    api_key: Option<String>,
    mail_from: Option<String>,
    public_url: String,
}
impl InviteMailConfig {
    pub fn from_env() -> Result<Self, String> {
        let api_key = std::env::var("RESEND_API_KEY")
            .ok()
            .filter(|value| !value.is_empty());
        let mail_from = std::env::var("HOUSECALL_MAIL_FROM")
            .ok()
            .filter(|value| !value.is_empty());
        if api_key.is_some() && mail_from.is_none() {
            return Err("HOUSECALL_MAIL_FROM is required when RESEND_API_KEY is set".into());
        }
        let public_url = std::env::var("HOUSECALL_PUBLIC_URL")
            .unwrap_or_else(|_| "http://localhost:3000".into());
        let parsed =
            reqwest::Url::parse(&public_url).map_err(|_| "invalid HOUSECALL_PUBLIC_URL")?;
        if !matches!(parsed.scheme(), "http" | "https")
            || parsed.host_str().is_none()
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.query().is_some()
            || parsed.fragment().is_some()
            || !matches!(parsed.path(), "" | "/")
        {
            return Err("HOUSECALL_PUBLIC_URL must be an HTTP(S) origin".into());
        }
        Ok(Self {
            api_key,
            mail_from,
            public_url: parsed.origin().ascii_serialization(),
        })
    }

    fn invite_link(&self, token: &str) -> String {
        format!("{}/#invite={token}", self.public_url)
    }

    async fn send_invite(&self, email: &str, link: &str) -> Result<bool, String> {
        let Some(api_key) = self.api_key.as_deref() else {
            return Ok(false);
        };
        let html_link = link
            .replace('&', "&amp;")
            .replace('"', "&quot;")
            .replace('<', "&lt;")
            .replace('>', "&gt;");
        let response = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| "mail client unavailable")?
            .post("https://api.resend.com/emails")
            .bearer_auth(api_key)
            .json(&json!({
                "from": self.mail_from.as_deref().expect("validated sender"),
                "to": [email],
                "subject": "Your Housecall invitation",
                "html": format!("<p>You have been invited to Housecall. This link works once and expires in seven days.</p><p><a href=\"{html_link}\">Accept your invitation</a></p><p>If you did not expect this, you can ignore this email.</p>"),
                "text": format!("You have been invited to Housecall. This link works once and expires in seven days:\n\n{link}\n\nIf you did not expect this, you can ignore this email.")
            }))
            .send()
            .await
            .map_err(|_| "mail delivery failed")?;
        if !response.status().is_success() {
            return Err(format!(
                "Resend returned HTTP {}",
                response.status().as_u16()
            ));
        }
        Ok(true)
    }
}
#[derive(Clone, Serialize, Debug)]
pub struct User {
    pub id: String,
    pub username: String,
    pub is_owner: bool,
}
#[derive(Clone)]
pub struct Principal {
    pub user: User,
    pub session_id: String,
}
impl AppState {
    pub fn new(database: &str, setup_token: &str) -> Result<Self, rusqlite::Error> {
        Self::new_with_setup_token(database, Some(setup_token))
    }
    pub fn new_with_setup_token(
        database: &str,
        setup_token: Option<&str>,
    ) -> Result<Self, rusqlite::Error> {
        let db = Connection::open(database)?;
        db.execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,password TEXT NOT NULL,is_owner INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),token_hash TEXT UNIQUE NOT NULL,device_hash TEXT NOT NULL,device_name TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS invites(token_hash TEXT PRIMARY KEY,expires_at INTEGER NOT NULL,used_at INTEGER);
 CREATE TABLE IF NOT EXISTS channels(id TEXT PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS members(channel_id TEXT NOT NULL REFERENCES channels(id),user_id TEXT NOT NULL REFERENCES users(id),PRIMARY KEY(channel_id,user_id));
 CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,channel_id TEXT NOT NULL REFERENCES channels(id),author_id TEXT NOT NULL REFERENCES users(id),body TEXT NOT NULL,reply_to TEXT,created_at INTEGER NOT NULL,edited_at INTEGER,revision INTEGER NOT NULL DEFAULT 1,pinned INTEGER NOT NULL DEFAULT 0,mention_ids TEXT NOT NULL DEFAULT '[]');
 CREATE INDEX IF NOT EXISTS messages_channel_time ON messages(channel_id,created_at);
 CREATE TABLE IF NOT EXISTS reactions(message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id),emoji TEXT NOT NULL,PRIMARY KEY(message_id,user_id,emoji));
 CREATE TABLE IF NOT EXISTS notifications(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,channel_id TEXT NOT NULL,created_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id TEXT NOT NULL REFERENCES users(id),kind TEXT NOT NULL,channel_id TEXT,payload TEXT NOT NULL,created_at INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS events_user_cursor ON events(user_id,id);
 CREATE TABLE IF NOT EXISTS reads(channel_id TEXT NOT NULL,user_id TEXT NOT NULL,message_id TEXT NOT NULL,PRIMARY KEY(channel_id,user_id));
 CREATE TABLE IF NOT EXISTS reports(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),kind TEXT NOT NULL,body TEXT NOT NULL,logs TEXT,created_at INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'open');")?;
        db.execute_batch("CREATE TABLE IF NOT EXISTS attachments(upload_id TEXT PRIMARY KEY,message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,filename TEXT NOT NULL,length TEXT NOT NULL);")?;
        db.execute_batch("CREATE TABLE IF NOT EXISTS report_media(report_id TEXT PRIMARY KEY REFERENCES reports(id) ON DELETE CASCADE,upload_id TEXT NOT NULL);")?;
        transcode::init(&db)?;
        servers::init(&db)?;
        access::init(&db)?;
        snaps::init(&db)?;
        passkeys::init(&db)?;
        activities::init(&db)?;
        vm_reset::init(&db)?;
        gimme::init(&db)?;
        dj::init(&db)?;
        push::init(&db)?;
        Ok(Self {
            db: Arc::new(Mutex::new(db)),
            setup_hash: setup_token.map(hash),
            limits: Default::default(),
            public_auth_limit: 40,
            auth_slots: Arc::new(tokio::sync::Semaphore::new(2)),
            client_origins: vec![],
            media: None,
            scanner: Arc::new(housecall_media::RejectScanner),
            passkeys: None,
            voice: None,
            transcoder: None,
            plex: None,
            gimme: gimme::Worker::dry_run(),
            dj: None,
            push: push::Worker::disabled(),
            vm: None,
            vm_media: Default::default(),
            vm_operations: Default::default(),
            invite_mail: Arc::new(InviteMailConfig {
                api_key: None,
                mail_from: None,
                public_url: "http://localhost:1420".into(),
            }),
            rings: Default::default(),
            live: Default::default(),
        })
    }
    fn limited(&self, key: String, max: u32) -> bool {
        let mut limits = self.limits.lock().unwrap();
        let stamp = now() / 60000;
        if limits.len() > 4096 {
            limits.retain(|_, v| v.0 == stamp);
        }
        let v = limits.entry(key).or_insert((stamp, 0));
        if v.0 != stamp {
            *v = (stamp, 0)
        }
        v.1 += 1;
        v.1 > max
    }
}
pub fn app(state: AppState, static_dir: Option<&str>) -> Router {
    let cors = tower_http::cors::CorsLayer::new()
        .allow_origin(state.client_origins.clone())
        .allow_methods([
            axum::http::Method::GET,
            axum::http::Method::POST,
            axum::http::Method::PATCH,
            axum::http::Method::DELETE,
            axum::http::Method::HEAD,
        ])
        .allow_headers([
            axum::http::header::AUTHORIZATION,
            axum::http::header::CONTENT_TYPE,
            axum::http::HeaderName::from_static("x-device-key"),
            axum::http::HeaderName::from_static("upload-offset"),
            axum::http::header::RANGE,
        ]);
    let private = Router::new()
        .merge(embeds::routes())
        .merge(plex::routes())
        .merge(transcode::routes())
        .merge(voice::routes())
        .merge(ring::routes())
        .merge(vm::routes())
        .merge(vm_media::routes())
        .merge(vm_reset::routes())
        .merge(servers::routes())
        .merge(access::routes())
        .merge(setup::routes())
        .merge(profile::routes())
        .merge(snaps::routes())
        .merge(media::routes())
        .merge(giphy::routes())
        .merge(gimme::routes())
        .merge(dj::routes())
        .merge(push::routes())
        .merge(passkeys::private_routes())
        .merge(activities::routes())
        .route("/me", get(me).patch(profile::rename_me))
        .route("/invites", get(invites).post(invite))
        .route("/invites/redeem", post(redeem_invite))
        .route("/invites/{id}", delete(revoke_invite))
        .route("/users/{id}/sessions", delete(revoke_user_sessions))
        .route("/users/{id}/disable", post(disable_user))
        .route("/devices", get(devices))
        .route("/devices/{id}", delete(revoke))
        .route("/channels", get(channels).post(create_channel))
        .route("/members", get(members))
        .route("/channels/{id}/messages", get(messages).post(send_message))
        .route("/messages/{id}", patch(edit_message).delete(unsend))
        .route("/messages/{id}/reactions", post(react))
        .route("/messages/{id}/pin", post(pin))
        .route("/channels/{id}/read", post(mark_read))
        .route("/channels/{id}/typing", post(typing))
        .route("/notifications", get(notifications))
        .route("/events", get(events))
        .route("/reports", get(reports).post(report))
        .route("/reports/{id}", patch(resolve_report))
        .route("/reports/{id}/screenshot", get(report_screenshot))
        .route_layer(middleware::from_fn_with_state(state.clone(), authenticate));
    let public = Router::new()
        .merge(passkeys::public_routes())
        .merge(access::public_routes())
        .merge(preflight::routes())
        .route("/setup", post(setup))
        .route("/login", post(login))
        .route("/invites/accept", post(accept))
        .route_layer(middleware::from_fn_with_state(state.clone(), public_limit));
    let mut router = Router::new()
        .nest(
            "/api",
            private
                .merge(public)
                .route("/health", get(|| async { Json(json!({"ok":true,"version":env!("CARGO_PKG_VERSION")})) })),
        )
        .with_state(state);
    if let Some(path) = static_dir {
        router = router.fallback_service(
            tower_http::services::ServeDir::new(path).append_index_html_on_directories(true),
        );
    }
    router
        .layer(cors)
        .layer(DefaultBodyLimit::max(128 * 1024))
        .layer(middleware::from_fn(headers))
}
async fn headers(request: axum::extract::Request, next: Next) -> Response {
    let mut r = next.run(request).await;
    let h = r.headers_mut();
    // Handlers that serve immutable, versioned blobs (avatars, icons) set their own cache policy.
    let cache_set = h.contains_key(axum::http::header::CACHE_CONTROL);
    for(k,v)in[("content-security-policy","default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"),("x-content-type-options","nosniff"),("referrer-policy","no-referrer"),("cache-control","no-store"),("permissions-policy","camera=(self), microphone=(self), geolocation=()")]{if k=="cache-control"&&cache_set{continue;}h.insert(axum::http::HeaderName::from_static(k),v.parse().unwrap());}
    r
}
async fn public_limit(
    State(s): State<AppState>,
    req: axum::extract::Request,
    next: Next,
) -> Result<Response, ApiError> {
    let route = match req.uri().path().rsplit('/').next().unwrap_or_default() {
        "login" => "login",
        "accept" => "invite-accept",
        _ => "public",
    };
    if s.limited(format!("public:{route}"), s.public_auth_limit) {
        return Err(ApiError(StatusCode::TOO_MANY_REQUESTS, "try again later"));
    }
    Ok(next.run(req).await)
}
pub fn identify(s: &AppState, h: &HeaderMap) -> Result<Principal, ApiError> {
    let token = h
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .filter(|v| v.len() == 64)
        .ok_or_else(unauthorized)?;
    let device = h
        .get("x-device-key")
        .and_then(|v| v.to_str().ok())
        .filter(|v| v.len() == 64)
        .ok_or_else(unauthorized)?;
    let db = s.db.lock().unwrap();
    db.query_row("SELECT u.id,u.username,u.is_owner,s.id FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.device_hash=? AND s.expires_at>? AND u.disabled=0",params![hash(token),hash(device),now()],|r|Ok(Principal{user:User{id:r.get(0)?,username:r.get(1)?,is_owner:r.get(2)?},session_id:r.get(3)?})).optional()?.ok_or_else(unauthorized)
}
async fn authenticate(
    State(s): State<AppState>,
    mut req: axum::extract::Request,
    next: Next,
) -> Result<Response, ApiError> {
    let p = identify(&s, req.headers())?;
    if s.limited(p.session_id.clone(), 600) {
        return Err(ApiError(StatusCode::TOO_MANY_REQUESTS, "try again later"));
    }
    req.extensions_mut().insert(p);
    Ok(next.run(req).await)
}
pub fn member(db: &Connection, uid: &str, cid: &str) -> Result<(), ApiError> {
    if db
        .query_row(
            "SELECT 1 FROM members WHERE channel_id=? AND user_id=?",
            params![cid, uid],
            |_| Ok(()),
        )
        .optional()?
        .is_none()
    {
        Err(forbidden())
    } else {
        Ok(())
    }
}
fn owner(p: &Principal) -> Result<(), ApiError> {
    if p.user.is_owner {
        Ok(())
    } else {
        Err(forbidden())
    }
}
fn emit(db: &Connection, cid: &str, kind: &str, payload: Value) -> Result<(), ApiError> {
    db.execute("INSERT INTO events(user_id,kind,channel_id,payload,created_at) SELECT user_id,?,?,?,? FROM members WHERE channel_id=?",params![kind,cid,payload.to_string(),now(),cid])?;
    Ok(())
}
pub fn valid_username(s: &str) -> bool {
    s.len() >= 2
        && s.len() <= 32
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
fn credentials(username: &str, password: &str, device: &str) -> Result<(), ApiError> {
    if !valid_username(username)
        || password.len() < 12
        || password.len() > 256
        || device.is_empty()
        || device.len() > 80
    {
        return Err(bad("invalid username, password or device name"));
    }
    Ok(())
}
fn valid_email(email: &str) -> bool {
    if email.len() > 254 || email.bytes().any(|byte| byte.is_ascii_whitespace()) {
        return false;
    }
    let Some((local, domain)) = email.split_once('@') else {
        return false;
    };
    !local.is_empty()
        && local.len() <= 64
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && domain.contains('.')
        && domain.split('.').all(|label| {
            !label.is_empty()
                && label
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
        && email.matches('@').count() == 1
}
async fn password_hash(s: &AppState, password: String) -> Result<String, ApiError> {
    let permit = s.auth_slots.clone().try_acquire_owned().map_err(|_| {
        ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            "credential service busy; retry shortly",
        )
    })?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        Argon2::default()
            .hash_password(password.as_bytes(), &SaltString::generate(&mut OsRng))
            .map(|h| h.to_string())
    })
    .await
    .map_err(|_| bad("credential processing failed"))?
    .map_err(|_| bad("credential processing failed"))
}
fn session(db: &Connection, user: User, device_name: &str) -> Result<Value, ApiError> {
    let (token, device_key, id) = (secret(), secret(), secret());
    let expires = now() + 30 * 24 * 3600 * 1000;
    db.execute(
        "INSERT INTO sessions VALUES(?,?,?,?,?,?,?)",
        params![
            id,
            user.id,
            hash(&token),
            hash(&device_key),
            device_name,
            now(),
            expires
        ],
    )?;
    Ok(json!({"token":token,"device_key":device_key,"user":user,"expires_at":expires}))
}
#[derive(Deserialize)]
struct Setup {
    setup_token: String,
    username: String,
    password: String,
    device_name: String,
}
async fn setup(State(s): State<AppState>, Json(v): Json<Setup>) -> ApiResult<Value> {
    if s.db
        .lock()
        .unwrap()
        .query_row("SELECT COUNT(*) FROM users", [], |r| r.get::<_, i64>(0))?
        > 0
    {
        return Err(conflict("already initialized"));
    }
    if s.setup_hash.as_deref() != Some(hash(&v.setup_token).as_str()) {
        return Err(forbidden());
    }
    credentials(&v.username, &v.password, &v.device_name)?;
    let pw = password_hash(&s, v.password).await?;
    let mut db = s.db.lock().unwrap();
    let tx = db.transaction()?;
    if tx.query_row("SELECT COUNT(*) FROM users", [], |r| r.get::<_, i64>(0))? > 0 {
        return Err(conflict("already initialized"));
    }
    let u = User {
        id: secret(),
        username: v.username,
        is_owner: true,
    };
    tx.execute(
        "INSERT INTO users(id,username,password,is_owner) VALUES(?,?,?,1)",
        params![u.id, u.username, pw],
    )?;
    tx.execute(
        "INSERT INTO channels(id,name,kind,server_id) VALUES('general','general','channel','home')",
        [],
    )?;
    servers::join(&tx, &u.id, "home")?;
    let result = session(&tx, u, &v.device_name)?;
    tx.commit()?;
    Ok(Json(result))
}
#[derive(Deserialize)]
struct Login {
    username: String,
    password: String,
    device_name: String,
}
async fn login(State(s): State<AppState>, Json(v): Json<Login>) -> ApiResult<Value> {
    credentials(&v.username, &v.password, &v.device_name)?;
    let found = {
        s.db.lock()
            .unwrap()
            .query_row(
                "SELECT id,username,is_owner,password,disabled FROM users WHERE username=?",
                [&v.username],
                |r| {
                    Ok((
                        User {
                            id: r.get(0)?,
                            username: r.get(1)?,
                            is_owner: r.get(2)?,
                        },
                        r.get::<_, String>(3)?,
                        r.get::<_, bool>(4)?,
                    ))
                },
            )
            .optional()?
    };
    // Equal-cost missing-account verification prevents fast username enumeration.
    let dummy="$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQxMjM0NTY3OA$35GQXjfW5eDgMRCvwq6m4lfcblaxzlPN5BX2vkNVyWE";
    let encoded = found
        .as_ref()
        .map(|x| x.1.clone())
        .unwrap_or_else(|| dummy.into());
    let permit = s.auth_slots.clone().try_acquire_owned().map_err(|_| {
        ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            "credential service busy; retry shortly",
        )
    })?;
    let valid = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        PasswordHash::new(&encoded)
            .map(|h| {
                Argon2::default()
                    .verify_password(v.password.as_bytes(), &h)
                    .is_ok()
            })
            .unwrap_or(false)
    })
    .await
    .unwrap_or(false);
    if !valid {
        return Err(unauthorized());
    }
    let (u, _, disabled) = found.ok_or_else(unauthorized)?;
    let db = s.db.lock().unwrap();
    if disabled {
        // Only after the password checked out: say why an access request is not usable yet.
        return Err(match access::login_block(&db, &u.id)? {
            Some(reason) => ApiError(StatusCode::FORBIDDEN, reason),
            None => unauthorized(),
        });
    }
    Ok(Json(session(&db, u, &v.device_name)?))
}
#[derive(Deserialize)]
struct Invite {
    #[serde(default = "invite_week")]
    expires_in_seconds: Option<i64>,
    #[serde(default = "invite_once")]
    max_uses: Option<i64>,
    #[serde(default)]
    email: Option<String>,
    server_id: Option<String>,
}
fn invite_week() -> Option<i64> {
    Some(604_800)
}
fn invite_once() -> Option<i64> {
    Some(1)
}
/// `expires_at` for an invite that never expires; listed as null.
const INVITE_NEVER: i64 = i64::MAX;
fn invite_code(public_url: &str, token: &str) -> String {
    use base64::Engine;
    format!(
        "hc1.{}.{token}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(public_url)
    )
}
async fn invite(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Json(v): Json<Invite>,
) -> ApiResult<Value> {
    owner(&p)?;
    if v.expires_in_seconds
        .is_some_and(|seconds| !(60..=31_536_000).contains(&seconds))
    {
        return Err(bad("invalid expiry"));
    }
    if v.max_uses.is_some_and(|uses| !(1..=1000).contains(&uses)) {
        return Err(bad("invalid use limit"));
    }
    let email = v
        .email
        .as_deref()
        .map(|e| e.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if !email.is_empty() && !valid_email(&email) {
        return Err(bad("invalid email"));
    }
    if !email.is_empty() && v.expires_in_seconds.is_none() {
        return Err(bad("email invitations need an expiry"));
    }
    let max_uses = if email.is_empty() { v.max_uses } else { Some(1) };
    let token = secret();
    let link = s.invite_mail.invite_link(&token);
    let expires = v
        .expires_in_seconds
        .map_or(INVITE_NEVER, |seconds| now() + seconds * 1000);
    let server_id = v.server_id.unwrap_or_else(|| "home".into());
    {
        let db = s.db.lock().unwrap();
        servers::exists(&db, &server_id)?;
        db.execute(
            "INSERT INTO invites(token_hash,expires_at,used_at,server_id,email,max_uses,uses) VALUES(?,?,NULL,?,?,?,0)",
            params![hash(&token), expires, server_id, email, max_uses],
        )?;
    }
    let email_sent = if email.is_empty() {
        Ok(false)
    } else {
        s.invite_mail.send_invite(&email, &link).await
    };
    let email_sent = match email_sent {
        Ok(sent) => sent,
        Err(error) => {
            let _ = s.db.lock().unwrap().execute(
                "DELETE FROM invites WHERE token_hash=? AND used_at IS NULL",
                [hash(&token)],
            );
            tracing::warn!(%error, "invite email delivery failed");
            return Err(ApiError(
                StatusCode::BAD_GATEWAY,
                "invitation email could not be sent",
            ));
        }
    };
    Ok(Json(
        json!({"id":hash(&token),"token":if email_sent { Value::Null } else { json!(token) },"code":if email_sent { Value::Null } else { json!(invite_code(&s.invite_mail.public_url, &token)) },"expires_at":if expires == INVITE_NEVER { Value::Null } else { json!(expires) },"max_uses":max_uses,"server_id":server_id,"email":email,"email_sent":email_sent,"link":link}),
    ))
}
async fn invites(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
) -> ApiResult<Value> {
    owner(&p)?;
    let db = s.db.lock().unwrap();
    let mut q = db.prepare(
        "SELECT token_hash,expires_at,used_at,email,uses,max_uses,server_id FROM invites ORDER BY rowid DESC LIMIT 500",
    )?;
    let rows = q
        .query_map([], |r| {
            let expires: i64 = r.get(1)?;
            Ok(json!({"id":r.get::<_,String>(0)?,"expires_at":if expires == INVITE_NEVER { Value::Null } else { json!(expires) },"used_at":r.get::<_,Option<i64>>(2)?,"email":r.get::<_,String>(3)?,"uses":r.get::<_,i64>(4)?,"max_uses":r.get::<_,Option<i64>>(5)?,"server_id":r.get::<_,String>(6)?}))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Json(json!({"invites":rows})))
}
async fn revoke_invite(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Value> {
    owner(&p)?;
    if s.db
        .lock()
        .unwrap()
        .execute("DELETE FROM invites WHERE token_hash=?", [id])?
        == 0
    {
        return Err(missing());
    }
    Ok(Json(json!({"ok":true})))
}
async fn revoke_user_sessions(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Value> {
    owner(&p)?;
    let count =
        s.db.lock()
            .unwrap()
            .execute("DELETE FROM sessions WHERE user_id=?", [id])?;
    Ok(Json(json!({"ok":true,"revoked":count})))
}

async fn disable_user(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Value> {
    owner(&p)?;
    if id == p.user.id {
        return Err(conflict("the owner account cannot disable itself"));
    }
    let mut db = s.db.lock().unwrap();
    let tx = db.transaction()?;
    if tx.execute("UPDATE users SET disabled=1 WHERE id=?", [&id])? == 0 {
        return Err(missing());
    }
    let revoked = tx.execute("DELETE FROM sessions WHERE user_id=?", [&id])?;
    tx.commit()?;
    Ok(Json(
        json!({"ok":true,"disabled":true,"sessions_revoked":revoked}),
    ))
}

#[derive(Deserialize)]
struct Accept {
    token: String,
    username: String,
    password: String,
    device_name: String,
}
async fn accept(State(s): State<AppState>, Json(v): Json<Accept>) -> ApiResult<Value> {
    credentials(&v.username, &v.password, &v.device_name)?;
    if v.token.len() != 64 {
        return Err(bad("invalid invite"));
    }
    let pw = password_hash(&s, v.password).await?;
    let mut db = s.db.lock().unwrap();
    let tx = db.transaction()?;
    if tx.execute(
        "UPDATE invites SET uses=uses+1,used_at=COALESCE(used_at,?1) WHERE token_hash=?2 AND expires_at>?1 AND (max_uses IS NULL OR uses<max_uses)",
        params![now(), hash(&v.token)],
    )? != 1
    {
        return Err(bad("invalid or expired invite"));
    }
    if tx
        .query_row(
            "SELECT 1 FROM users WHERE username=?",
            [&v.username],
            |_| Ok(()),
        )
        .optional()?
        .is_some()
    {
        return Err(conflict("username unavailable"));
    }
    let u = User {
        id: secret(),
        username: v.username,
        is_owner: false,
    };
    tx.execute(
        "INSERT INTO users(id,username,password,is_owner) VALUES(?,?,?,0)",
        params![u.id, u.username, pw],
    )?;
    let server_id: String = tx.query_row(
        "SELECT server_id FROM invites WHERE token_hash=?",
        [hash(&v.token)],
        |r| r.get(0),
    )?;
    servers::join(&tx, &u.id, &server_id)?;
    let result = session(&tx, u, &v.device_name)?;
    tx.commit()?;
    Ok(Json(result))
}
#[derive(Deserialize)]
struct Redeem {
    token: String,
}
/// A signed-in person joins the invite's server. Existing members are told so without spending a use.
async fn redeem_invite(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Json(v): Json<Redeem>,
) -> ApiResult<Value> {
    if v.token.len() != 64 {
        return Err(bad("invalid invite"));
    }
    let (token_hash, at) = (hash(&v.token), now());
    let mut db = s.db.lock().unwrap();
    let tx = db.transaction()?;
    let server_id: String = tx
        .query_row(
            "SELECT server_id FROM invites WHERE token_hash=? AND expires_at>?",
            params![token_hash, at],
            |r| r.get(0),
        )
        .optional()?
        .ok_or_else(|| bad("invalid or expired invite"))?;
    let member = tx
        .query_row(
            "SELECT 1 FROM server_members WHERE server_id=? AND user_id=?",
            params![server_id, p.user.id],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !member {
        if tx.execute(
            "UPDATE invites SET uses=uses+1,used_at=COALESCE(used_at,?1) WHERE token_hash=?2 AND (max_uses IS NULL OR uses<max_uses)",
            params![at, token_hash],
        )? != 1
        {
            return Err(bad("invalid or expired invite"));
        }
        servers::join(&tx, &p.user.id, &server_id)?;
    }
    tx.commit()?;
    Ok(Json(json!({"server_id":server_id,"joined":!member})))
}
async fn me(State(s): State<AppState>, Extension(p): Extension<Principal>) -> Json<Value> {
    let (display_name, avatar_rev, bio) =
        s.db.lock()
            .unwrap()
            .query_row(
                "SELECT display_name,avatar_rev,bio FROM users WHERE id=?",
                [&p.user.id],
                |r| {
                    Ok((
                        r.get::<_, Option<String>>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, Option<String>>(2)?,
                    ))
                },
            )
            .unwrap_or((None, 0, None));
    let mut user = json!(p.user);
    user["display_name"] = json!(display_name);
    user["avatar_rev"] = json!(avatar_rev);
    user["bio"] = json!(bio);
    Json(
        json!({"user":user,"session_id":p.session_id,"capabilities":{"password":true,"passkeys":s.passkeys.is_some(),"chat":true,"embeds":true,"uploads":s.media.is_some(),"transcode":s.transcoder.is_some(),"plex":s.plex.is_some() && s.voice.is_some(),"voice":s.voice.is_some(),"activities":false,"activity_sync":true,"activity_playback":false,"vm_input":s.vm.is_some() && s.voice.is_some(),"vm_reset":s.vm.as_ref().is_some_and(|vm| vm.reset_socket.is_some()) && s.voice.is_some(),"vm_media":s.vm_media.configured() && s.voice.is_some(),"giphy":giphy::configured(),"gimme_dry_run":s.gimme.is_dry_run(),"dj":s.dj.is_some() && s.voice.is_some(),"push":false}}),
    )
}
async fn devices(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
) -> ApiResult<Value> {
    let db = s.db.lock().unwrap();
    let mut q=db.prepare("SELECT id,device_name,created_at,expires_at FROM sessions WHERE user_id=? AND expires_at>?")?;
    let rows=q.query_map(params![p.user.id,now()],|r|{let id:String=r.get(0)?;Ok(json!({"current":id==p.session_id,"id":id,"device_name":r.get::<_,String>(1)?,"created_at":r.get::<_,i64>(2)?,"expires_at":r.get::<_,i64>(3)?}))})?.collect::<Result<Vec<_>,_>>()?;
    Ok(Json(json!({"devices":rows})))
}
async fn revoke(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Value> {
    if s.db.lock().unwrap().execute(
        "DELETE FROM sessions WHERE id=? AND user_id=?",
        params![id, p.user.id],
    )? == 0
    {
        return Err(missing());
    }
    Ok(Json(json!({"ok":true})))
}
async fn channels(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
) -> ApiResult<Value> {
    let db = s.db.lock().unwrap();
    // `peer_id` is the other person in a two-person direct conversation (null elsewhere), so a
    // client can find the existing conversation before it creates another one.
    let mut q=db.prepare("SELECT c.id,c.name,c.kind,c.server_id,(SELECT m2.user_id FROM members m2 WHERE c.kind='dm' AND m2.channel_id=c.id AND m2.user_id<>?1) FROM channels c JOIN members m ON m.channel_id=c.id WHERE m.user_id=?1 ORDER BY c.name")?;
    let rows=q.query_map([p.user.id],|r|Ok(json!({"id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"kind":r.get::<_,String>(2)?,"server_id":r.get::<_,Option<String>>(3)?,"peer_id":r.get::<_,Option<String>>(4)?})))?.collect::<Result<Vec<_>,_>>()?;
    Ok(Json(json!({"channels":rows})))
}
#[derive(Deserialize)]
struct CreateChannel {
    server_id: Option<String>,
    name: String,
    kind: String,
    #[serde(default)]
    member_ids: Vec<String>,
}
async fn create_channel(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Json(mut v): Json<CreateChannel>,
) -> ApiResult<Value> {
    if v.name.trim().is_empty()
        || v.name.len() > 80
        || !matches!(v.kind.as_str(), "channel" | "voice" | "dm" | "group_dm")
    {
        return Err(bad("invalid conversation"));
    }
    // `voice` is a channel with a call attached: same owner-only rule, same server scope.
    let in_server = matches!(v.kind.as_str(), "channel" | "voice");
    if in_server {
        owner(&p)?
    }
    v.member_ids.push(p.user.id);
    v.member_ids.sort();
    v.member_ids.dedup();
    if v.member_ids.len() > 30
        || (v.kind == "dm" && v.member_ids.len() != 2)
        || (v.kind == "group_dm" && v.member_ids.len() < 2)
    {
        return Err(bad("invalid members"));
    }
    let mut db = s.db.lock().unwrap();
    let tx = db.transaction()?;
    let server_id = if in_server {
        Some(v.server_id.unwrap_or_else(|| "home".into()))
    } else {
        None
    };
    if let (Some(sid), "voice") = (&server_id, v.kind.as_str()) {
        servers::exists(&tx, sid)?;
        let everyone = tx
            .prepare("SELECT user_id FROM server_members WHERE server_id=?")?
            .query_map([sid], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        v.member_ids.extend(everyone);
        v.member_ids.sort();
        v.member_ids.dedup();
    }
    for id in &v.member_ids {
        if let Some(sid) = &server_id {
            servers::member(&tx, id, sid)?;
        }
        if tx
            .query_row("SELECT 1 FROM users WHERE id=?", [id], |_| Ok(()))
            .optional()?
            .is_none()
        {
            return Err(bad("unknown member"));
        }
    }
    let id = secret();
    tx.execute(
        "INSERT INTO channels(id,name,kind,server_id) VALUES(?,?,?,?)",
        params![id, v.name, v.kind, server_id],
    )?;
    for uid in v.member_ids {
        tx.execute("INSERT INTO members VALUES(?,?)", params![id, uid])?;
    }
    emit(&tx, &id, "channel.created", json!({"channel_id":id}))?;
    tx.commit()?;
    Ok(Json(
        json!({"id":id,"name":v.name,"kind":v.kind,"server_id":server_id}),
    ))
}
async fn members(State(s): State<AppState>) -> ApiResult<Value> {
    let db = s.db.lock().unwrap();
    let mut q = db.prepare(
        "SELECT id,username,is_owner,display_name,avatar_rev,bio FROM users WHERE disabled=0 ORDER BY username",
    )?;
    let rows = q
        .query_map([], |r| {
            Ok(json!({
                "id": r.get::<_, String>(0)?,
                "username": r.get::<_, String>(1)?,
                "is_owner": r.get::<_, bool>(2)?,
                "display_name": r.get::<_, Option<String>>(3)?,
                "avatar_rev": r.get::<_, i64>(4)?,
                "bio": r.get::<_, Option<String>>(5)?,
            }))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Json(json!({"members":rows})))
}
#[derive(Deserialize, Default)]
struct MessageQuery {
    before: Option<i64>,
    q: Option<String>,
    pinned: Option<bool>,
    reply_to: Option<String>,
}
/// `viewer` decides what a snap shows: whether this user already opened it.
fn message(db: &Connection, id: &str, viewer: &str) -> Result<Value, ApiError> {
    let mut msg=db.query_row("SELECT id,channel_id,author_id,body,reply_to,created_at,edited_at,revision,pinned,mention_ids FROM messages WHERE id=?",[id],|r|Ok(json!({"id":r.get::<_,String>(0)?,"channel_id":r.get::<_,String>(1)?,"author_id":r.get::<_,String>(2)?,"body":r.get::<_,String>(3)?,"reply_to":r.get::<_,Option<String>>(4)?,"created_at":r.get::<_,i64>(5)?,"edited_at":r.get::<_,Option<i64>>(6)?,"revision":r.get::<_,i64>(7)?,"pinned":r.get::<_,bool>(8)?,"mention_ids":serde_json::from_str::<Value>(&r.get::<_,String>(9)?).unwrap_or(json!([]))}))).optional()?.ok_or_else(missing)?;
    let mut q = db.prepare("SELECT emoji,user_id FROM reactions WHERE message_id=?")?;
    let reactions = q
        .query_map([id], |r| {
            Ok(json!({"emoji":r.get::<_,String>(0)?,"user_id":r.get::<_,String>(1)?}))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    msg["reactions"] = json!(reactions);
    let mut q = db.prepare("SELECT role_id FROM message_roles WHERE message_id=?")?;
    let roles = q
        .query_map([id], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    msg["role_mention_ids"] = json!(roles);
    let mut q =
        db.prepare("SELECT upload_id,filename,length,(SELECT id FROM media_jobs WHERE source_id=attachments.upload_id AND status='ready' ORDER BY created_at DESC LIMIT 1),view_once FROM attachments WHERE message_id=?")?;
    let attachments=q.query_map([id],|r|{if r.get::<_,i64>(4)?!=snaps::NONE{return snaps::describe(db,&r.get::<_,String>(0)?,r.get::<_,i64>(4)?,viewer)}let job=r.get::<_,Option<String>>(3)?;let filename=r.get::<_,String>(1)?;let kind=attach_kind::kind(&filename,job.is_some());Ok(json!({"id":r.get::<_,String>(0)?,"filename":filename,"kind":kind,"length":r.get::<_,String>(2)?,"video_path":job.as_ref().map(|id|format!("/api/media-jobs/{id}/video")),"thumbnail_path":job.as_ref().map(|id|format!("/api/media-jobs/{id}/thumbnail"))}))})?.collect::<Result<Vec<_>,_>>()?;
    msg["attachments"] = json!(attachments);
    Ok(msg)
}
fn message_access(
    db: &Connection,
    p: &Principal,
    id: &str,
) -> Result<(String, String, i64), ApiError> {
    let row = db
        .query_row(
            "SELECT channel_id,author_id,revision FROM messages WHERE id=?",
            [id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(missing)?;
    member(db, &p.user.id, &row.0)?;
    Ok(row)
}
async fn messages(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(cid): Path<String>,
    Query(v): Query<MessageQuery>,
) -> ApiResult<Value> {
    if v.q.as_ref().is_some_and(|q| q.len() > 256) {
        return Err(bad("query too long"));
    }
    let db = s.db.lock().unwrap();
    member(&db, &p.user.id, &cid)?;
    let mut q=db.prepare("SELECT id FROM messages WHERE channel_id=? AND created_at<? AND (?=0 OR pinned=1) AND instr(lower(body),lower(?))>0 AND (? IS NULL OR reply_to=?) ORDER BY created_at DESC,id DESC LIMIT 100")?;
    let ids = q
        .query_map(
            params![
                cid,
                v.before.unwrap_or(i64::MAX),
                v.pinned.unwrap_or(false),
                v.q.unwrap_or_default(),
                v.reply_to,
                v.reply_to
            ],
            |r| r.get::<_, String>(0),
        )?
        .collect::<Result<Vec<_>, _>>()?;
    let rows = ids
        .iter()
        .rev()
        .map(|id| message(&db, id, &p.user.id))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Json(json!({"messages":rows})))
}
#[derive(Deserialize)]
struct SendMessage {
    body: String,
    reply_to: Option<String>,
    #[serde(default)]
    mention_ids: Vec<String>,
    #[serde(default)]
    attachment_ids: Vec<uuid::Uuid>,
    #[serde(default)]
    role_mention_ids: Vec<String>,
    #[serde(default)]
    view_once: bool,
}
fn body_valid(body: &str) -> Result<(), ApiError> {
    if body.trim().is_empty() || body.len() > 16384 {
        return Err(bad("message must contain 1–16384 bytes"));
    }
    Ok(())
}
async fn send_message(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(cid): Path<String>,
    Json(mut v): Json<SendMessage>,
) -> ApiResult<Value> {
    if v.view_once && v.attachment_ids.len() != 1 {
        return Err(bad("a snap carries exactly one photo"));
    }
    if v.attachment_ids.is_empty() {
        body_valid(&v.body)?;
    } else if v.body.len() > 16384 || v.attachment_ids.len() > 20 {
        return Err(bad("invalid attachment message"));
    }
    if v.mention_ids.len() > 30 {
        return Err(bad("too many mentions"));
    }
    let mut db = s.db.lock().unwrap();
    let tx = db.transaction()?;
    member(&tx, &p.user.id, &cid)?;
    if let Some(reply) = &v.reply_to {
        let (rc, _, _) = message_access(&tx, &p, reply)?;
        if rc != cid {
            return Err(bad("reply must be in this conversation"));
        }
    }
    if v.body.contains("@everyone") {
        owner(&p)?;
        let mut q = tx.prepare("SELECT user_id FROM members WHERE channel_id=?")?;
        v.mention_ids = q
            .query_map([&cid], |r| r.get(0))?
            .collect::<Result<Vec<_>, _>>()?;
    }
    v.mention_ids
        .extend(servers::resolve_mentions(&tx, &cid, &v.role_mention_ids)?);
    v.role_mention_ids.sort();
    v.role_mention_ids.dedup();
    v.mention_ids.sort();
    v.mention_ids.dedup();
    for uid in &v.mention_ids {
        member(&tx, uid, &cid)?;
    }
    let mut attachments = Vec::new();
    for upload_id in &v.attachment_ids {
        let store = s.media.as_ref().ok_or_else(|| bad("media unavailable"))?;
        let upload = store.inspect(*upload_id, &p.user.id)?;
        if upload.channel_id != cid || upload.status != housecall_media::Status::Ready {
            return Err(bad("attachment must be clean and in this conversation"));
        }
        if v.view_once && attach_kind::kind(&upload.filename, false) != "image" {
            return Err(bad("a snap must be a photo"));
        }
        if v.view_once
            && tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM media_jobs WHERE source_id=?)",
                [upload_id.to_string()],
                |r| r.get::<_, bool>(0),
            )?
        {
            return Err(bad("a processed upload can't be sent as a snap"));
        }
        if tx
            .query_row(
                "SELECT 1 FROM attachments WHERE upload_id=?",
                [upload_id.to_string()],
                |_| Ok(()),
            )
            .optional()?
            .is_some()
        {
            return Err(conflict("attachment already belongs to a message"));
        }
        attachments.push(upload);
    }
    let id = secret();
    tx.execute("INSERT INTO messages(id,channel_id,author_id,body,reply_to,created_at,mention_ids) VALUES(?,?,?,?,?,?,?)",params![id,cid,p.user.id,v.body,v.reply_to,now(),json!(v.mention_ids).to_string()])?;
    for role in &v.role_mention_ids {
        tx.execute("INSERT INTO message_roles VALUES(?,?)", params![id, role])?;
    }
    for upload in attachments {
        tx.execute(
            "INSERT INTO attachments(upload_id,message_id,filename,length,view_once) VALUES(?,?,?,?,?)",
            params![
                upload.id.to_string(),
                id,
                upload.filename,
                upload.length.to_string(),
                if v.view_once { snaps::LIVE } else { snaps::NONE }
            ],
        )?;
    }
    for uid in &v.mention_ids {
        if uid != &p.user.id {
            tx.execute(
                "INSERT INTO notifications VALUES(?,?,?,?,?)",
                params![secret(), uid, id, cid, now()],
            )?;
            push::enqueue_alert(&tx, uid, &id, &cid)?;
        }
    }
    emit(&tx, &cid, "message.created", json!({"message_id":id}))?;
    let result = message(&tx, &id, &p.user.id)?;
    tx.commit()?;
    Ok(Json(result))
}
#[derive(Deserialize)]
struct EditMessage {
    body: String,
    revision: i64,
}
async fn edit_message(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
    Json(v): Json<EditMessage>,
) -> ApiResult<Value> {
    body_valid(&v.body)?;
    let mut db = s.db.lock().unwrap();
    let tx = db.transaction()?;
    let (cid, author, revision) = message_access(&tx, &p, &id)?;
    if author != p.user.id {
        return Err(forbidden());
    }
    if revision != v.revision {
        return Err(conflict("message changed; reload before editing"));
    }
    tx.execute(
        "UPDATE messages SET body=?,edited_at=?,revision=revision+1 WHERE id=?",
        params![v.body, now(), id],
    )?;
    emit(&tx, &cid, "message.edited", json!({"message_id":id}))?;
    let result = message(&tx, &id, &p.user.id)?;
    tx.commit()?;
    Ok(Json(result))
}
async fn unsend(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Value> {
    let mut db = s.db.lock().unwrap();
    let tx = db.transaction()?;
    let (cid, author, _) = message_access(&tx, &p, &id)?;
    if author != p.user.id && !p.user.is_owner {
        return Err(forbidden());
    }
    let attachment_ids = {
        let mut q = tx.prepare("SELECT upload_id FROM attachments WHERE message_id=?")?;
        let ids = q
            .query_map([&id], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        ids
    };
    for aid in &attachment_ids {
        tx.execute("DELETE FROM snap_views WHERE upload_id=?", [aid])?;
    }
    if let Some(store) = &s.media {
        for aid in attachment_ids {
            let aid = uuid::Uuid::parse_str(&aid).map_err(|_| bad("invalid stored attachment"))?;
            transcode::purge_source(&tx, store, aid, &author)?;
            match store.delete(aid, &author) {
                Ok(()) | Err(housecall_media::Error::NotFound) => {}
                Err(e) => return Err(e.into()),
            }
        }
    }
    tx.execute("UPDATE messages SET reply_to=NULL WHERE reply_to=?", [&id])?;
    push::enqueue_retract(&tx, &id, &cid)?;
    tx.execute("DELETE FROM messages WHERE id=?", [&id])?;
    tx.execute("DELETE FROM reads WHERE message_id=?", [&id])?;
    emit(
        &tx,
        &cid,
        "message.deleted",
        json!({"message_id":id,"notifications_retracted":true}),
    )?;
    tx.commit()?;
    Ok(Json(json!({"ok":true})))
}
#[derive(Deserialize)]
struct Reaction {
    emoji: String,
}
async fn react(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
    Json(v): Json<Reaction>,
) -> ApiResult<Value> {
    if v.emoji.is_empty() || v.emoji.len() > 32 || v.emoji.chars().any(char::is_control) {
        return Err(bad("invalid reaction"));
    }
    let mut db = s.db.lock().unwrap();
    let tx = db.transaction()?;
    let (cid, _, _) = message_access(&tx, &p, &id)?;
    if tx.execute(
        "DELETE FROM reactions WHERE message_id=? AND user_id=? AND emoji=?",
        params![id, p.user.id, v.emoji],
    )? == 0
    {
        tx.execute(
            "INSERT INTO reactions VALUES(?,?,?)",
            params![id, p.user.id, v.emoji],
        )?;
    }
    emit(&tx, &cid, "message.reactions", json!({"message_id":id}))?;
    tx.commit()?;
    Ok(Json(json!({"ok":true})))
}
#[derive(Deserialize)]
struct Pin {
    pinned: bool,
}
async fn pin(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
    Json(v): Json<Pin>,
) -> ApiResult<Value> {
    let mut db = s.db.lock().unwrap();
    let tx = db.transaction()?;
    let (cid, _, _) = message_access(&tx, &p, &id)?;
    tx.execute(
        "UPDATE messages SET pinned=? WHERE id=?",
        params![v.pinned, id],
    )?;
    emit(&tx, &cid, "message.pinned", json!({"message_id":id}))?;
    tx.commit()?;
    Ok(Json(json!({"ok":true})))
}
#[derive(Deserialize)]
struct Read {
    message_id: String,
}
async fn mark_read(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(cid): Path<String>,
    Json(v): Json<Read>,
) -> ApiResult<Value> {
    let db = s.db.lock().unwrap();
    member(&db, &p.user.id, &cid)?;
    let (mc, _, _) = message_access(&db, &p, &v.message_id)?;
    if mc != cid {
        return Err(bad("message must be in conversation"));
    }
    db.execute("INSERT INTO reads VALUES(?,?,?) ON CONFLICT(channel_id,user_id) DO UPDATE SET message_id=excluded.message_id",params![cid,p.user.id,v.message_id])?;
    db.execute("DELETE FROM notifications WHERE user_id=? AND channel_id=? AND message_id IN (SELECT id FROM messages WHERE created_at<=(SELECT created_at FROM messages WHERE id=?))",params![p.user.id,cid,v.message_id])?;
    Ok(Json(json!({"ok":true})))
}
#[derive(Deserialize)]
struct Typing {
    active: bool,
}
async fn typing(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(cid): Path<String>,
    Json(v): Json<Typing>,
) -> ApiResult<Value> {
    let db = s.db.lock().unwrap();
    member(&db, &p.user.id, &cid)?;
    emit(
        &db,
        &cid,
        "typing",
        json!({"user_id":p.user.id,"active":v.active,"expires_at":now()+6000}),
    )?;
    Ok(Json(json!({"ok":true})))
}
async fn notifications(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
) -> ApiResult<Value> {
    let db = s.db.lock().unwrap();
    let mut q=db.prepare("SELECT id,message_id,channel_id,created_at FROM notifications WHERE user_id=? AND EXISTS(SELECT 1 FROM members WHERE members.channel_id=notifications.channel_id AND members.user_id=notifications.user_id) ORDER BY created_at DESC LIMIT 500")?;
    let rows=q.query_map([p.user.id],|r|Ok(json!({"id":r.get::<_,String>(0)?,"message_id":r.get::<_,String>(1)?,"channel_id":r.get::<_,String>(2)?,"created_at":r.get::<_,i64>(3)?})))?.collect::<Result<Vec<_>,_>>()?;
    Ok(Json(json!({"notifications":rows})))
}
#[derive(Deserialize)]
struct EventQuery {
    #[serde(default)]
    after: i64,
}
async fn events(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Query(v): Query<EventQuery>,
) -> ApiResult<Value> {
    if v.after < 0 {
        return Err(bad("invalid cursor"));
    }
    let db = s.db.lock().unwrap();
    let mut q=db.prepare("SELECT id,kind,channel_id,payload,created_at FROM events WHERE user_id=? AND id>? AND (channel_id IS NULL OR EXISTS(SELECT 1 FROM members WHERE members.channel_id=events.channel_id AND members.user_id=events.user_id)) ORDER BY id LIMIT 500")?;
    let rows=q.query_map(params![p.user.id,v.after],|r|Ok(json!({"id":r.get::<_,i64>(0)?,"kind":r.get::<_,String>(1)?,"channel_id":r.get::<_,Option<String>>(2)?,"payload":serde_json::from_str::<Value>(&r.get::<_,String>(3)?).unwrap_or(Value::Null),"created_at":r.get::<_,i64>(4)?})))?.collect::<Result<Vec<_>,_>>()?;
    let cursor = rows
        .last()
        .and_then(|v| v["id"].as_i64())
        .unwrap_or(v.after);
    // `now` lets a client tell a fresh event (a ringing call) from one replayed after sign-in
    // without trusting its own clock.
    Ok(Json(json!({"events":rows,"cursor":cursor,"now":now()})))
}
#[derive(Deserialize)]
struct Report {
    kind: String,
    body: String,
    logs: Option<String>,
    #[serde(default)]
    logs_consent: bool,
    screenshot_id: Option<String>,
    #[serde(default)]
    screenshot_consent: bool,
}
async fn report(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Json(v): Json<Report>,
) -> ApiResult<Value> {
    if !matches!(v.kind.as_str(), "bug" | "feature")
        || v.body.trim().is_empty()
        || v.body.len() > 32768
    {
        return Err(bad("invalid report"));
    }
    if v.logs.is_some() && !v.logs_consent {
        return Err(bad("logs require explicit consent"));
    }
    if let Some(id) = &v.screenshot_id {
        if !v.screenshot_consent {
            return Err(bad("screenshot requires explicit consent"));
        }
        let uid = uuid::Uuid::parse_str(id).map_err(|_| bad("invalid screenshot ID"))?;
        let upload = s
            .media
            .as_ref()
            .ok_or_else(|| bad("media unavailable"))?
            .inspect(uid, &p.user.id)?;
        if upload.status != housecall_media::Status::Ready {
            return Err(bad("screenshot must pass scanning"));
        }
        let is_snap = s.db.lock().unwrap().query_row(
            "SELECT EXISTS(SELECT 1 FROM attachments WHERE upload_id=? AND view_once<>0)",
            [id],
            |r| r.get::<_, bool>(0),
        )?;
        if is_snap {
            return Err(bad("a snap can't be attached to a report"));
        }
    }
    if v.logs.as_ref().is_some_and(|v| v.len() > 65536) {
        return Err(bad("logs too large"));
    }
    let id = secret();
    let mut db = s.db.lock().unwrap();
    let tx = db.transaction()?;
    tx.execute(
        "INSERT INTO reports(id,user_id,kind,body,logs,created_at) VALUES(?,?,?,?,?,?)",
        params![
            id,
            p.user.id,
            v.kind,
            v.body,
            v.logs.map(|s| redact_logs(&s)),
            now()
        ],
    )?;
    if let Some(upload_id) = v.screenshot_id {
        tx.execute(
            "INSERT INTO report_media VALUES(?,?)",
            params![id, upload_id],
        )?;
    }
    tx.commit()?;
    Ok(Json(json!({"id":id})))
}
async fn report_screenshot(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    owner(&p)?;
    let upload_id = {
        let db = s.db.lock().unwrap();
        db.query_row(
            "SELECT upload_id FROM report_media WHERE report_id=?",
            [id],
            |r| r.get::<_, String>(0),
        )
        .optional()?
        .ok_or_else(missing)?
    };
    let id = uuid::Uuid::parse_str(&upload_id).map_err(|_| bad("invalid stored upload"))?;
    let store = s.media.clone().ok_or_else(missing)?;
    let metadata = store.metadata(id)?;
    media::authorized_stream(store, metadata, headers).await
}
pub fn redact_logs(input: &str) -> String {
    input
        .lines()
        .map(|line| {
            let low = line.to_ascii_lowercase();
            if [
                "token",
                "password",
                "authorization",
                "secret",
                "cookie",
                "key",
            ]
            .iter()
            .any(|k| low.contains(k))
            {
                "[redacted sensitive log line]"
            } else {
                line
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}
async fn reports(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
) -> ApiResult<Value> {
    owner(&p)?;
    let db = s.db.lock().unwrap();
    let mut q=db.prepare("SELECT id,user_id,kind,body,logs,created_at,status,(SELECT upload_id FROM report_media WHERE report_id=reports.id) FROM reports ORDER BY created_at DESC LIMIT 500")?;
    let rows=q.query_map([],|r|Ok(json!({"id":r.get::<_,String>(0)?,"user_id":r.get::<_,String>(1)?,"kind":r.get::<_,String>(2)?,"body":r.get::<_,String>(3)?,"logs":r.get::<_,Option<String>>(4)?,"created_at":r.get::<_,i64>(5)?,"status":r.get::<_,String>(6)?,"screenshot_id":r.get::<_,Option<String>>(7)?})))?.collect::<Result<Vec<_>,_>>()?;
    Ok(Json(json!({"reports":rows})))
}
#[derive(Deserialize)]
struct Resolve {
    status: String,
}
async fn resolve_report(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
    Json(v): Json<Resolve>,
) -> ApiResult<Value> {
    owner(&p)?;
    if !matches!(v.status.as_str(), "open" | "resolved") {
        return Err(bad("invalid status"));
    }
    if s.db.lock().unwrap().execute(
        "UPDATE reports SET status=? WHERE id=?",
        params![v.status, id],
    )? == 0
    {
        return Err(missing());
    }
    Ok(Json(json!({"ok":true})))
}
