const COMMANDS: &[&str] = &["get", "set", "remove", "list"];

fn main() {
    // The Android class lives in the app project (gen/android), like NativeAuthPlugin, so only iOS has a plugin package here.
    tauri_plugin::Builder::new(COMMANDS).ios_path("ios").build();
}
