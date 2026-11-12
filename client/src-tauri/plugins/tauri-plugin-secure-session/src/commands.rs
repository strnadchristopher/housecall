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
