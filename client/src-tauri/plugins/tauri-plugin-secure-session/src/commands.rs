//! `get`, `set`, `remove`, `list`. Errors are generic on purpose: they must never carry a secret.
use crate::validate;
use serde_json::{json, Value};
use tauri::{AppHandle, Runtime};

#[cfg(mobile)]
use tauri::{plugin::PluginHandle, Manager};

#[cfg(mobile)]
pub(crate) struct Native<R: Runtime>(pub(crate) PluginHandle<R>);

const UNAVAILABLE: &str = "secure storage unavailable";

#[cfg(mobile)]
async fn native<R: Runtime>(app: &AppHandle<R>, command: &str, payload: Value) -> Result<Value, String> {
    let state = app.try_state::<Native<R>>().ok_or(UNAVAILABLE)?;
    state
        .0
        .run_mobile_plugin_async::<Value>(command, payload)
        .await
        .map_err(|_| UNAVAILABLE.to_string())
}

#[cfg(desktop)]
async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| UNAVAILABLE.to_string())?
}

#[tauri::command]
pub async fn get<R: Runtime>(app: AppHandle<R>, origin: String) -> Result<Value, String> {
    let origin = validate::origin(&origin)?.to_owned();
    #[cfg(mobile)]
    return native(&app, "get", json!({"origin": origin})).await;
    #[cfg(desktop)]
    {
        let _ = app;
        let session = blocking(move || stored(&origin)).await?;
        return Ok(json!({"session": session}));
    }
}

#[tauri::command]
pub async fn set<R: Runtime>(app: AppHandle<R>, origin: String, session: Value) -> Result<Value, String> {
    let origin = validate::origin(&origin)?.to_owned();
    let session = validate::session(&session)?;
    #[cfg(mobile)]
    return native(&app, "set", json!({"origin": origin, "session": session.to_string()})).await;
    #[cfg(desktop)]
    {
        let _ = app;
        blocking(move || store(&origin, &session)).await?;
        return Ok(json!({"ok": true}));
    }
}

#[tauri::command]
pub async fn remove<R: Runtime>(app: AppHandle<R>, origin: String) -> Result<Value, String> {
    let origin = validate::origin(&origin)?.to_owned();
    #[cfg(mobile)]
    return native(&app, "remove", json!({"origin": origin})).await;
    #[cfg(desktop)]
    {
        let _ = app;
        blocking(move || forget(&origin)).await?;
        return Ok(json!({"ok": true}));
    }
}

#[tauri::command]
pub async fn list<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> {
    #[cfg(mobile)]
    return native(&app, "list", json!({})).await;
    #[cfg(desktop)]
    {
        let _ = app;
        let origins = blocking(origins).await?;
        return Ok(json!({"origins": origins}));
    }
}

#[cfg(all(desktop, any(target_os = "linux", target_os = "macos", target_os = "windows")))]
use crate::desktop::{forget, origins, store, stored};

#[cfg(all(desktop, not(any(target_os = "linux", target_os = "macos", target_os = "windows"))))]
mod unsupported {
    use serde_json::Value;
    pub fn stored(_: &str) -> Result<Option<Value>, String> { Err(super::UNAVAILABLE.into()) }
    pub fn store(_: &str, _: &Value) -> Result<(), String> { Err(super::UNAVAILABLE.into()) }
    pub fn forget(_: &str) -> Result<(), String> { Err(super::UNAVAILABLE.into()) }
    pub fn origins() -> Result<Vec<String>, String> { Err(super::UNAVAILABLE.into()) }
}
#[cfg(all(desktop, not(any(target_os = "linux", target_os = "macos", target_os = "windows"))))]
use unsupported::{forget, origins, store, stored};

