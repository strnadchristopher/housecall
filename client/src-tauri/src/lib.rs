#[cfg(target_os = "linux")]
mod linux_permissions;
#[cfg(target_os = "android")]
mod native_auth;
#[cfg(target_os = "android")]
mod native_push;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
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
    builder
        .run(tauri::generate_context!())
        .expect("Chriscord application failed to start");
}
