const COMMANDS: &[&str] = &["get", "set", "remove", "list", "identity_get", "identity_set", "identity_remove", "pins_get", "pins_set", "bindings_get", "bindings_set", "verify_owner", "sensitive_surface"];

fn main() {
    // The Android class lives in the app project (gen/android), like NativeAuthPlugin, so only iOS has a plugin package here.
    tauri_plugin::Builder::new(COMMANDS).ios_path("ios").build();
}
