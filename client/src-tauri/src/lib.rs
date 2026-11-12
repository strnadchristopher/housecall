#[cfg(target_os = "linux")]
mod linux_permissions;
#[cfg(target_os = "android")]
mod native_auth;
#[cfg(target_os = "android")]
mod native_push;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Native builds keep the session in OS secure storage (Keychain, Keystore, keyring).
    let builder = tauri::Builder::default().plugin(tauri_plugin_secure_session::init());
    #[cfg(target_os = "linux")]
    let builder = builder.on_permission_request(linux_permissions::handle);
    #[cfg(target_os = "android")]
    let builder = builder
        .plugin(native_push::init())
        .plugin(native_auth::init())
        .invoke_handler(tauri::generate_handler![
            native_push::native_push,
            native_auth::native_auth
        ]);
    // iOS rings through CallKit; every other platform answers `supported: false` to the same commands.
    #[cfg(not(target_os = "android"))]
    let builder = builder
        .plugin(tauri_plugin_callkit::init())
        .invoke_handler(tauri::generate_handler![
            tauri_plugin_callkit::commands::callkit,
            tauri_plugin_callkit::commands::callkit_listen
        ]);
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());
    builder
        .run(tauri::generate_context!())
        .expect("Housecall application failed to start");
}
