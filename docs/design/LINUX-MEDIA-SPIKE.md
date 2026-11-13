# Linux media spike

## Changed in code

- `client/src-tauri/src/linux_permissions.rs`: the WebKitGTK permission handler now also allows
  `PermissionKind::DisplayCapture`, with the same origin check as microphone and camera
  (`tauri://localhost`, and `http://localhost:1420` in debug builds only). Remote or credentialed
  origins are still denied. The unit test now asserts display capture is allowed for the app origin
  and denied for a remote origin.
- `client/src/transport/voice.ts` `availableVoiceInputs()`: when every device label is blank
  (always the case in WebKitGTK before a grant), it asks once for the microphone, stops the probe
  tracks at once, and lists again so labels appear. A refusal keeps the unlabeled list. Callers
  already re-list on `devicechange` and when the device menu opens, so a grant is picked up.
  Unit tests cover the probe, the release, the refusal, and not asking when labels exist.

## Verified here

- `cargo check` in `client/src-tauri` passes on this host.
- `cargo test` for `client/src-tauri` was killed (exit 137, out of memory while linking) on this
  host, so the updated permission unit test has **not been run**. Run
  `cargo test linux_permissions` on a machine with more memory.
- Client `npm test` and `npm run build` pass.

## Not changed, waiting on Noah's evidence from Archie

- AppImage bundling and `tauri.conf.json` (GStreamer plugins, PipeWire / xdg-desktop-portal
  screencast availability).
- Whether WebKitGTK actually offers a screen picker and delivers frames, and share audio, on
  Archie. Capture: does the share button open a portal dialog, does the viewer get video, device
  labels shown in the menu, and the app's stderr during a share attempt.
