//! LINK-V1 server side: QR login links. State lives in memory only (LINK-V1 11.1). Raw secrets and
//! raw device keys are never stored, and nothing secret is logged.
use crate::{bad, conflict, forbidden, missing, now, ApiError, ApiResult, AppState, Principal, User};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::{get, post},
    Extension, Json, Router,
};
use rand::RngCore;
use rusqlite::OptionalExtension;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::atomic::{AtomicUsize, Ordering},
};

const LIFETIME_MS: i64 = 120_000;
const RESULT_WINDOW_MS: i64 = 60_000;
const KEEP_ENDED_MS: i64 = 600_000;
const MAX_LINKS: usize = 1000;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum LinkState {
    Started,
    Claimed,
    Approved,
    Denied,
    Expired,
    Burnt,
}
impl LinkState {
    fn name(self) -> &'static str {
        match self {
            Self::Started => "started",
            Self::Claimed => "claimed",
            Self::Approved => "approved",
            Self::Denied => "denied",
            Self::Expired => "expired",
            Self::Burnt => "burnt",
        }
    }
    fn ended(self) -> bool {
        matches!(self, Self::Denied | Self::Expired | Self::Burnt)
    }
}
#[derive(Clone)]
pub struct Claim {
    device_name: String,
    /// The existing hash() of the 64-hex device key: also the session's device_hash.
    device_hash: String,
    ephemeral_pub: String,
    claim_tag: String,
    claimed_at: i64,
}
#[derive(Clone)]
pub struct Link {
    user_id: String,
    session_id: String,
    secret_hash: [u8; 32],
    state: LinkState,
    burn_reason: Option<&'static str>,
    expires_at: i64,
    ended_at: Option<i64>,
    claim: Option<Claim>,
    wrapped_keys: Option<String>,
    approved_at: i64,
    wrong_secrets: u32,
}
impl Link {
    fn end(&mut self, state: LinkState, at: i64) {
        self.state = state;
        self.ended_at = Some(at);
    }
    fn burn(&mut self, reason: &'static str, id: &str) {
        self.end(LinkState::Burnt, now());
        self.burn_reason = Some(reason);
        self.wrapped_keys = None;
        tracing::info!("link burnt link={} reason={reason}", &id[..8]);
    }
    /// Moves a link past its deadline into EXPIRED.
    fn refresh(&mut self, id: &str, at: i64) {
        let deadline = match self.state {
            LinkState::Started | LinkState::Claimed => self.expires_at,
            LinkState::Approved => self.approved_at + RESULT_WINDOW_MS,
            _ => return,
        };
        if at >= deadline {
            self.end(LinkState::Expired, deadline);
            self.wrapped_keys = None;
            tracing::info!("link expired link={}", &id[..8]);
        }
    }
}
pub type Links = std::sync::Arc<std::sync::Mutex<HashMap<String, Link>>>;

static DUMMY_COMPARES: AtomicUsize = AtomicUsize::new(0);
/// How many secret checks ran against the fixed dummy digest (an unknown link id). For tests.
#[doc(hidden)]
pub fn dummy_compares() -> usize {
    DUMMY_COMPARES.load(Ordering::SeqCst)
}
/// Test hook: pretends `ms` milliseconds have passed for one link by moving its deadlines back.
#[doc(hidden)]
pub fn age_for_test(s: &AppState, id: &str, ms: i64) {
    if let Some(l) = s.links.lock().unwrap().get_mut(id) {
        l.expires_at -= ms;
        l.approved_at -= ms;
    }
}
const DUMMY: [u8; 32] = [0x5a; 32];

/// Branch-free comparison: the time does not depend on how many bytes match.
pub fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b) {
        diff |= x ^ y;
    }
    diff == 0
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/link/start", post(start))
        .route("/link/{id}", get(status))
        .route("/link/{id}/approve", post(approve))
        .route("/link/{id}/deny", post(deny))
}
pub fn public_routes() -> Router<AppState> {
    Router::new()
        .route("/link/claim", post(claim))
        .route("/link/result", post(result))
}

