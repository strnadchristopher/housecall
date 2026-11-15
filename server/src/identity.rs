//! DM-V1 identity keys, the sealed key backup, password re-check and key-exposure bookkeeping.
//! The server stores public keys and one opaque backup blob. It never sees a private key or the
//! recovery words, and it never logs key material.
use crate::{bad, conflict, missing, now, ApiError, ApiResult, AppState, Principal};
use argon2::{
    password_hash::{PasswordHash, PasswordVerifier},
    Argon2,
};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::{get, post, put},
    Extension, Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/me/keys", put(put_keys))
        .route("/users/{id}/keys", get(get_keys))
        .route("/me/key-backup", put(put_backup).get(get_backup))
        .route("/me/password-check", post(password_check))
        .route("/me/key-exposure", post(post_exposure).get(get_exposures))
}

/// Strict base64url without padding: no `+`, `/`, `=`, whitespace or non-canonical tail.
pub fn unb64u(v: &str) -> Option<Vec<u8>> {
    B64.decode(v).ok()
}
pub fn b64u(v: &[u8]) -> String {
    B64.encode(v)
}
fn limit(s: &AppState, what: &str, user: &str, max: u32) -> Result<(), ApiError> {
    if s.limited(format!("{what}:{user}"), max) {
        return Err(ApiError(StatusCode::TOO_MANY_REQUESTS, "try again later"));
    }
    Ok(())
}
/// The checks the server can make on bytes alone (DM-V1 15.4): length, version, a non-zero and
/// canonically encoded agreement key. It has no curve code, so the signing key is not checked.
fn parse_identity_key(v: &str) -> Result<([u8; 32], [u8; 32]), ApiError> {
    let invalid = || bad("invalid identity key");
    let raw = unb64u(v).ok_or_else(invalid)?;
    if raw.len() != 65 || raw[0] != 1 {
        return Err(invalid());
    }
    let agree: [u8; 32] = raw[1..33].try_into().unwrap();
    let sign: [u8; 32] = raw[33..65].try_into().unwrap();
    if agree.iter().all(|b| *b == 0) || agree[31] & 0x80 != 0 {
        return Err(invalid());
    }
    // p = 2^255 - 19, little endian: ed ff ... ff 7f. Compare from the top byte down.
    let mut p = [0xffu8; 32];
    p[0] = 0xed;
    p[31] = 0x7f;
    for i in (0..32).rev() {
        if agree[i] != p[i] {
            if agree[i] > p[i] {
                return Err(invalid());
            }
            break;
        }
        if i == 0 {
            return Err(invalid()); // equal to p
        }
    }
    Ok((agree, sign))
}
fn identity_key(agree: &[u8], sign: &[u8]) -> String {
    let mut k = vec![1u8];
    k.extend_from_slice(agree);
    k.extend_from_slice(sign);
    b64u(&k)
}
/// Argon2 check of the account password, through the same slots as login.
pub async fn verify_password(s: &AppState, user: &str, password: String) -> Result<bool, ApiError> {
    let encoded: String =
        s.db.lock()
            .unwrap()
            .query_row("SELECT password FROM users WHERE id=?", [user], |r| {
                r.get(0)
            })
            .optional()?
            .ok_or_else(missing)?;
    let permit = s.auth_slots.clone().try_acquire_owned().map_err(|_| {
        ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            "credential service busy; retry shortly",
        )
    })?;
    Ok(tokio::task::spawn_blocking(move || {
        let _permit = permit;
        PasswordHash::new(&encoded)
            .map(|h| {
                Argon2::default()
                    .verify_password(password.as_bytes(), &h)
                    .is_ok()
            })
            .unwrap_or(false)
    })
    .await
    .unwrap_or(false))
}
fn password_required() -> ApiError {
    ApiError(StatusCode::FORBIDDEN, "password required")
}

#[derive(Deserialize)]
struct PutKeys {
    identity_key: String,
    #[serde(default)]
    password: Option<String>,
}
type CurrentKeys = (i64, Option<Vec<u8>>, Option<Vec<u8>>);

