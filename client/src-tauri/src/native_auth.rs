use tauri::{
    plugin::{mobile::PluginInvokeError, Builder, PluginHandle, TauriPlugin},
    Manager, Runtime, State,
};

pub struct Auth<R: Runtime>(PluginHandle<R>);

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("native-auth")
        .setup(|app, api| {
            app.manage(Auth(api.register_android_plugin(
                "com.mapleavenuelabs.housecall",
                "NativeAuthPlugin",
            )?));
            Ok(())
        })
        .build()
}

#[tauri::command]
pub async fn native_auth<R: Runtime>(
    state: State<'_, Auth<R>>,
    action: String,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    if !matches!(
        action.as_str(),
        "status" | "register" | "authenticate" | "cancel" | "takeInvite" | "acknowledgeInvite"
    ) {
        return Err("Unsupported native authentication operation".into());
    }
    state.0.run_mobile_plugin_async(&action, payload).await.map_err(|error| {
        // Credential-provider errors can contain account/challenge data. Surface
        // only the plugin's explicit safe messages, never raw provider errors.
        let message = match error {
            PluginInvokeError::InvokeRejected(response) => match response.message.as_deref() {
                Some("Passkey request cancelled") => "Passkey request cancelled",
                Some("Passkey request timed out") => "Passkey request timed out; please try again",
                Some("Passkey request already active") => "A passkey request is already active",
                Some("Native passkeys are not configured") => "Native passkeys are not configured for this app build",
                Some("Passkey server or application origin mismatch") => "The server has not authorized passkeys for this app build",
                Some("Credential provider unavailable or request rejected") => "A credential provider is unavailable or rejected the request; check device setup and app association",
                _ => "Native authentication operation failed",
            },
            _ => "Native authentication operation failed",
        };
        message.into()
    })
}
