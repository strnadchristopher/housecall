use tauri::{
    plugin::{mobile::PluginInvokeError, Builder, PluginHandle, TauriPlugin},
    Manager, Runtime, State,
};

pub struct Push<R: Runtime>(PluginHandle<R>);

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("native-push")
        .setup(|app, api| {
            app.manage(Push(api.register_android_plugin(
                "com.mapleavenuelabs.housecall",
                "NativePushPlugin",
            )?));
            Ok(())
        })
        .build()
}

// App commands are available only to the local webview; no remote IPC capability is granted.
#[tauri::command]
pub async fn native_push(
    state: State<'_, Push<tauri::Wry>>, 
    action: String,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    if !matches!(action.as_str(), "enable" | "status" | "reconcile" | "clear") {
        return Err("Unsupported native push operation".into());
    }
    state
        .0
        .run_mobile_plugin_async(&action, payload)
        .await
        .map_err(|error| {
            let message = match error {
                PluginInvokeError::InvokeRejected(response) => match response.message.as_deref() {
                    Some("Notification permission was not granted") =>
                        "Allow notifications in Android settings, then try again",
                    Some("Push configuration is unavailable or invalid") =>
                        "Background notifications are unavailable in this app build or server configuration",
                    Some("Unable to clear native push state") =>
                        "Background notification cleanup failed; try again before switching accounts",
                    Some("Push request expired") =>
                        "This notification request expired; try enabling notifications again",
                    Some("Unable to enable background push") =>
                        "Could not enable background notifications; check your connection and try again",
                    Some("Unable to read native push status") =>
                        "Could not read background notification settings; try again",
                    _ => "Native push operation failed",
                },
                _ => "Native push operation failed",
            };
            message.into()
        })
}
