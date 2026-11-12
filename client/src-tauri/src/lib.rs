#[cfg(target_os = "linux")]
mod linux_permissions;
#[cfg(target_os = "android")]
mod native_auth;
#[cfg(target_os = "android")]
mod native_push;
#[cfg(not(target_os = "android"))]
mod scheme_invite;

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
            tauri_plugin_callkit::commands::callkit_listen,
            scheme_invite::scheme_invite_take
        ]);
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());
    let app = builder
        .build(tauri::generate_context!())
        .expect("Housecall application failed to start");
    app.run(|_app, _event| {
        // iOS (and macOS) hand housecall:// URLs to the running app; the web layer takes them from the inbox.
        #[cfg(any(target_os = "ios", target_os = "macos"))]
        if let tauri::RunEvent::Opened { urls } = &_event {
            scheme_invite::capture(urls.iter().map(|url| url.as_str()));
        }
    });
}
