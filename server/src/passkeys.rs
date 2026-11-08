//! WebAuthn challenges live only in server memory, expire after two minutes and are consumed once.
use crate::{
    bad, conflict, forbidden, now, secret, session, unauthorized, ApiError, ApiResult, AppState,
    Principal, User,
};
use axum::{extract::State, http::StatusCode, routing::post, Extension, Json, Router};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Mutex};
use webauthn_rs::prelude::*;
pub struct Passkeys {
    engine: Webauthn,
    android_origins: Vec<String>,
    registrations: Mutex<HashMap<String, Registration>>,
    authentications: Mutex<HashMap<String, Authentication>>,
}
struct Registration {
    user_id: String,
    session_id: String,
    expires: i64,
    state: PasskeyRegistration,
}
struct Authentication {
    user: User,
    expires: i64,
    state: PasskeyAuthentication,
}
impl Passkeys {
    pub fn new(origin: &str) -> Result<Self, String> {
        Self::with_android_origins(origin, &[])
    }
    /// Only operator-provisioned signing certificate hashes may extend WebAuthn trust.
    /// Request bodies never add origins, and browser RP matching stays exact.
    pub fn with_android_origins(origin: &str, android_origins: &[String]) -> Result<Self, String> {
        let url = Url::parse(origin).map_err(|_| "invalid WebAuthn origin")?;
        let host = url.host_str().ok_or("origin needs hostname")?;
        if !url.username().is_empty()
            || url.password().is_some()
            || url.path() != "/"
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(
                "WebAuthn origin must not contain credentials, path, query or fragment".into(),
            );
        }
        if url.scheme() != "https" && !(url.scheme() == "http" && host == "localhost") {
            return Err("WebAuthn needs HTTPS (localhost HTTP allowed for development)".into());
        }
        if android_origins.len() > 8 || (!android_origins.is_empty() && url.scheme() != "https") {
            return Err(
                "Android passkeys require HTTPS and at most eight provisioned signing origins"
                    .into(),
            );
        }
        let mut builder = WebauthnBuilder::new(host, &url)
            .map_err(|e| e.to_string())?
            .rp_name("Chriscord");
        for origin in android_origins {
            let hash = origin
                .strip_prefix("android:apk-key-hash:")
                .ok_or("Android origin must identify an APK signing certificate")?;
            let decoded = URL_SAFE_NO_PAD
                .decode(hash)
                .map_err(|_| "Invalid Android signing certificate hash")?;
            if decoded.len() != 32 || URL_SAFE_NO_PAD.encode(&decoded) != hash {
                return Err(
                    "Android signing certificate hash must be canonical SHA256 base64url".into(),
                );
            }
            builder = builder
                .append_allowed_origin(&Url::parse(origin).map_err(|_| "Invalid Android origin")?);
        }
        let engine = builder.build().map_err(|e| e.to_string())?;
        Ok(Self {
            engine,
            android_origins: android_origins.to_vec(),
            registrations: Default::default(),
            authentications: Default::default(),
        })
    }
}
pub fn init(db: &Connection) -> rusqlite::Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS passkeys(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),credential TEXT NOT NULL,created_at INTEGER NOT NULL);")
}
pub fn private_routes() -> Router<AppState> {
    Router::new()
        .route("/passkeys/register/start", post(register_start))
        .route("/passkeys/register/finish", post(register_finish))
}
pub fn public_routes() -> Router<AppState> {
    Router::new()
        .route("/passkeys/login/start", post(login_start))
        .route("/passkeys/login/finish", post(login_finish))
}
fn keys(db: &Connection, user: &str) -> Result<Vec<Passkey>, ApiError> {
    let mut q = db.prepare("SELECT credential FROM passkeys WHERE user_id=?")?;
    let result = q
        .query_map([user], |r| r.get::<_, String>(0))?
        .map(|row| {
            let row = row?;
            serde_json::from_str(&row)
                .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "invalid stored passkey"))
        })
        .collect();
    result
}
fn configured(s: &AppState) -> Result<&Passkeys, ApiError> {
    s.passkeys.as_deref().ok_or(ApiError(
        StatusCode::SERVICE_UNAVAILABLE,
        "passkeys require CHRISCORD_ORIGIN",
    ))
}
async fn register_start(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
) -> ApiResult<Value> {
    let passkeys = configured(&s)?;
    let existing = keys(&s.db.lock().unwrap(), &p.user.id)?;
    if existing.len() >= 10 {
        return Err(bad("maximum ten passkeys per account"));
    }
    let exclude = existing.iter().map(|p| p.cred_id().clone()).collect();
    let user_handle =
        Uuid::from_slice(&hex::decode(&p.user.id[..32]).map_err(|_| bad("invalid account"))?)
            .map_err(|_| bad("invalid account"))?;
    let (options, state) = passkeys
        .engine
        .start_passkey_registration(
            user_handle,
            &p.user.username,
            &p.user.username,
            Some(exclude),
        )
        .map_err(|_| bad("registration could not start"))?;
    let challenge_id = secret();
    let mut pending = passkeys.registrations.lock().unwrap();
    pending.retain(|_, v| v.expires > now());
    if pending.len() >= 1000 {
        return Err(ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            "too many pending challenges",
        ));
    }
    pending.insert(
        challenge_id.clone(),
        Registration {
            user_id: p.user.id,
            session_id: p.session_id,
            expires: now() + 120000,
            state,
        },
    );
    Ok(Json(
        json!({"challenge_id":challenge_id,"options":options,"android_origins":passkeys.android_origins}),
    ))
}
#[derive(Deserialize)]
struct RegisterFinish {
    challenge_id: String,
    credential: RegisterPublicKeyCredential,
}
async fn register_finish(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Json(v): Json<RegisterFinish>,
) -> ApiResult<Value> {
    let passkeys = configured(&s)?;
    let pending = passkeys
        .registrations
        .lock()
        .unwrap()
        .remove(&v.challenge_id)
        .ok_or_else(|| bad("expired or consumed challenge"))?;
    if pending.user_id != p.user.id
        || pending.session_id != p.session_id
        || pending.expires <= now()
    {
        return Err(forbidden());
    }
    let key = passkeys
        .engine
        .finish_passkey_registration(&v.credential, &pending.state)
        .map_err(|_| bad("passkey registration rejected"))?;
    let credential_id = hex::encode(key.cred_id().as_ref());
    let encoded = serde_json::to_string(&key).map_err(|_| bad("credential encoding failed"))?;
    let db = s.db.lock().unwrap();
    if db.execute(
        "INSERT OR IGNORE INTO passkeys VALUES(?,?,?,?)",
        params![credential_id, p.user.id, encoded, now()],
    )? != 1
    {
        return Err(conflict("credential already registered"));
    }
    Ok(Json(json!({"ok":true,"credential_id":credential_id})))
}
#[derive(Deserialize)]
struct LoginStart {
    username: String,
}
async fn login_start(State(s): State<AppState>, Json(v): Json<LoginStart>) -> ApiResult<Value> {
    if !crate::valid_username(&v.username) {
        return Err(unauthorized());
    }
    let passkeys = configured(&s)?;
    let (user, existing) = {
        let db = s.db.lock().unwrap();
        let user = db
            .query_row(
                "SELECT id,username,is_owner FROM users WHERE username=?",
                [v.username],
                |r| {
                    Ok(User {
                        id: r.get(0)?,
                        username: r.get(1)?,
                        is_owner: r.get(2)?,
                    })
                },
            )
            .optional()?
            .ok_or_else(unauthorized)?;
        let existing = keys(&db, &user.id)?;
        (user, existing)
    };
    if existing.is_empty() {
        return Err(unauthorized());
    }
    let (options, state) = passkeys
        .engine
        .start_passkey_authentication(&existing)
        .map_err(|_| unauthorized())?;
    let challenge_id = secret();
    let mut pending = passkeys.authentications.lock().unwrap();
    pending.retain(|_, v| v.expires > now());
    if pending.len() >= 1000 {
        return Err(ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            "too many pending challenges",
        ));
    }
    pending.insert(
        challenge_id.clone(),
        Authentication {
            user,
            expires: now() + 120000,
            state,
        },
    );
    Ok(Json(
        json!({"challenge_id":challenge_id,"options":options,"android_origins":passkeys.android_origins}),
    ))
}
#[derive(Deserialize)]
struct LoginFinish {
    challenge_id: String,
    credential: PublicKeyCredential,
    device_name: String,
}
async fn login_finish(State(s): State<AppState>, Json(v): Json<LoginFinish>) -> ApiResult<Value> {
    if v.device_name.is_empty() || v.device_name.len() > 80 {
        return Err(bad("invalid device name"));
    }
    let passkeys = configured(&s)?;
    let pending = passkeys
        .authentications
        .lock()
        .unwrap()
        .remove(&v.challenge_id)
        .ok_or_else(unauthorized)?;
    if pending.expires <= now() {
        return Err(unauthorized());
    }
    let result = passkeys
        .engine
        .finish_passkey_authentication(&v.credential, &pending.state)
        .map_err(|_| unauthorized())?;
    let mut db = s.db.lock().unwrap();
    let tx = db.transaction()?;
    let mut credentials = keys(&tx, &pending.user.id)?;
    for credential in &mut credentials {
        if credential.cred_id() == result.cred_id() {
            credential.update_credential(&result);
            tx.execute(
                "UPDATE passkeys SET credential=? WHERE id=? AND user_id=?",
                params![
                    serde_json::to_string(credential)
                        .map_err(|_| bad("credential encoding failed"))?,
                    hex::encode(credential.cred_id().as_ref()),
                    pending.user.id
                ],
            )?;
        }
    }
    let auth = session(&tx, pending.user, &v.device_name)?;
    tx.commit()?;
    Ok(Json(auth))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;
    use std::sync::Arc;
    use tower::ServiceExt;
    async fn call(
        api: &Router,
        path: &str,
        auth: Option<&Value>,
        body: Value,
    ) -> (StatusCode, Value) {
        let mut req = Request::builder()
            .method("POST")
            .uri(path)
            .header("content-type", "application/json");
        if let Some(a) = auth {
            req = req
                .header(
                    "authorization",
                    format!("Bearer {}", a["token"].as_str().unwrap()),
                )
                .header("x-device-key", a["device_key"].as_str().unwrap());
        }
        let r = api
            .clone()
            .oneshot(req.body(Body::from(body.to_string())).unwrap())
            .await
            .unwrap();
        let status = r.status();
        let bytes = r.into_body().collect().await.unwrap().to_bytes();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }
    fn fake() -> Value {
        json!({"id":"AA","rawId":"AA","type":"public-key","response":{"attestationObject":"AA","clientDataJSON":"AA"}})
    }
    #[tokio::test]
    async fn challenge_expiry_consumption_and_session_binding() {
        let mut s = AppState::new(":memory:", "test-setup").unwrap();
        s.passkeys = Some(Arc::new(Passkeys::new("http://localhost:3000").unwrap()));
        let state = s.clone();
        let api = crate::app(s, None);
        for path in [
            "/api/passkeys/register/start",
            "/api/passkeys/register/finish",
        ] {
            assert_eq!(
                call(&api, path, None, json!({})).await.0,
                StatusCode::UNAUTHORIZED
            )
        }
        let(_,a)=call(&api,"/api/setup",None,json!({"setup_token":"test-setup","username":"owner","password":"long-password-for-test","device_name":"first"})).await;
        let (_, b) = call(
            &api,
            "/api/login",
            None,
            json!({"username":"owner","password":"long-password-for-test","device_name":"second"}),
        )
        .await;
        let (status, challenge) =
            call(&api, "/api/passkeys/register/start", Some(&a), json!({})).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(challenge["options"]["publicKey"]["rp"]["id"], "localhost");
        let finish = json!({"challenge_id":challenge["challenge_id"],"credential":fake()});
        assert_eq!(
            call(
                &api,
                "/api/passkeys/register/finish",
                Some(&b),
                finish.clone()
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            call(&api, "/api/passkeys/register/finish", Some(&a), finish)
                .await
                .0,
            StatusCode::BAD_REQUEST
        );
        let (_, challenge) = call(&api, "/api/passkeys/register/start", Some(&a), json!({})).await;
        state
            .passkeys
            .as_ref()
            .unwrap()
            .registrations
            .lock()
            .unwrap()
            .get_mut(challenge["challenge_id"].as_str().unwrap())
            .unwrap()
            .expires = 0;
        assert_eq!(
            call(
                &api,
                "/api/passkeys/register/finish",
                Some(&a),
                json!({"challenge_id":challenge["challenge_id"],"credential":fake()})
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
        let (_, challenge) = call(&api, "/api/passkeys/register/start", Some(&a), json!({})).await;
        let finish = json!({"challenge_id":challenge["challenge_id"],"credential":fake()});
        assert_eq!(
            call(
                &api,
                "/api/passkeys/register/finish",
                Some(&a),
                finish.clone()
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            call(&api, "/api/passkeys/register/finish", Some(&a), finish)
                .await
                .1["error"],
            "expired or consumed challenge"
        );
        assert_eq!(
            call(
                &api,
                "/api/passkeys/login/start",
                None,
                json!({"username":"owner"})
            )
            .await
            .0,
            StatusCode::UNAUTHORIZED
        );
    }
    #[test]
    fn rp_origin_requires_secure_context() {
        assert!(Passkeys::new("https://chat.example.test").is_ok());
        assert!(Passkeys::new("http://chat.example.test").is_err());
        assert!(Passkeys::new("http://localhost:3000").is_ok());
        assert!(Passkeys::new("file:///tmp/site").is_err());
        for invalid in [
            "https://user@example.test",
            "https://user:pass@example.test",
            "https://example.test/path",
            "https://example.test/?q=x",
            "https://example.test/#fragment",
        ] {
            assert!(Passkeys::new(invalid).is_err(), "{invalid}");
        }
    }
    #[test]
    fn android_origins_require_exact_operator_provisioned_certificate_hashes() {
        let origin = format!("android:apk-key-hash:{}", URL_SAFE_NO_PAD.encode([7; 32]));
        let configured = Passkeys::with_android_origins(
            "https://chat.example.test",
            std::slice::from_ref(&origin),
        )
        .unwrap();
        assert_eq!(configured.android_origins, vec![origin.clone()]);
        assert_eq!(configured.engine.get_allowed_origins().len(), 2);
        assert!(Passkeys::with_android_origins("http://localhost:3000", &[origin]).is_err());
        for invalid in [
            "https://other.example.test",
            "android:apk-key-hash:abc",
            "android:apk-key-hash:*",
            "android:apk-key-hash:AAAA?x=1",
        ] {
            assert!(
                Passkeys::with_android_origins("https://chat.example.test", &[invalid.into()])
                    .is_err()
            );
        }
        assert!(Passkeys::new("https://chat.example.test")
            .unwrap()
            .android_origins
            .is_empty());
    }
}
