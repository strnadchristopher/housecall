//! Display names, avatars, server names and server icons. Presentation only: usernames stay the login identifier.
use crate::{
    bad, emit, image_blob, missing, owner, servers, ApiError, ApiResult, AppState, Principal,
};
use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, Path, State},
    http::{header, HeaderValue},
    response::{IntoResponse, Response},
    routing::{get, patch, put},
    Extension, Json, Router,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/me/avatar",
            put(set_avatar)
                .delete(clear_avatar)
                .layer(DefaultBodyLimit::max(image_blob::MAX_GIF_BYTES + 1)),
        )
        .route("/users/{id}/avatar", get(avatar))
        .route("/servers/{id}", patch(rename_server))
        .route(
            "/servers/{id}/icon",
            put(set_icon)
                .delete(clear_icon)
                .get(icon)
                .layer(DefaultBodyLimit::max(image_blob::MAX_GIF_BYTES + 1)),
        )
}

/// Format characters (Unicode Cf) that render as nothing or reorder text, so a name can't
/// look blank or flip direction next to the real username.
pub(crate) fn invisible(c: char) -> bool {
    matches!(
        c,
        '\u{00AD}'
            | '\u{061C}'
            | '\u{180E}'
            | '\u{200B}'..='\u{200F}'
            | '\u{2028}'..='\u{202E}'
            | '\u{2060}'..='\u{206F}'
            | '\u{FEFF}'
    )
}
fn clean(value: &str, max: usize) -> Result<String, ApiError> {
    let value = value.trim();
    if value.is_empty()
        || value.chars().count() > max
        || value.chars().any(|c| c.is_control() || invisible(c))
    {
        return Err(bad("invalid name"));
    }
    Ok(value.to_owned())
}
fn image_response(bytes: Vec<u8>, kind: String) -> Response {
    let mut response = bytes.into_response();
    let headers = response.headers_mut();
    if let Ok(value) = HeaderValue::from_str(&kind) {
        headers.insert(header::CONTENT_TYPE, value);
    }
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=31536000, immutable"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response
}
fn announce_member(db: &Connection, uid: &str) -> Result<(), ApiError> {
    let (display_name, rev, bio): (Option<String>, i64, Option<String>) = db.query_row(
        "SELECT display_name,avatar_rev,bio FROM users WHERE id=?",
        [uid],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    let channels = db
        .prepare("SELECT channel_id FROM members WHERE user_id=?")?
        .query_map([uid], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    for channel in channels {
        emit(
            db,
            &channel,
            "member.updated",
            json!({"user_id":uid,"display_name":display_name,"avatar_rev":rev,"bio":bio}),
        )?;
    }
    Ok(())
}
fn announce_server(db: &Connection, sid: &str) -> Result<(), ApiError> {
    let (name, rev, general): (String, i64, String) = db.query_row(
        "SELECT name,icon_rev,general_channel_id FROM servers WHERE id=?",
        [sid],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    emit(
        db,
        &general,
        "server.updated",
        json!({"server_id":sid,"name":name,"icon_rev":rev}),
    )
}

/// A bio may span lines, so newlines and tabs are allowed; every other control or invisible
/// character is not. An empty bio clears it.
fn clean_bio(value: &str) -> Result<Option<String>, ApiError> {
    let value = value.trim();
    if value.chars().count() > 190
        || value
            .chars()
            .any(|c| (c.is_control() && !matches!(c, '\n' | '\t')) || invisible(c))
    {
        return Err(bad("invalid bio"));
    }
    Ok((!value.is_empty()).then(|| value.to_owned()))
}
/// Only the fields present in the body change. `display_name: null` still clears the name.
pub async fn rename_me(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Json(v): Json<Value>,
) -> ApiResult<Value> {
    let name = match v.get("display_name") {
        None => None,
        Some(Value::Null) => Some(None),
        Some(Value::String(n)) => Some(Some(clean(n, 32)?)),
        Some(_) => return Err(bad("invalid name")),
    };
    let bio = match v.get("bio") {
        None => None,
        Some(Value::Null) => Some(None),
        Some(Value::String(b)) => Some(clean_bio(b)?),
        Some(_) => return Err(bad("invalid bio")),
    };
    let db = s.db.lock().unwrap();
    if let Some(name) = &name {
        db.execute(
            "UPDATE users SET display_name=? WHERE id=?",
            params![name, p.user.id],
        )?;
    }
    if let Some(bio) = &bio {
        db.execute("UPDATE users SET bio=? WHERE id=?", params![bio, p.user.id])?;
    }
    announce_member(&db, &p.user.id)?;
    let (display_name, bio): (Option<String>, Option<String>) = db.query_row(
        "SELECT display_name,bio FROM users WHERE id=?",
        [&p.user.id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    Ok(Json(json!({"display_name":display_name,"bio":bio})))
}
async fn set_avatar(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    body: Bytes,
) -> ApiResult<Value> {
    let kind = image_blob::validate(&body)?;
    let db = s.db.lock().unwrap();
    db.execute(
        "UPDATE users SET avatar=?,avatar_type=?,avatar_rev=avatar_rev+1 WHERE id=?",
        params![body.to_vec(), kind, p.user.id],
    )?;
    announce_member(&db, &p.user.id)?;
    let rev: i64 = db.query_row(
        "SELECT avatar_rev FROM users WHERE id=?",
        [&p.user.id],
        |r| r.get(0),
    )?;
    Ok(Json(json!({"avatar_rev":rev})))
}
async fn clear_avatar(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
) -> ApiResult<Value> {
    let db = s.db.lock().unwrap();
    db.execute(
        "UPDATE users SET avatar=NULL,avatar_type=NULL,avatar_rev=avatar_rev+1 WHERE id=?",
        [&p.user.id],
    )?;
    announce_member(&db, &p.user.id)?;
    Ok(Json(json!({"ok":true})))
}
async fn avatar(State(s): State<AppState>, Path(id): Path<String>) -> Result<Response, ApiError> {
    let db = s.db.lock().unwrap();
    let row: Option<(Option<Vec<u8>>, Option<String>)> = db
        .query_row(
            "SELECT avatar,avatar_type FROM users WHERE id=?",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    match row {
        Some((Some(bytes), Some(kind))) => Ok(image_response(bytes, kind)),
        _ => Err(missing()),
    }
}

#[derive(Deserialize)]
struct ServerName {
    name: String,
}
async fn rename_server(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(sid): Path<String>,
    Json(v): Json<ServerName>,
) -> ApiResult<Value> {
    owner(&p)?;
    let name = clean(&v.name, 48)?;
    let db = s.db.lock().unwrap();
    servers::exists(&db, &sid)?;
    db.execute("UPDATE servers SET name=? WHERE id=?", params![name, sid])?;
    announce_server(&db, &sid)?;
    Ok(Json(json!({"id":sid,"name":name})))
}
async fn set_icon(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(sid): Path<String>,
    body: Bytes,
) -> ApiResult<Value> {
    owner(&p)?;
    let kind = image_blob::validate(&body)?;
    let db = s.db.lock().unwrap();
    servers::exists(&db, &sid)?;
    db.execute(
        "UPDATE servers SET icon=?,icon_type=?,icon_rev=icon_rev+1 WHERE id=?",
        params![body.to_vec(), kind, sid],
    )?;
    announce_server(&db, &sid)?;
    let rev: i64 = db.query_row("SELECT icon_rev FROM servers WHERE id=?", [&sid], |r| {
        r.get(0)
    })?;
    Ok(Json(json!({"icon_rev":rev})))
}
async fn clear_icon(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(sid): Path<String>,
) -> ApiResult<Value> {
    owner(&p)?;
    let db = s.db.lock().unwrap();
    servers::exists(&db, &sid)?;
    db.execute(
        "UPDATE servers SET icon=NULL,icon_type=NULL,icon_rev=icon_rev+1 WHERE id=?",
        [&sid],
    )?;
    announce_server(&db, &sid)?;
    Ok(Json(json!({"ok":true})))
}
async fn icon(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(sid): Path<String>,
) -> Result<Response, ApiError> {
    let db = s.db.lock().unwrap();
    servers::member(&db, &p.user.id, &sid)?;
    let row: Option<(Option<Vec<u8>>, Option<String>)> = db
        .query_row(
            "SELECT icon,icon_type FROM servers WHERE id=?",
            [sid],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    match row {
        Some((Some(bytes), Some(kind))) => Ok(image_response(bytes, kind)),
        _ => Err(missing()),
    }
}
