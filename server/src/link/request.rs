//! Request direction (hcr1), deliberately separate from LINK-V1. No central account routes.
use super::*;

#[derive(Clone)]
pub struct Request {
    link: Link,
    device_name: String,
    browser_origin: String,
    device_hash: String,
    requester_session: Option<String>,
    username: Option<String>,
    // Random phone-created UX confirmation, never returned by status or encoded in a QR.
    confirmation: Option<String>,
}
pub type Requests = std::sync::Arc<std::sync::Mutex<HashMap<String, Request>>>;
pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/link/unlock-request", post(unlock))
        .route("/link/request/{id}", get(phone_status))
        .route("/link/request/{id}/claim", post(claim_request))
        .route("/link/request/{id}/approve", post(approve_request))
        .route("/link/request/{id}/deny", post(deny_request))
        .route("/link/request/{id}/collect", post(collect_unlock))
        .route("/link/request/{id}/status", post(unlock_status))
        .route("/link/request/{id}/cancel", post(cancel_unlock))
}
pub fn public_routes() -> Router<AppState> {
    Router::new()
        .route("/link/request", post(start_request))
        .route("/link/request/status", post(request_status))
        .route("/link/request/cancel", post(cancel_request))
        .route("/link/request/collect", post(collect_signin))
}
fn enabled(s: &AppState) -> Result<(), ApiError> {
    if s.link_request_enabled {
        Ok(())
    } else {
        Err(missing())
    }
}
fn sweep_requests(m: &mut HashMap<String, Request>) {
    let at = now();
    for (id, r) in m.iter_mut() {
        r.link.refresh(id, at);
        if r.link.state.ended() {
            r.confirmation = None;
        }
    }
    m.retain(|_, r| r.link.ended_at.is_none_or(|e| e + KEEP_ENDED_MS > at));
}
#[derive(Deserialize)]
struct Start {
    #[serde(default = "default_browser_origin")]
    browser_origin: String,
    device_name: String,
    device_key: String,
}
fn default_browser_origin() -> String {
    "http://localhost".into()
}
fn create(s: &AppState, v: Start, p: Option<&Principal>) -> ApiResult<Value> {
    enabled(s)?;
    let name = valid_name(&v.device_name).ok_or_else(invalid)?;
    let browser = reqwest::Url::parse(&v.browser_origin).map_err(|_| invalid())?;
    if browser.origin().ascii_serialization() != v.browser_origin
        || !(browser.scheme() == "https"
            || (browser.scheme() == "http"
                && matches!(
                    browser.host_str(),
                    Some("localhost" | "127.0.0.1" | "[::1]")
                )))
    {
        return Err(invalid());
    }
    if !valid_device_key(&v.device_key) {
        return Err(invalid());
    }
    if p.is_some_and(|p| s.limited(format!("link-request-user:{}", p.user.id), 5)) {
        return Err(busy());
    }
    let mut m = s.link_requests.lock().unwrap();
    sweep_requests(&mut m);
    if let Some(p) = p {
        for r in m.values_mut().filter(|r| {
            r.requester_session.as_deref() == Some(&p.session_id) && !r.link.state.ended()
        }) {
            r.link.end(LinkState::Denied, now());
            r.link.wrapped_keys = None;
            r.confirmation = None;
        }
    }
    // Separate bounded pool, including tombstones, cannot starve V1.
    if m.len() >= MAX_LINKS {
        m.retain(|_, r| !r.link.state.ended());
    }
    if m.len() >= MAX_LINKS
        || (p.is_none()
            && m.values()
                .filter(|r| r.requester_session.is_none() && !r.link.state.ended())
                .count()
                >= 200)
    {
        return Err(busy());
    }
    let (mut id, mut secret) = ([0u8; 16], [0u8; 32]);
    rand::rngs::OsRng.fill_bytes(&mut id);
    rand::rngs::OsRng.fill_bytes(&mut secret);
    let id = hex::encode(id);
    let expires_at = now() + LIFETIME_MS;
    m.insert(
        id.clone(),
        Request {
            link: Link {
                user_id: p.map(|p| p.user.id.clone()).unwrap_or_default(),
                session_id: String::new(),
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
            device_name: name,
            browser_origin: v.browser_origin,
            device_hash: crate::hash(&v.device_key),
            requester_session: p.map(|p| p.session_id.clone()),
            username: None,
            confirmation: None,
        },
    );
    Ok(Json(
        json!({"link_id":id,"secret":crate::identity::b64u(&secret),"expires_at":expires_at}),
    ))
}
async fn start_request(State(s): State<AppState>, Json(v): Json<Start>) -> ApiResult<Value> {
    create(&s, v, None)
}
async fn unlock(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Json(v): Json<Start>,
) -> ApiResult<Value> {
    create(&s, v, Some(&p))
}
#[derive(Deserialize)]
struct Proof {
    link_id: String,
    secret: String,
    device_key: String,
    confirmation: Option<Value>,
}
fn requester<'a>(
    m: &'a mut HashMap<String, Request>,
    v: &Proof,
    p: Option<&Principal>,
) -> Result<&'a mut Request, ApiError> {
    let secret = b64_exact(&v.secret, 32).ok_or_else(invalid)?;
    if !valid_id(&v.link_id) || !valid_device_key(&v.device_key) {
        return Err(invalid());
    }
    sweep_requests(m);
    let digest: [u8; 32] = Sha256::digest(&secret).into();
    let r = m.get_mut(&v.link_id);
    let stored = r.as_ref().map(|r| r.link.secret_hash).unwrap_or(DUMMY);
    let ok = ct_eq(&digest, &stored);
    let r = r.ok_or_else(missing)?;
    if !ok {
        r.link.wrong_secrets += 1;
        if r.link.wrong_secrets >= 3 {
            r.link.burn("wrong_secret", &v.link_id);
            r.confirmation = None;
        }
        return Err(missing());
    }
    if !ct_eq(
        r.device_hash.as_bytes(),
        crate::hash(&v.device_key).as_bytes(),
    ) || r.requester_session.as_deref() != p.map(|p| p.session_id.as_str())
        || p.is_some_and(|p| p.user.id != r.link.user_id)
    {
        return Err(missing());
    }
    Ok(r)
}
fn status_value(r: &Request) -> Value {
    json!({"state":r.link.state.name(),"expires_at":r.link.expires_at,"burn_reason":r.link.burn_reason,"username":r.username,"user_id":if r.link.user_id.is_empty() {None} else {Some(&r.link.user_id)},"claim":r.link.claim.as_ref().map(|c|json!({"device_name":c.device_name,"ephemeral_pub":c.ephemeral_pub,"claim_tag":c.claim_tag}))})
}
async fn request_status(State(s): State<AppState>, Json(v): Json<Proof>) -> ApiResult<Value> {
    enabled(&s)?;
    let mut m = s.link_requests.lock().unwrap();
    Ok(Json(status_value(requester(&mut m, &v, None)?)))
}
async fn unlock_status(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
    Json(v): Json<Proof>,
) -> ApiResult<Value> {
    enabled(&s)?;
    if id != v.link_id {
        return Err(missing());
    }
    let mut m = s.link_requests.lock().unwrap();
    Ok(Json(status_value(requester(&mut m, &v, Some(&p))?)))
}
fn cancel(s: &AppState, v: Proof, p: Option<&Principal>) -> ApiResult<Value> {
    enabled(s)?;
    let mut m = s.link_requests.lock().unwrap();
    let r = requester(&mut m, &v, p)?;
    if !r.link.state.ended() {
        r.link.end(LinkState::Denied, now());
        r.link.wrapped_keys = None;
        r.confirmation = None;
    }
    Ok(Json(json!({"state":r.link.state.name()})))
}
async fn cancel_request(State(s): State<AppState>, Json(v): Json<Proof>) -> ApiResult<Value> {
    cancel(&s, v, None)
}
async fn cancel_unlock(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
    Json(v): Json<Proof>,
) -> ApiResult<Value> {
    if id != v.link_id {
        return Err(missing());
    }
    cancel(&s, v, Some(&p))
}
#[derive(Deserialize)]
struct PhoneClaim {
    secret: String,
    ephemeral_pub: String,
    claim_tag: String,
}
async fn claim_request(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
    Json(v): Json<PhoneClaim>,
) -> ApiResult<Value> {
    enabled(&s)?;
    let secret = b64_exact(&v.secret, 32).ok_or_else(invalid)?;
    let ephemeral = b64_exact(&v.ephemeral_pub, 32).ok_or_else(invalid)?;
    b64_exact(&v.claim_tag, 16).ok_or_else(invalid)?;
    if !valid_id(&id) || ephemeral.iter().all(|b| *b == 0) {
        return Err(invalid());
    }
    // Read session name first; no locks are held across awaits or in reverse order.
    let name: String = s.db.lock().unwrap().query_row(
        "SELECT device_name FROM sessions WHERE id=?",
        [&p.session_id],
        |r| r.get(0),
    )?;
    let mut m = s.link_requests.lock().unwrap();
    sweep_requests(&mut m);
    let digest: [u8; 32] = Sha256::digest(secret).into();
    let entry = m.get_mut(&id);
    let stored = entry.as_ref().map(|r| r.link.secret_hash).unwrap_or(DUMMY);
    let matches = ct_eq(&digest, &stored);
    let r = entry.ok_or_else(missing)?;
    if !matches {
        r.link.wrong_secrets += 1;
        if r.link.wrong_secrets >= 3 {
            r.link.burn("wrong_secret", &id);
            r.confirmation = None;
        }
        return Err(missing());
    }
    if r.requester_session.is_some() && r.link.user_id != p.user.id {
        return Err(missing());
    }
    if r.link.state == LinkState::Expired {
        return Err(expired());
    }
    if r.link.state != LinkState::Started {
        if !r.link.state.ended() {
            r.link.burn("double_claim", &id);
            r.confirmation = None;
        }
        return Err(used());
    }
    r.link.user_id = p.user.id.clone();
    r.link.session_id = p.session_id;
    r.username = Some(p.user.username.clone());
    r.link.claim = Some(Claim {
        device_name: name,
        device_hash: String::new(),
        ephemeral_pub: v.ephemeral_pub,
        claim_tag: v.claim_tag,
        claimed_at: now(),
    });
    r.link.state = LinkState::Claimed;
    Ok(Json(
        json!({"kind":if r.requester_session.is_some(){"unlock"}else{"sign-in"},"device_name":r.device_name,"browser_origin":r.browser_origin,"username":p.user.username,"user_id":p.user.id,"expires_at":r.link.expires_at}),
    ))
}
fn approver<'a>(
    m: &'a mut HashMap<String, Request>,
    id: &str,
    p: &Principal,
) -> Result<&'a mut Request, ApiError> {
    sweep_requests(m);
    let r = m.get_mut(id).ok_or_else(missing)?;
    if r.link.session_id != p.session_id || r.link.user_id != p.user.id {
        return Err(missing());
    }
    Ok(r)
}
#[derive(Deserialize)]
struct Approval {
    confirmation: String,
    wrapped_keys: Option<String>,
}
async fn approve_request(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
    Json(v): Json<Approval>,
) -> ApiResult<Value> {
    enabled(&s)?;
    if v.confirmation.len() != 2 || !v.confirmation.bytes().all(|c| c.is_ascii_digit()) {
        return Err(invalid());
    }
    if let Some(w) = &v.wrapped_keys {
        match crate::identity::unb64u(w) {
            Some(b) if (79..=65536).contains(&b.len()) && b[0] == 1 => {}
            _ => return Err(invalid()),
        }
    }
    let mut m = s.link_requests.lock().unwrap();
    let r = approver(&mut m, &id, &p)?;
    if r.link.state != LinkState::Claimed {
        return Err(conflict("link is not waiting for approval"));
    }
    if r.requester_session.is_some() && v.wrapped_keys.is_none() {
        return Err(invalid());
    }
    r.confirmation = Some(v.confirmation);
    r.link.wrapped_keys = v.wrapped_keys;
    r.link.approved_at = now();
    r.link.state = LinkState::Approved;
    Ok(Json(json!({"state":"approved"})))
}
async fn deny_request(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Value> {
    enabled(&s)?;
    let mut m = s.link_requests.lock().unwrap();
    let r = approver(&mut m, &id, &p)?;
    if !r.link.state.ended() {
        r.link.end(LinkState::Denied, now());
        r.link.wrapped_keys = None;
        r.confirmation = None;
    }
    Ok(Json(json!({"state":r.link.state.name()})))
}
fn collect(s: &AppState, v: Proof, p: Option<&Principal>) -> ApiResult<Value> {
    enabled(s)?;
    let mut m = s.link_requests.lock().unwrap();
    let r = requester(&mut m, &v, p)?;
    if r.link.state == LinkState::Expired {
        return Err(expired());
    }
    if r.link.state != LinkState::Approved {
        return Err(conflict("link is not approved"));
    }
    // One submission only after explicit approval. Even a malformed or missing number burns it.
    let expected = r.confirmation.take().ok_or_else(used)?;
    if !ct_eq(
        expected.as_bytes(),
        v.confirmation
            .as_ref()
            .and_then(Value::as_str)
            .unwrap_or("")
            .as_bytes(),
    ) {
        r.link.burn("number_mismatch", &v.link_id);
        return Err(used());
    }
    let wrapped = r.link.wrapped_keys.take();
    r.link.burn("used", &v.link_id);
    let db = s.db.lock().unwrap();
    // Revoking the approving session also invalidates an uncollected approval.
    let alive: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND s.user_id=? AND s.expires_at>? AND u.disabled=0)",
        rusqlite::params![r.link.session_id, r.link.user_id, now()],
        |row| row.get(0),
    )?;
    if !alive {
        return Err(missing());
    }
    if let Some(requester_session) = &r.requester_session {
        let alive: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM sessions WHERE id=? AND user_id=? AND expires_at>?)",
            rusqlite::params![requester_session, r.link.user_id, now()],
            |row| row.get(0),
        )?;
        if !alive {
            return Err(missing());
        }
    }
    if p.is_some() {
        return Ok(Json(
            json!({"wrapped_keys":wrapped,"user_id":r.link.user_id}),
        ));
    }
    let user: User = db
        .query_row(
            "SELECT id,username,is_owner FROM users WHERE id=? AND disabled=0",
            [&r.link.user_id],
            |r| {
                Ok(User {
                    id: r.get(0)?,
                    username: r.get(1)?,
                    is_owner: r.get(2)?,
                })
            },
        )
        .optional()?
        .ok_or_else(missing)?;
    let mut out =
        crate::session_with(&db, user, &r.device_name, "qr", Some(r.device_hash.clone()))?;
    out.as_object_mut().unwrap().remove("session_id");
    out["wrapped_keys"] = json!(wrapped);
    Ok(Json(out))
}
async fn collect_signin(State(s): State<AppState>, Json(v): Json<Proof>) -> ApiResult<Value> {
    collect(&s, v, None)
}
async fn collect_unlock(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
    Json(v): Json<Proof>,
) -> ApiResult<Value> {
    if id != v.link_id {
        return Err(missing());
    }
    collect(&s, v, Some(&p))
}

async fn phone_status(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Value> {
    enabled(&s)?;
    let mut m = s.link_requests.lock().unwrap();
    let r = approver(&mut m, &id, &p)?;
    Ok(Json(
        json!({"state":r.link.state.name(),"burn_reason":r.link.burn_reason}),
    ))
}

#[doc(hidden)]
pub fn age_for_test(s: &AppState, id: &str, ms: i64) {
    if let Some(r) = s.link_requests.lock().unwrap().get_mut(id) {
        r.link.expires_at -= ms;
        r.link.approved_at -= ms;
    }
}
