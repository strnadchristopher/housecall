//! Request access: a person without an invite asks the owner for an account.
//! The requester gets a disabled user (so the username is reserved and the password is set once);
//! the owner approves (enable + join) or declines (delete the user, keep the audit row).
use crate::{
    bad, conflict, credentials, forbidden, missing, now, owner, password_hash, secret, servers,
    ApiError, ApiResult, AppState, Principal,
};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::{get, post},
    Extension, Json, Router,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};

const OPEN_KEY: &str = "access_requests_open";
const MAX_PENDING: i64 = 50;
const MAX_MESSAGE: usize = 500;

pub fn init(db: &Connection) -> rusqlite::Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS instance_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS access_requests(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),server_id TEXT NOT NULL DEFAULT 'home',message TEXT NOT NULL DEFAULT '',status TEXT NOT NULL,created_at INTEGER NOT NULL,decided_at INTEGER);
         CREATE INDEX IF NOT EXISTS access_requests_status ON access_requests(status,created_at);",
    )
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/access-requests", get(list))
        .route("/access-requests/{id}/approve", post(approve))
        .route("/access-requests/{id}/decline", post(decline))
        .route("/instance", axum::routing::patch(set_instance))
}
pub fn public_routes() -> Router<AppState> {
    Router::new()
        .route("/instance", get(instance))
        .route("/access-requests", post(request))
        .route("/access-requests/{id}/status", get(status))
}

fn requests_open(db: &Connection) -> Result<bool, ApiError> {
    Ok(db
        .query_row(
            "SELECT value FROM instance_settings WHERE key=?",
            [OPEN_KEY],
            |r| r.get::<_, String>(0),
        )
        .optional()?
        .is_none_or(|v| v != "0"))
}

async fn instance(State(s): State<AppState>) -> ApiResult<Value> {
    let db = s.db.lock().unwrap();
    let name: String = db
        .query_row("SELECT name FROM servers WHERE id='home'", [], |r| r.get(0))
        .optional()?
        .unwrap_or_else(|| "Housecall".into());
    Ok(Json(
        json!({"name":name,"requests_open":requests_open(&db)?}),
    ))
}

#[derive(Deserialize)]
struct InstanceSettings {
    requests_open: bool,
}
async fn set_instance(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Json(v): Json<InstanceSettings>,
) -> ApiResult<Value> {
    owner(&p)?;
    s.db.lock().unwrap().execute(
        "INSERT INTO instance_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![OPEN_KEY, if v.requests_open { "1" } else { "0" }],
    )?;
    Ok(Json(json!({"requests_open":v.requests_open})))
}

#[derive(Deserialize)]
struct NewRequest {
    username: String,
    password: String,
    device_name: String,
    #[serde(default)]
    message: Option<String>,
}
async fn request(State(s): State<AppState>, Json(v): Json<NewRequest>) -> ApiResult<Value> {
    credentials(&v.username, &v.password, &v.device_name)?;
    let message = v.message.unwrap_or_default().trim().to_owned();
    if message.chars().count() > MAX_MESSAGE {
        return Err(bad("message too long"));
    }
    {
        let db = s.db.lock().unwrap();
        if !requests_open(&db)? {
            return Err(forbidden());
        }
        let pending: i64 = db.query_row(
            "SELECT COUNT(*) FROM access_requests WHERE status='pending'",
            [],
            |r| r.get(0),
        )?;
        if pending >= MAX_PENDING {
            return Err(ApiError(
                StatusCode::TOO_MANY_REQUESTS,
                "too many pending requests",
            ));
        }
    }
    let pw = password_hash(&s, v.password).await?;
    let mut db = s.db.lock().unwrap();
    let tx = db.transaction()?;
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
    let (user_id, id) = (secret(), secret());
    tx.execute(
        "INSERT INTO users(id,username,password,is_owner,disabled) VALUES(?,?,?,0,1)",
        params![user_id, v.username, pw],
    )?;
    tx.execute(
        "INSERT INTO access_requests(id,user_id,server_id,message,status,created_at) VALUES(?,?,'home',?,'pending',?)",
        params![id, user_id, message, now()],
    )?;
    tx.commit()?;
    Ok(Json(json!({"id":id,"status":"pending"})))
}