// Identity and pins use a separate namespace from origin-keyed sessions. No session
// removal command can touch these records. Mobile payload strings stay inside OS storage.
#[cfg(desktop)]
async fn record(app: &AppHandle<impl Runtime>, action: &str, account: String, value: Option<Value>) -> Result<Value, String> {
    let _ = app;
    let action = action.to_owned();
    blocking(move || crate::desktop::record(&action, &account, value)).await
}
#[cfg(mobile)]
async fn record<R: Runtime>(app: &AppHandle<R>, action: &str, account: String, value: Option<Value>) -> Result<Value, String> {
    native(app, action, json!({"account":account,"value":value.map(|v| v.to_string())})).await
}
#[tauri::command]
pub async fn identity_get<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> {
    let result = record(&app, "recordGet", "install-v1".into(), None).await?;
    Ok(json!({"identity":result.get("value")}))
}
#[tauri::command]
pub async fn identity_set<R: Runtime>(app: AppHandle<R>, identity: Value) -> Result<Value, String> {
    let value = validate::identity(&identity)?;
    record(&app, "recordSet", "install-v1".into(), Some(value)).await
}
#[tauri::command]
pub async fn identity_remove<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> {
    record(&app, "recordRemove", "install-v1".into(), None).await
}
fn pin_account(origin: &str, user_id: &str) -> Result<String, String> {
    validate::origin(origin)?;
    if user_id.is_empty() || user_id.len() > 128 || user_id.chars().any(char::is_control) { return Err("invalid pin namespace".into()); }
    Ok(format!("pins-v1:{}:{}:{}", origin.len(), origin, user_id))
}
#[tauri::command]
pub async fn pins_get<R: Runtime>(app: AppHandle<R>, origin: String, user_id: String) -> Result<Value, String> {
    let result = record(&app, "recordGet", pin_account(&origin, &user_id)?, None).await?;
    Ok(json!({"pins":result.get("value")}))
}
#[tauri::command]
pub async fn pins_set<R: Runtime>(app: AppHandle<R>, origin: String, user_id: String, pins: Value) -> Result<Value, String> {
    let account = pin_account(&origin, &user_id)?;
    if !pins.is_array() || pins.to_string().len() > 4_000_000 { return Err("invalid pins".into()); }
    for pin in pins.as_array().unwrap() {
        if pin.get("origin").and_then(Value::as_str) != Some(origin.as_str()) || !pin.get("history").is_some_and(Value::is_array) { return Err("invalid pins".into()); }
    }
    record(&app, "recordSet", account, Some(pins)).await
}

// Same OS record store as pins; session signout/removal never deletes these bindings.
#[tauri::command]
pub async fn bindings_get<R: Runtime>(app: AppHandle<R>, origin: String, user_id: String) -> Result<Value, String> {
    let account = format!("bindings-v1:{}", pin_account(&origin, &user_id)?);
    let result = record(&app, "recordGet", account, None).await?;
    Ok(json!({"bindings":result.get("value")}))
}
#[tauri::command]
pub async fn bindings_set<R: Runtime>(app: AppHandle<R>, origin: String, user_id: String, bindings: Value) -> Result<Value, String> {
    let account = format!("bindings-v1:{}", pin_account(&origin, &user_id)?);
    if !bindings.is_array() || bindings.to_string().len() > 4_000_000 { return Err("invalid bindings".into()); }
    for row in bindings.as_array().unwrap() {
        let id = row.get("id").and_then(Value::as_str).ok_or("invalid bindings")?;
        if id.is_empty() || id.len() > 128 || id.chars().any(char::is_control) { return Err("invalid bindings".into()); }
        let peer = row.get("peer").ok_or("invalid bindings")?;
        if !peer.is_null() && !peer.as_str().is_some_and(|p| !p.is_empty() && p.len() <= 128 && p != user_id && !p.chars().any(char::is_control)) { return Err("invalid bindings".into()); }
    }
    record(&app, "recordSet", account, Some(bindings)).await
}

#[tauri::command]
pub async fn verify_owner<R: Runtime>(app: AppHandle<R>, reason: String) -> Result<Value, String> {
    if reason.is_empty() || reason.len() > 200 || reason.chars().any(char::is_control) { return Err("invalid verification reason".into()); }
    #[cfg(mobile)]
    return native(&app, "verifyOwner", json!({"reason":reason})).await.map_err(|_| "device verification unavailable".to_owned());
    #[cfg(desktop)]
    { let _ = (app, reason); Ok(json!({"supported":false,"verified":false})) }
}

/// Scoped QR protection. The UI tears it down on close. Never accepts secrets.
#[tauri::command]
pub async fn sensitive_surface<R: Runtime>(app: AppHandle<R>, enabled: bool) -> Result<Value, String> {
    #[cfg(mobile)]
    return native(&app, "sensitiveSurface", json!({"enabled": enabled})).await;
    #[cfg(desktop)]
    { let _ = (app, enabled); Ok(json!({"ok":true,"captured":false})) }
}
