//! Keeps the Housecall session (token, device key, username, expiry) in the operating system's
//! secure storage so a native build can reopen straight into the last chat after the app was
//! force-quit. The web build never reaches this plugin and stays memory-only.
//!
//! - iOS: Keychain generic password (Swift, `ios/`).
//! - Android: AES-GCM with an AndroidKeyStore key (Kotlin `SecureSessionPlugin` in the app project).
//! - Desktop: the `keyring` crate. If no credential store is available, every call fails and the
//!   web code silently stays memory-only.
use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

mod commands;
#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
mod desktop;
pub mod validate;

#[cfg(mobile)]
use tauri::Manager;

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_secure_session);

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("secure-session")
        .invoke_handler(tauri::generate_handler![
            commands::get,
            commands::set,
            commands::remove,
            commands::list,
            commands::identity_get, commands::identity_set, commands::identity_remove,
            commands::pins_get, commands::pins_set, commands::bindings_get, commands::bindings_set, commands::verify_owner, commands::sensitive_surface
        ])
        .setup(|_app, _api| {
            #[cfg(target_os = "ios")]
            _app.manage(commands::Native(
                _api.register_ios_plugin(init_plugin_secure_session)?,
            ));
            #[cfg(target_os = "android")]
            _app.manage(commands::Native(_api.register_android_plugin(
                "com.mapleavenuelabs.housecall",
                "SecureSessionPlugin",
            )?));
            Ok(())
        })
        .build()
}
