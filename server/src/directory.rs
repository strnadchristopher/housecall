//! Owner-authorized, outbound signed publication to the fixed HouseCall directory.
//! The directory verifies DNS ownership. No community credentials leave this server.
use crate::{bad, missing, now, owner, ApiResult, AppState, Principal};
use axum::{extract::State, routing::get, Extension, Json, Router};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use openssl::{pkey::PKey, sign::Signer};
use rusqlite::{params, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::time::Duration;

pub fn routes() -> Router<AppState> {
    Router::new().route("/directory", get(status).put(publish))
}
fn config() -> Result<String, crate::ApiError> {
    if std::env::var("HOUSECALL_DIRECTORY_ENABLED").as_deref() != Ok("yes") {
        return Err(missing());
    }
    let origin =
        std::env::var("HOUSECALL_PUBLIC_URL").map_err(|_| bad("Public HTTPS address required"))?;
    let u = url::Url::parse(&origin).map_err(|_| bad("Public HTTPS address required"))?;
    if u.scheme() != "https" || u.origin().ascii_serialization() != origin || u.host_str().is_none()
    {
        return Err(bad("Public HTTPS origin required"));
    }
    Ok(origin)
}
fn material(s: &AppState) -> Result<(Vec<u8>, Vec<u8>), crate::ApiError> {
    let db = s.db.lock().unwrap();
    let pem: Option<String> = db
        .query_row(
            "SELECT value FROM instance_settings WHERE key='directory_signing_key'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    let key = if let Some(pem) = pem {
        PKey::private_key_from_pem(pem.as_bytes())
    } else {
        let key = PKey::generate_ed25519().map_err(|_| bad("Directory key unavailable"))?;
        let pem = key
            .private_key_to_pem_pkcs8()
            .map_err(|_| bad("Directory key unavailable"))?;
        db.execute(
            "INSERT INTO instance_settings(key,value) VALUES('directory_signing_key',?)",
            [String::from_utf8(pem).map_err(|_| bad("Directory key unavailable"))?],
        )?;
        Ok(key)
    }
    .map_err(|_| bad("Directory key unavailable"))?;
    Ok((
        key.private_key_to_der()
            .map_err(|_| bad("Directory key unavailable"))?,
        key.public_key_to_der()
            .map_err(|_| bad("Directory key unavailable"))?,
    ))
}
async fn status(State(s): State<AppState>, Extension(p): Extension<Principal>) -> ApiResult<Value> {
    owner(&p)?;
    let origin = config()?;
    let (_, public) = material(&s)?;
    let db = s.db.lock().unwrap();
    let saved: Option<String> = db
        .query_row(
            "SELECT value FROM instance_settings WHERE key='directory_listing'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    let saved = saved
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .unwrap_or(json!({"listed":false,"description":""}));
    Ok(Json(
        json!({"origin":origin,"dnsName":format!("_housecall-directory.{}",url::Url::parse(&origin).unwrap().host_str().unwrap()),"dnsValue":format!("housecall-directory={}",hex::encode(Sha256::digest(&public))),"listed":saved["listed"] == true && saved["issued"].as_i64().is_some_and(|issued| now() - issued < 7 * 86_400_000),"description":saved["description"]}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Publication {
    listed: bool,
    description: String,
}
async fn publish(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Json(v): Json<Publication>,
) -> ApiResult<Value> {
    owner(&p)?;
    let origin = config()?;
    if v.description.chars().count() > 140 || v.description.chars().any(char::is_control) {
        return Err(bad("Invalid description"));
    }
    let name: String =
        s.db.lock()
            .unwrap()
            .query_row("SELECT name FROM servers WHERE id='home'", [], |r| r.get(0))?;
    let (private, public) = material(&s)?;
    let payload = json!({"origin":origin,"name":name,"description":v.description,"listed":v.listed,"issued":now()}).to_string();
    let key = PKey::private_key_from_der(&private).map_err(|_| bad("Directory key unavailable"))?;
    let mut signer =
        Signer::new_without_digest(&key).map_err(|_| bad("Directory key unavailable"))?;
    let signature = signer
        .sign_oneshot_to_vec(payload.as_bytes())
        .map_err(|_| bad("Directory signature unavailable"))?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(12))
        .connect_timeout(Duration::from_secs(3))
        .build()
        .map_err(|_| bad("Directory unavailable"))?;
    // Fixed destination: never accept a URL from the browser or fetch the advertised origin.
    let destination = "https://housecall.chat/api/directory/publish".to_string();
    // Test binaries may use only an explicit loopback fixture; release binaries are fixed.
    #[cfg(debug_assertions)]
    let destination = match std::env::var("HOUSECALL_TEST_DIRECTORY_URL") {
        Ok(value) => {
            let u = url::Url::parse(&value).map_err(|_| bad("Invalid test directory"))?;
            if u.scheme() != "http"
                || u.host_str() != Some("127.0.0.1")
                || u.path() != "/api/directory/publish"
                || u.query().is_some()
                || u.fragment().is_some()
                || !u.username().is_empty()
                || u.password().is_some()
            {
                return Err(bad("Invalid test directory"));
            }
            value
        }
        Err(_) => destination,
    };
    let response = client.post(destination).json(&json!({"payload":payload,"publicKey":URL_SAFE_NO_PAD.encode(public),"signature":URL_SAFE_NO_PAD.encode(signature)})).send().await.map_err(|_| bad("Directory unavailable"))?;
    if !response.status().is_success() {
        return Err(bad("DNS ownership not verified or directory unavailable"));
    }
    s.db.lock().unwrap().execute("INSERT INTO instance_settings(key,value) VALUES('directory_listing',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![json!({"listed":v.listed,"description":v.description,"issued":now()}).to_string()])?;
    Ok(Json(json!({"listed":v.listed})))
}
