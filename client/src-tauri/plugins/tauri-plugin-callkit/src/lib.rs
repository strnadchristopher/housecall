//! iOS CallKit and PushKit for Housecall 1:1 calls.
//!
//! On iOS the Swift plugin in `ios/` owns one system call per Housecall call and listens for
//! VoIP pushes. On every other platform the app commands in [`commands`] answer
//! `{"supported": false}` without error, so the web code can ask without checking the platform.
use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

pub mod commands;

#[cfg(target_os = "ios")]
use tauri::Manager;

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_callkit);

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("callkit")
        .setup(|_app, _api| {
            #[cfg(target_os = "ios")]
            _app.manage(commands::CallKit(
                _api.register_ios_plugin(init_plugin_callkit)?,
            ));
            Ok(())
        })
        .build()
}