fn invalid() -> ApiError {
    bad("invalid link request")
}
fn busy() -> ApiError {
    ApiError(StatusCode::TOO_MANY_REQUESTS, "try again later")
}
fn used() -> ApiError {
    conflict("link already used")
}
fn expired() -> ApiError {
    ApiError(StatusCode::GONE, "link expired")
}
fn valid_id(v: &str) -> bool {
    v.len() == 32 && v.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn valid_device_key(v: &str) -> bool {
    v.len() == 64 && v.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn b64_exact(v: &str, len: usize) -> Option<Vec<u8>> {
    crate::identity::unb64u(v).filter(|b| b.len() == len)
}
fn valid_name(v: &str) -> Option<String> {
    let v = v.trim();
    if v.is_empty() || v.len() > 80 || v.chars().any(|c| c.is_control() || crate::profile::invisible(c)) {
        return None;
    }
    Some(v.to_owned())
}
fn sweep(links: &mut HashMap<String, Link>, at: i64) {
    for (id, l) in links.iter_mut() {
        l.refresh(id, at);
    }
    links.retain(|_, l| l.ended_at.is_none_or(|e| e + KEEP_ENDED_MS > at));
}

/// Looks the link up by id only, then checks the secret in constant time. Unknown ids use a
/// fixed dummy digest and take the same path. A wrong secret on a live link counts toward the
/// third strike. Every failure is the same 404.
fn open<'a>(
    links: &'a mut HashMap<String, Link>,
    id: &str,
    secret: &[u8],
) -> Result<&'a mut Link, ApiError> {
    let presented: [u8; 32] = Sha256::digest(secret).into();
    let entry = links.get_mut(id);
    let stored = match &entry {
        Some(l) => l.secret_hash,
        None => {
            DUMMY_COMPARES.fetch_add(1, Ordering::SeqCst);
            DUMMY
        }
    };
    let ok = ct_eq(&stored, &presented);
    match entry {
        Some(l) if ok => Ok(l),
        Some(l) => {
            if !l.state.ended() {
                l.wrong_secrets += 1;
                if l.wrong_secrets >= 3 {
                    l.burn("wrong_secret", id);
                }
            }
            Err(missing())
        }
        None => Err(missing()),
    }
}

async fn start(State(s): State<AppState>, Extension(p): Extension<Principal>) -> ApiResult<Value> {
    if s.limited(format!("link-start:{}", p.user.id), 5) {
        return Err(busy());
    }
    let (mut id, mut secret) = ([0u8; 16], [0u8; 32]);
    rand::rngs::OsRng.fill_bytes(&mut id);
    rand::rngs::OsRng.fill_bytes(&mut secret);
    let (id, at) = (hex::encode(id), now());
    let mut links = s.links.lock().unwrap();
    sweep(&mut links, at);
    for (lid, l) in links.iter_mut() {
        if l.session_id == p.session_id && l.state == LinkState::Started {
            l.end(LinkState::Denied, at);
            tracing::info!("link denied link={}", &lid[..8]);
        }
    }
    if links.len() >= MAX_LINKS {
        links.retain(|_, l| !l.state.ended());
        if links.len() >= MAX_LINKS {
            return Err(ApiError(StatusCode::SERVICE_UNAVAILABLE, "try again later"));
        }
    }
    let expires_at = at + LIFETIME_MS;
    links.insert(
        id.clone(),
        Link {
            user_id: p.user.id.clone(),
            session_id: p.session_id.clone(),
            secret_hash: Sha256::digest(secret).into(),
            state: LinkState::Started,
            burn_reason: None,
            expires_at,
            ended_at: None,
            claim: None,
            wrapped_keys: None,
            approved_at: 0,
            wrong_secrets: 0,
        },
    );
    tracing::info!("link started user={} link={}", p.user.id, &id[..8]);
    Ok(Json(json!({
        "link_id": id,
        "secret": crate::identity::b64u(&secret),
        "expires_at": expires_at
    })))
}