async fn status(State(s): State<AppState>, Path(id): Path<String>) -> ApiResult<Value> {
    let status: String =
        s.db.lock()
            .unwrap()
            .query_row("SELECT status FROM access_requests WHERE id=?", [id], |r| {
                r.get(0)
            })
            .optional()?
            .ok_or_else(missing)?;
    Ok(Json(json!({"status":status})))
}

async fn list(State(s): State<AppState>, Extension(p): Extension<Principal>) -> ApiResult<Value> {
    owner(&p)?;
    let db = s.db.lock().unwrap();
    let mut q = db.prepare(
        "SELECT r.id,COALESCE(u.username,''),r.message,r.status,r.created_at,r.decided_at,r.server_id FROM access_requests r LEFT JOIN users u ON u.id=r.user_id ORDER BY (r.status='pending') DESC,r.created_at DESC LIMIT 200",
    )?;
    let rows = q
        .query_map([], |r| {
            Ok(json!({"id":r.get::<_,String>(0)?,"username":r.get::<_,String>(1)?,"message":r.get::<_,String>(2)?,"status":r.get::<_,String>(3)?,"created_at":r.get::<_,i64>(4)?,"decided_at":r.get::<_,Option<i64>>(5)?,"server_id":r.get::<_,String>(6)?}))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Json(json!({"requests":rows})))
}

#[derive(Deserialize, Default)]
struct Approve {
    #[serde(default)]
    server_id: Option<String>,
}
fn pending(db: &Connection, id: &str) -> Result<(Option<String>, String), ApiError> {
    let (user, status, server) = db
        .query_row(
            "SELECT user_id,status,server_id FROM access_requests WHERE id=?",
            [id],
            |r| {
                Ok((
                    r.get::<_, Option<String>>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(missing)?;
    if status != "pending" {
        return Err(conflict("request already decided"));
    }
    Ok((user, server))
}
async fn approve(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
    Json(v): Json<Approve>,
) -> ApiResult<Value> {
    owner(&p)?;
    let mut db = s.db.lock().unwrap();
    let tx = db.transaction()?;
    let (user, requested) = pending(&tx, &id)?;
    let user = user.ok_or_else(missing)?;
    let server_id = v.server_id.unwrap_or(requested);
    servers::exists(&tx, &server_id)?;
    tx.execute("UPDATE users SET disabled=0 WHERE id=?", [&user])?;
    servers::join(&tx, &user, &server_id)?;
    tx.execute(
        "UPDATE access_requests SET status='approved',decided_at=?,server_id=? WHERE id=?",
        params![now(), server_id, id],
    )?;
    tx.commit()?;
    Ok(Json(json!({"status":"approved","server_id":server_id})))
}
async fn decline(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Value> {
    owner(&p)?;
    let mut db = s.db.lock().unwrap();
    let tx = db.transaction()?;
    let (user, _) = pending(&tx, &id)?;
    tx.execute(
        "UPDATE access_requests SET status='declined',decided_at=?,user_id=NULL WHERE id=?",
        params![now(), id],
    )?;
    if let Some(user) = user {
        tx.execute("DELETE FROM sessions WHERE user_id=?", [&user])?;
        tx.execute("DELETE FROM users WHERE id=? AND disabled=1", [&user])?;
    }
    tx.commit()?;
    Ok(Json(json!({"status":"declined"})))
}

/// For `login`: the request state of a disabled user, so the client can say why it is refused.
pub fn login_block(db: &Connection, user_id: &str) -> Result<Option<&'static str>, ApiError> {
    let status: Option<String> = db
        .query_row(
            "SELECT status FROM access_requests WHERE user_id=? ORDER BY created_at DESC LIMIT 1",
            [user_id],
            |r| r.get(0),
        )
        .optional()?;
    Ok(match status.as_deref() {
        Some("pending") => Some("access request pending"),
        Some("declined") => Some("access request declined"),
        _ => None,
    })
}
