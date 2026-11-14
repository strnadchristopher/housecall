//! Private server namespaces and owner-managed roles; role mentions never widen channel access.
use crate::{
    bad, emit, forbidden, missing, owner, secret, ApiError, ApiResult, AppState, Principal,
};
use axum::{
    extract::{Path, State},
    routing::{delete, get, post},
    Extension, Json, Router,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
pub fn init(db: &Connection) -> rusqlite::Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS servers(id TEXT PRIMARY KEY,name TEXT NOT NULL,general_channel_id TEXT NOT NULL); INSERT OR IGNORE INTO servers(id,name,general_channel_id) VALUES('home','Housecall','general'); CREATE TABLE IF NOT EXISTS server_members(server_id TEXT NOT NULL REFERENCES servers(id),user_id TEXT NOT NULL REFERENCES users(id),PRIMARY KEY(server_id,user_id)); CREATE TABLE IF NOT EXISTS roles(id TEXT PRIMARY KEY,server_id TEXT NOT NULL REFERENCES servers(id),name TEXT NOT NULL); CREATE TABLE IF NOT EXISTS role_members(role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id),PRIMARY KEY(role_id,user_id)); CREATE TABLE IF NOT EXISTS message_roles(message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,PRIMARY KEY(message_id,role_id));")?;
    db.execute_batch("CREATE TABLE IF NOT EXISTS user_keys(user_id TEXT NOT NULL REFERENCES users(id),key_rev INTEGER NOT NULL,agree_pub BLOB NOT NULL,sign_pub BLOB NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(user_id,key_rev)); CREATE TABLE IF NOT EXISTS sealed_uploads(upload_id TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS key_exposures(user_id TEXT NOT NULL REFERENCES users(id),kind TEXT NOT NULL,session_id TEXT,device_name TEXT,created_at INTEGER NOT NULL);")?;
    for (table, column, definition) in [
        ("channels", "server_id", "TEXT REFERENCES servers(id)"),
        ("invites", "server_id", "TEXT NOT NULL DEFAULT 'home'"),
        ("invites", "email", "TEXT NOT NULL DEFAULT ''"),
        ("invites", "max_uses", "INTEGER DEFAULT 1"),
        ("invites", "uses", "INTEGER NOT NULL DEFAULT 0"),
        ("users", "disabled", "INTEGER NOT NULL DEFAULT 0"),
        ("users", "display_name", "TEXT"),
        ("users", "bio", "TEXT"),
        ("users", "avatar", "BLOB"),
        ("users", "avatar_type", "TEXT"),
        ("users", "avatar_rev", "INTEGER NOT NULL DEFAULT 0"),
        ("servers", "icon", "BLOB"),
        ("servers", "icon_type", "TEXT"),
        ("servers", "icon_rev", "INTEGER NOT NULL DEFAULT 0"),
        ("users", "agree_pub", "BLOB"),
        ("users", "sign_pub", "BLOB"),
        ("users", "key_rev", "INTEGER NOT NULL DEFAULT 0"),
        ("users", "key_backup", "BLOB"),
        ("messages", "enc", "INTEGER NOT NULL DEFAULT 0"),
        ("messages", "envelope", "TEXT"),
        ("sessions", "added_via", "TEXT"),
    ] {
        let mut q = db.prepare(&format!("PRAGMA table_info({table})"))?;
        let columns = q
            .query_map([], |r| r.get::<_, String>(1))?
            .collect::<Result<Vec<_>, _>>()?;
        if !columns.iter().any(|c| c == column) {
            db.execute(
                &format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"),
                [],
            )?;
        }
    }
    db.execute(
        "UPDATE invites SET uses=1 WHERE used_at IS NOT NULL AND uses=0",
        [],
    )?;
    db.execute(
        "UPDATE channels SET server_id='home' WHERE kind='channel' AND server_id IS NULL",
        [],
    )?;
    db.execute("INSERT OR IGNORE INTO server_members SELECT 'home',user_id FROM members WHERE channel_id='general'",[])?;
    let ids = db
        .prepare("SELECT id FROM servers")?
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    for id in ids {
        ensure_lounge(db, &id)?;
    }
    Ok(())
}
/// Every server has at least one voice channel. A server without one gets `Lounge`, with the
/// people who are in the server's general channel. Safe to call any number of times.
pub fn ensure_lounge(db: &Connection, sid: &str) -> rusqlite::Result<()> {
    let has_voice: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM channels WHERE server_id=? AND kind='voice')",
        [sid],
        |r| r.get(0),
    )?;
    if has_voice {
        return Ok(());
    }
    let id = secret();
    db.execute(
        "INSERT INTO channels(id,name,kind,server_id) VALUES(?,'Lounge','voice',?)",
        params![id, sid],
    )?;
    db.execute(
        "INSERT OR IGNORE INTO members SELECT ?1,m.user_id FROM members m JOIN servers s ON s.general_channel_id=m.channel_id WHERE s.id=?2",
        params![id, sid],
    )?;
    Ok(())
}
pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/servers", get(list).post(create))
        .route("/servers/{id}/members", get(members).post(add_member))
        .route("/servers/{id}/roles", get(roles).post(create_role))
        .route("/roles/{id}/members", post(assign))
        .route("/roles/{id}/members/{user}", delete(unassign))
        .route("/roles/{id}", delete(remove_role))
}
pub fn member(db: &Connection, uid: &str, sid: &str) -> Result<(), ApiError> {
    if db
        .query_row(
            "SELECT 1 FROM server_members WHERE server_id=? AND user_id=?",
            params![sid, uid],
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
pub fn exists(db: &Connection, sid: &str) -> Result<(), ApiError> {
    db.query_row("SELECT 1 FROM servers WHERE id=?", [sid], |_| Ok(()))
        .optional()?
        .ok_or_else(missing)
}
pub fn join(db: &Connection, uid: &str, sid: &str) -> Result<(), ApiError> {
    let general: String = db
        .query_row(
            "SELECT general_channel_id FROM servers WHERE id=?",
            [sid],
            |r| r.get(0),
        )
        .optional()?
        .ok_or_else(missing)?;
    db.execute(
        "INSERT OR IGNORE INTO server_members VALUES(?,?)",
        params![sid, uid],
    )?;
    db.execute(
        "INSERT OR IGNORE INTO members VALUES(?,?)",
        params![general, uid],
    )?;
    // Voice channels are server-wide: everyone in the server is in every voice channel.
    db.execute(
        "INSERT OR IGNORE INTO members SELECT id,?1 FROM channels WHERE server_id=?2 AND kind='voice'",
        params![uid, sid],
    )?;
    emit(
        db,
        &general,
        "member.joined",
        json!({"user_id":uid,"server_id":sid}),
    )?;
    Ok(())
}
async fn list(State(s): State<AppState>, Extension(p): Extension<Principal>) -> ApiResult<Value> {
    let db = s.db.lock().unwrap();
    let mut q=db.prepare("SELECT s.id,s.name,s.general_channel_id,s.icon_rev FROM servers s JOIN server_members m ON m.server_id=s.id WHERE m.user_id=? ORDER BY s.name")?;
    let rows=q.query_map([p.user.id],|r|Ok(json!({"id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"general_channel_id":r.get::<_,String>(2)?,"icon_rev":r.get::<_,i64>(3)?})))?.collect::<Result<Vec<_>,_>>()?;
    Ok(Json(json!({"servers":rows})))
}
#[derive(Deserialize)]
struct Name {
    name: String,
}
fn valid_name(name: &str) -> Result<(), ApiError> {
    if name.trim().is_empty() || name.len() > 80 || name.chars().any(char::is_control) {
        Err(bad("invalid name"))
    } else {
        Ok(())
    }
}
async fn create(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Json(v): Json<Name>,
) -> ApiResult<Value> {
    owner(&p)?;
    valid_name(&v.name)?;
    let (id, general) = (secret(), secret());
    let mut db = s.db.lock().unwrap();
    let tx = db.transaction()?;
    tx.execute(
        "INSERT INTO servers(id,name,general_channel_id) VALUES(?,?,?)",
        params![id, v.name, general],
    )?;
    tx.execute(
        "INSERT INTO channels(id,name,kind,server_id) VALUES(?,'general','channel',?)",
        params![general, id],
    )?;
    ensure_lounge(&tx, &id)?;
    join(&tx, &p.user.id, &id)?;
    tx.commit()?;
    Ok(Json(
        json!({"id":id,"name":v.name,"general_channel_id":general}),
    ))
}
#[derive(Deserialize)]
struct Member {
    user_id: String,
}
async fn add_member(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(sid): Path<String>,
    Json(v): Json<Member>,
) -> ApiResult<Value> {
    owner(&p)?;
    let mut db = s.db.lock().unwrap();
    let tx = db.transaction()?;
    exists(&tx, &sid)?;
    if tx
        .query_row("SELECT 1 FROM users WHERE id=?", [&v.user_id], |_| Ok(()))
        .optional()?
        .is_none()
    {
        return Err(bad("unknown user"));
    }
    join(&tx, &v.user_id, &sid)?;
    tx.commit()?;
    Ok(Json(json!({"ok":true})))
}
async fn members(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(sid): Path<String>,
) -> ApiResult<Value> {
    let db = s.db.lock().unwrap();
    member(&db, &p.user.id, &sid)?;
    let mut q=db.prepare("SELECT u.id,u.username,u.is_owner,u.display_name,u.avatar_rev,u.bio FROM users u JOIN server_members m ON m.user_id=u.id WHERE m.server_id=? ORDER BY u.username")?;
    let rows = q
        .query_map([sid], |r| {
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
async fn roles(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(sid): Path<String>,
) -> ApiResult<Value> {
    let db = s.db.lock().unwrap();
    member(&db, &p.user.id, &sid)?;
    let mut q = db.prepare("SELECT id,name FROM roles WHERE server_id=? ORDER BY name")?;
    let rows = q
        .query_map([sid], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut roles = Vec::new();
    for (id, name) in rows {
        let mut q = db.prepare("SELECT user_id FROM role_members WHERE role_id=?")?;
        let ids = q
            .query_map([&id], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        roles.push(json!({"id":id,"name":name,"member_ids":ids}));
    }
    Ok(Json(json!({"roles":roles})))
}
async fn create_role(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(sid): Path<String>,
    Json(v): Json<Name>,
) -> ApiResult<Value> {
    owner(&p)?;
    valid_name(&v.name)?;
    let db = s.db.lock().unwrap();
    member(&db, &p.user.id, &sid)?;
    let id = secret();
    db.execute("INSERT INTO roles VALUES(?,?,?)", params![id, sid, v.name])?;
    Ok(Json(
        json!({"id":id,"server_id":sid,"name":v.name,"member_ids":[]}),
    ))
}
fn role_server(db: &Connection, id: &str) -> Result<String, ApiError> {
    db.query_row("SELECT server_id FROM roles WHERE id=?", [id], |r| r.get(0))
        .optional()?
        .ok_or_else(missing)
}
async fn assign(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
    Json(v): Json<Member>,
) -> ApiResult<Value> {
    owner(&p)?;
    let db = s.db.lock().unwrap();
    let sid = role_server(&db, &id)?;
    member(&db, &v.user_id, &sid)?;
    db.execute(
        "INSERT OR IGNORE INTO role_members VALUES(?,?)",
        params![id, v.user_id],
    )?;
    Ok(Json(json!({"ok":true})))
}
async fn unassign(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path((id, user)): Path<(String, String)>,
) -> ApiResult<Value> {
    owner(&p)?;
    let db = s.db.lock().unwrap();
    role_server(&db, &id)?;
    db.execute(
        "DELETE FROM role_members WHERE role_id=? AND user_id=?",
        params![id, user],
    )?;
    Ok(Json(json!({"ok":true})))
}
async fn remove_role(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Value> {
    owner(&p)?;
    if s.db
        .lock()
        .unwrap()
        .execute("DELETE FROM roles WHERE id=?", [id])?
        == 0
    {
        return Err(missing());
    }
    Ok(Json(json!({"ok":true})))
}
pub fn resolve_mentions(
    db: &Connection,
    cid: &str,
    ids: &[String],
) -> Result<Vec<String>, ApiError> {
    if ids.len() > 30 {
        return Err(bad("too many role mentions"));
    }
    let server: Option<String> =
        db.query_row("SELECT server_id FROM channels WHERE id=?", [cid], |r| {
            r.get(0)
        })?;
    let mut users = Vec::new();
    for id in ids {
        let sid = role_server(db, id)?;
        if Some(&sid) != server.as_ref() {
            return Err(bad("role must belong to conversation server"));
        }
        let mut q=db.prepare("SELECT r.user_id FROM role_members r JOIN members m ON m.user_id=r.user_id WHERE r.role_id=? AND m.channel_id=?")?;
        users.extend(
            q.query_map(params![id, cid], |r| r.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?,
        );
    }
    Ok(users)
}
