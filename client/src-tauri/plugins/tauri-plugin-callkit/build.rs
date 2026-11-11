const COMMANDS: &[&str] = &[
    "register",
    "report_incoming",
    "start_outgoing",
    "connected",
    "end",
    "pending",
    "mute",
    "video",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).ios_path("ios").build();
}
