//! The two app commands. They live in a module because a `pub` command in the crate root clashes
//! with the macros `#[tauri::command]` generates.
use serde_json::{json, Value};
use tauri::{ipc::Channel, AppHandle, Runtime};

#[cfg(target_os = "ios")]
use tauri::{plugin::PluginHandle, Manager};

#[cfg(target_os = "ios")]
pub(crate) struct CallKit<R: Runtime>(pub(crate) PluginHandle<R>);

/// Native events the web side may listen for.
const EVENTS: [&str; 6] = ["voipToken", "answer", "end", "mute", "audio", "reset"];
const ACTIONS: [&str; 6] = [
    "register",
    "report_incoming",
    "start_outgoing",
    "connected",
    "end",
    "pending",
];

fn unsupported() -> Value {
    json!({"supported": false})
}

// App command: available only to the local webview; no remote IPC capability is granted.
#[tauri::command]
pub async fn callkit<R: Runtime>(
    app: AppHandle<R>,
    action: String,
    payload: Value,
) -> Result<Value, String> {
    if !ACTIONS.contains(&action.as_str()) {
        return Err("Unsupported CallKit operation".into());
    }
    #[cfg(target_os = "ios")]
    {
        use tauri::plugin::PluginInvokeError;
        let Some(state) = app.try_state::<CallKit<R>>() else {
            return Ok(unsupported());
        };
        state
            .0
            .run_mobile_plugin_async(&action, payload)
            .await
            .map_err(|error| {
                match error {
                    PluginInvokeError::InvokeRejected(_) => {
                        "The system call screen refused the request"
                    }
                    _ => "CallKit operation failed",
                }
                .to_string()
            })
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = (app, payload);
        Ok(unsupported())
    }
}

/// Subscribes `handler` to one native event (`answer`, `end`, `mute`, `voipToken`, ...).
#[tauri::command]
pub async fn callkit_listen<R: Runtime>(
    app: AppHandle<R>,
    event: String,
    handler: Channel<Value>,
) -> Result<Value, String> {
    if !EVENTS.contains(&event.as_str()) {
        return Err("Unsupported CallKit event".into());
    }
    #[cfg(target_os = "ios")]
    {
        let Some(state) = app.try_state::<CallKit<R>>() else {
            return Ok(unsupported());
        };
        state
            .0
            .run_mobile_plugin_async::<Value>(
                "registerListener",
                json!({"event": event, "handler": handler}),
            )
            .await
            .map_err(|_| "CallKit operation failed".to_string())?;
        Ok(json!({"supported": true}))
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = (app, handler);
        Ok(unsupported())
    }
}