fn current(db: &Connection, uid: &str) -> Result<CurrentKeys, ApiError> {
    Ok(db.query_row(
        "SELECT key_rev,agree_pub,sign_pub FROM users WHERE id=?",
        [uid],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?)
}
async fn put_keys(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Json(v): Json<PutKeys>,
) -> ApiResult<Value> {
    // Malformed input costs nothing to refuse, so it does not spend the rate limit.
    let (agree, sign) = parse_identity_key(&v.identity_key)?;
    limit(&s, "keys", &p.user.id, 3)?;
    let (rev, cur_agree, cur_sign) = current(&s.db.lock().unwrap(), &p.user.id)?;
    if cur_agree.as_deref() == Some(&agree[..]) && cur_sign.as_deref() == Some(&sign[..]) {
        return Ok(Json(json!({"key_rev":rev})));
    }
    let replacing = rev > 0;
    if replacing {
        let ok = match v.password {
            Some(pw) if !pw.is_empty() && pw.len() <= 256 => {
                verify_password(&s, &p.user.id, pw).await?
            }
            _ => false,
        };
        if !ok {
            return Err(password_required());
        }
    }
    let mut db = s.db.lock().unwrap();
    let tx = db.transaction()?;
    let (rev, cur_agree, cur_sign) = current(&tx, &p.user.id)?;
    if cur_agree.as_deref() == Some(&agree[..]) && cur_sign.as_deref() == Some(&sign[..]) {
        return Ok(Json(json!({"key_rev":rev})));
    }
    if rev > 0 && !replacing {
        return Err(password_required()); // keys appeared while we were checking
    }
    if tx
        .query_row(
            "SELECT 1 FROM user_keys WHERE user_id=? AND agree_pub=? AND sign_pub=?",
            params![p.user.id, &agree[..], &sign[..]],
            |_| Ok(()),
        )
        .optional()?
        .is_some()
    {
        return Err(conflict("this security key was replaced earlier"));
    }
    let next = rev + 1;
    tx.execute(
        "UPDATE users SET agree_pub=?,sign_pub=?,key_rev=?,key_backup=NULL WHERE id=?",
        params![&agree[..], &sign[..], next, p.user.id],
    )?;
    tx.execute(
        "INSERT INTO user_keys(user_id,key_rev,agree_pub,sign_pub,created_at) VALUES(?,?,?,?,?)",
        params![p.user.id, next, &agree[..], &sign[..], now()],
    )?;
    let device: String = tx
        .query_row(
            "SELECT device_name FROM sessions WHERE id=?",
            [&p.session_id],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or_default();
    let payload = json!({"user_id":p.user.id,"key_rev":next,"device_name":device}).to_string();
    tx.execute(
        "INSERT INTO events(user_id,kind,channel_id,payload,created_at) SELECT DISTINCT user_id,'keys.changed',NULL,?1,?2 FROM (SELECT ?3 AS user_id UNION SELECT m2.user_id FROM members m JOIN channels c ON c.id=m.channel_id AND c.kind='dm' JOIN members m2 ON m2.channel_id=c.id WHERE m.user_id=?3)",
        params![payload, now(), p.user.id],
    )?;
    tx.commit()?;
    if replacing {
        tracing::info!(user=%p.user.id, key_rev=next, session=%p.session_id, "keys replaced");
    } else {
        tracing::info!(user=%p.user.id, key_rev=next, "keys published");
    }
    Ok(Json(json!({"key_rev":next})))
}
async fn get_keys(
    State(s): State<AppState>,
    Extension(_p): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Value> {
    let db = s.db.lock().unwrap();
    let (rev, agree, sign) = db
        .query_row(
            "SELECT key_rev,agree_pub,sign_pub FROM users WHERE id=? AND disabled=0",
            [&id],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, Option<Vec<u8>>>(1)?,
                    r.get::<_, Option<Vec<u8>>>(2)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(missing)?;
    let (Some(agree), Some(sign)) = (agree, sign) else {
        return Ok(Json(
            json!({"user_id":id,"identity_key":null,"key_rev":0,"history":[]}),
        ));
    };
    let mut q = db.prepare(
        "SELECT key_rev,agree_pub,sign_pub,created_at FROM user_keys WHERE user_id=? ORDER BY key_rev",
    )?;
    let history = q
        .query_map([&id], |r| {
            Ok(json!({"key_rev":r.get::<_,i64>(0)?,"identity_key":identity_key(&r.get::<_,Vec<u8>>(1)?,&r.get::<_,Vec<u8>>(2)?),"created_at":r.get::<_,i64>(3)?}))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Json(
        json!({"user_id":id,"identity_key":identity_key(&agree,&sign),"key_rev":rev,"history":history}),
    ))
}

#[derive(Deserialize)]
struct PutBackup {
    key_backup: String,
}
async fn put_backup(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Json(v): Json<PutBackup>,
) -> ApiResult<Value> {
    let invalid = || bad("invalid key backup");
    let raw = unb64u(&v.key_backup).ok_or_else(invalid)?;
    if raw.len() != 77 || raw[0] != 1 {
        return Err(invalid());
    }
    let recovery_rev = u32::from_be_bytes(raw[1..5].try_into().unwrap());
    if recovery_rev == 0 {
        return Err(invalid());
    }
    limit(&s, "key-backup", &p.user.id, 6)?;
    let mut db = s.db.lock().unwrap();
    let tx = db.transaction()?;
    let (rev, _, _) = current(&tx, &p.user.id)?;
    if rev == 0 {
        return Err(conflict("publish keys first"));
    }
    let stored: Option<Vec<u8>> = tx.query_row(
        "SELECT key_backup FROM users WHERE id=?",
        [&p.user.id],
        |r| r.get(0),
    )?;
    if let Some(old) = stored.filter(|o| o.len() == 77) {
        if u32::from_be_bytes(old[1..5].try_into().unwrap()) > recovery_rev {
            return Err(conflict("a newer recovery key exists"));
        }
    }
    tx.execute(
        "UPDATE users SET key_backup=? WHERE id=?",
        params![raw, p.user.id],
    )?;
    tx.commit()?;
    tracing::info!(user=%p.user.id, recovery_rev, "key backup stored");
    Ok(Json(json!({"recovery_rev":recovery_rev})))
}
async fn get_backup(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
) -> ApiResult<Value> {
    let stored: Option<Vec<u8>> = s.db.lock().unwrap().query_row(
        "SELECT key_backup FROM users WHERE id=?",
        [&p.user.id],
        |r| r.get(0),
    )?;
    Ok(Json(json!({"key_backup":stored.map(|b|b64u(&b))})))
}

#[derive(Deserialize)]
struct PasswordCheck {
    password: String,
}
async fn password_check(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Json(v): Json<PasswordCheck>,
) -> ApiResult<Value> {
    if v.password.is_empty() || v.password.len() > 256 {
        return Err(password_required());
    }
    limit(&s, "password-check", &p.user.id, 5)?;
    if verify_password(&s, &p.user.id, v.password).await? {
        Ok(Json(json!({"ok":true})))
    } else {
        Err(password_required())
    }
}

#[derive(Deserialize)]
struct Exposure {
    kind: String,
}
async fn post_exposure(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Json(v): Json<Exposure>,
) -> ApiResult<Value> {
    if v.kind != "browser" {
        return Err(bad("invalid kind"));
    }
    limit(&s, "key-exposure", &p.user.id, 6)?;
    let db = s.db.lock().unwrap();
    let device: Option<String> = db
        .query_row(
            "SELECT device_name FROM sessions WHERE id=?",
            [&p.session_id],
            |r| r.get(0),
        )
        .optional()?;
    db.execute(
        "INSERT INTO key_exposures(user_id,kind,session_id,device_name,created_at) VALUES(?,?,?,?,?)",
        params![p.user.id, v.kind, p.session_id, device, now()],
    )?;
    db.execute(
        "DELETE FROM key_exposures WHERE user_id=?1 AND rowid NOT IN (SELECT rowid FROM key_exposures WHERE user_id=?1 ORDER BY created_at DESC,rowid DESC LIMIT 100)",
        [&p.user.id],
    )?;
    Ok(Json(json!({})))
}
async fn get_exposures(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
) -> ApiResult<Value> {
    let db = s.db.lock().unwrap();
    let mut q = db.prepare(
        "SELECT kind,device_name,created_at FROM key_exposures WHERE user_id=? ORDER BY created_at DESC,rowid DESC LIMIT 20",
    )?;
    let rows = q
        .query_map([&p.user.id], |r| {
            Ok(json!({"kind":r.get::<_,String>(0)?,"device_name":r.get::<_,Option<String>>(1)?,"created_at":r.get::<_,i64>(2)?}))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Json(json!({"exposures":rows})))
}

/// Used by message validation: an upload is an encrypted DM when both members have keys.
pub fn is_encrypted_dm(db: &Connection, cid: &str) -> Result<bool, ApiError> {
    Ok(db.query_row(
        "SELECT c.kind='dm' AND COUNT(*)=2 AND MIN(u.key_rev)>0 FROM channels c JOIN members m ON m.channel_id=c.id JOIN users u ON u.id=m.user_id WHERE c.id=? GROUP BY c.id",
        [cid],
        |r| r.get::<_, bool>(0),
    ).optional()?.unwrap_or(false))
}

pub const ENC_PLACEHOLDER: &str = "Encrypted message. Update Housecall to read it.";
const ENVELOPE_MAX_CHARS: usize = 22252;
pub fn invalid_envelope() -> ApiError {
    ApiError(
        StatusCode::UNPROCESSABLE_ENTITY,
        "invalid encrypted message",
    )
}
pub fn not_available() -> ApiError {
    ApiError(
        StatusCode::UNPROCESSABLE_ENTITY,
        "encryption is not available in this conversation",
    )
}
pub fn plaintext_refused() -> ApiError {
    ApiError(
        StatusCode::UNPROCESSABLE_ENTITY,
        "this conversation is end-to-end encrypted; update Housecall to send",
    )
}
pub fn is_sealed(db: &Connection, upload: &uuid::Uuid) -> Result<bool, ApiError> {
    Ok(db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sealed_uploads WHERE upload_id=?)",
        [upload.to_string()],
        |r| r.get(0),
    )?)
}
/// DM-V1 15.2. Header-only envelope checks; the envelope is never parsed further or logged.
#[allow(clippy::too_many_arguments)]
pub fn check_send(
    db: &Connection,
    author: &str,
    cid: &str,
    sealed_dm: bool,
    enc: i64,
    envelope: Option<&str>,
    body: &str,
    view_once: bool,
    roles: &[String],
    mentions: &[String],
) -> Result<(), ApiError> {
    if enc == 0 {
        if sealed_dm {
            tracing::info!(user=%author, channel=%cid, "plaintext refused in encrypted dm");
            return Err(plaintext_refused());
        }
        return Ok(());
    }
    if !sealed_dm {
        tracing::info!(user=%author, channel=%cid, "encrypted message refused outside an encrypted dm");
        return Err(not_available());
    }
    let refuse = || {
        tracing::info!(user=%author, channel=%cid, "invalid encrypted message");
        invalid_envelope()
    };
    let envelope = envelope
        .filter(|e| e.len() <= ENVELOPE_MAX_CHARS)
        .ok_or_else(refuse)?;
    let bytes = unb64u(envelope).ok_or_else(refuse)?;
    let n = bytes
        .len()
        .checked_sub(33 + 16)
        .filter(|r| r % 256 == 0)
        .map(|r| r / 256);
    if !n.is_some_and(|n| (1..=65).contains(&n)) || bytes[0] != 1 {
        return Err(refuse());
    }
    let sender = u32::from_be_bytes(bytes[1..5].try_into().unwrap());
    let recipient = u32::from_be_bytes(bytes[5..9].try_into().unwrap());
    if sender == 0 || recipient == 0 || !body.is_empty() || view_once || !roles.is_empty() {
        return Err(refuse());
    }
    let peer: String = db.query_row(
        "SELECT user_id FROM members WHERE channel_id=? AND user_id<>?",
        params![cid, author],
        |r| r.get(0),
    )?;
    if mentions.iter().any(|m| *m != peer) {
        return Err(refuse());
    }
    let rev = |u: &str| -> Result<i64, ApiError> {
        Ok(db.query_row("SELECT key_rev FROM users WHERE id=?", [u], |r| r.get(0))?)
    };
    if i64::from(sender) != rev(author)? || i64::from(recipient) != rev(&peer)? {
        return Err(conflict("security key changed; reload keys"));
    }
    Ok(())
}