#[derive(Deserialize)]
struct Claim_ {
    link_id: String,
    secret: String,
    device_name: String,
    device_key: String,
    ephemeral_pub: String,
    claim_tag: String,
}
async fn claim(State(s): State<AppState>, Json(v): Json<Claim_>) -> ApiResult<Value> {
    let secret = b64_exact(&v.secret, 32).ok_or_else(invalid)?;
    let ephemeral = b64_exact(&v.ephemeral_pub, 32).ok_or_else(invalid)?;
    b64_exact(&v.claim_tag, 16).ok_or_else(invalid)?;
    let name = valid_name(&v.device_name).ok_or_else(invalid)?;
    if !valid_id(&v.link_id) || !valid_device_key(&v.device_key) || ephemeral.iter().all(|b| *b == 0) {
        return Err(invalid());
    }
    let at = now();
    let user_id = {
        let mut links = s.links.lock().unwrap();
        sweep(&mut links, at);
        let l = open(&mut links, &v.link_id, &secret)?;
        match l.state {
            LinkState::Expired => return Err(expired()),
            LinkState::Burnt | LinkState::Denied => return Err(used()),
            LinkState::Claimed | LinkState::Approved => {
                l.burn("double_claim", &v.link_id);
                return Err(used());
            }
            LinkState::Started => {}
        }
        l.user_id.clone()
    };
    let (username, display): (String, Option<String>) = {
        let db = s.db.lock().unwrap();
        db.query_row(
            "SELECT username,display_name FROM users WHERE id=? AND disabled=0",
            [&user_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?
        .ok_or_else(missing)?
    };
    let mut links = s.links.lock().unwrap();
    let l = links.get_mut(&v.link_id).ok_or_else(missing)?;
    // Another claim may have landed while the database was read.
    if l.state != LinkState::Started {
        if matches!(l.state, LinkState::Claimed | LinkState::Approved) {
            l.burn("double_claim", &v.link_id);
        }
        return Err(used());
    }
    l.claim = Some(Claim {
        device_name: name,
        device_hash: crate::hash(&v.device_key),
        ephemeral_pub: v.ephemeral_pub,
        claim_tag: v.claim_tag,
        claimed_at: at,
    });
    l.state = LinkState::Claimed;
    tracing::info!("link claimed link={}", &v.link_id[..8]);
    Ok(Json(json!({"username": username, "display_name": display})))
}

/// The starting session's own link, or 404 (unknown) / 403 (another session).
fn own<'a>(
    links: &'a mut HashMap<String, Link>,
    id: &str,
    p: &Principal,
) -> Result<&'a mut Link, ApiError> {
    if !valid_id(id) {
        return Err(missing());
    }
    sweep_one(links, id);
    let l = links.get_mut(id).ok_or_else(missing)?;
    if l.session_id != p.session_id {
        return Err(forbidden());
    }
    Ok(l)
}
fn sweep_one(links: &mut HashMap<String, Link>, id: &str) {
    if let Some(l) = links.get_mut(id) {
        l.refresh(id, now());
    }
}
async fn status(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Value> {
    let mut links = s.links.lock().unwrap();
    let l = own(&mut links, &id, &p)?;
    let claim = l.claim.as_ref().filter(|_| l.state != LinkState::Started).map(|c| {
        json!({"device_name": c.device_name, "ephemeral_pub": c.ephemeral_pub, "claim_tag": c.claim_tag, "claimed_at": c.claimed_at})
    });
    Ok(Json(json!({
        "state": l.state.name(),
        "expires_at": l.expires_at,
        "burn_reason": l.burn_reason,
        "claim": claim
    })))
}
async fn approve(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
    Json(v): Json<Value>,
) -> ApiResult<Value> {
    let mut links = s.links.lock().unwrap();
    let l = own(&mut links, &id, &p)?;
    let wrapped = match v.get("wrapped_keys") {
        Some(Value::Null) => None,
        Some(Value::String(w)) => match crate::identity::unb64u(w) {
            Some(b) if (79..=65536).contains(&b.len()) && b[0] == 1 => Some(w.clone()),
            _ => return Err(invalid()),
        },
        _ => return Err(invalid()),
    };
    match l.state {
        LinkState::Expired => return Err(expired()),
        LinkState::Claimed => {}
        _ => return Err(conflict("link is not waiting for approval")),
    }
    l.state = LinkState::Approved;
    l.approved_at = now();
    l.wrapped_keys = wrapped;
    tracing::info!("link approved link={}", &id[..8]);
    Ok(Json(json!({"state": "approved"})))
}
async fn deny(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Value> {
    let mut links = s.links.lock().unwrap();
    let l = own(&mut links, &id, &p)?;
    if !matches!(l.state, LinkState::Started | LinkState::Claimed) {
        return Err(conflict("link is not waiting for approval"));
    }
    l.end(LinkState::Denied, now());
    tracing::info!("link denied link={}", &id[..8]);
    Ok(Json(json!({"state": "denied"})))
}

#[derive(Deserialize)]
struct ResultReq {
    link_id: String,
    secret: String,
    device_key: String,
}
async fn result(State(s): State<AppState>, Json(v): Json<ResultReq>) -> ApiResult<Value> {
    let secret = b64_exact(&v.secret, 32).ok_or_else(invalid)?;
    if !valid_id(&v.link_id) || !valid_device_key(&v.device_key) {
        return Err(invalid());
    }
    if s.limited(format!("link-result:{}", v.link_id), 60) {
        return Err(busy());
    }
    let at = now();
    let (user_id, device_hash, name, wrapped) = {
        let mut links = s.links.lock().unwrap();
        sweep(&mut links, at);
        let l = open(&mut links, &v.link_id, &secret)?;
        let presented = crate::hash(&v.device_key);
        let claimed = match &l.claim {
            Some(c) if ct_eq(c.device_hash.as_bytes(), presented.as_bytes()) => c.clone(),
            _ => return Err(missing()),
        };
        match l.state {
            LinkState::Started => return Err(missing()),
            LinkState::Claimed => return Err(conflict("waiting for approval")),
            LinkState::Burnt => return Err(used()),
            LinkState::Denied => return Err(ApiError(StatusCode::FORBIDDEN, "link denied")),
            LinkState::Expired => return Err(expired()),
            LinkState::Approved => {}
        }
        let wrapped = l.wrapped_keys.take();
        l.burn("used", &v.link_id);
        (l.user_id.clone(), claimed.device_hash, claimed.device_name, wrapped)
    };
    let db = s.db.lock().unwrap();
    let user: User = db
        .query_row(
            "SELECT id,username,is_owner FROM users WHERE id=? AND disabled=0",
            [&user_id],
            |r| Ok(User { id: r.get(0)?, username: r.get(1)?, is_owner: r.get(2)? }),
        )
        .optional()?
        .ok_or_else(missing)?;
    let mut out = crate::session_with(&db, user, &name, "qr", Some(device_hash))?;
    if let Some(o) = out.as_object_mut() {
        o.insert("wrapped_keys".into(), json!(wrapped));
    }
    tracing::info!("qr session created user={} session={}", user_id, out["session_id"].as_str().unwrap_or(""));
    out.as_object_mut().map(|o| o.remove("session_id"));
    Ok(Json(out))
}
