# Activities verification (2026-11-07)

- `cargo test --manifest-path crates/activities/Cargo.toml -j 1`: PASS, 16 tests (10 domain/property, 6 local provider fixtures). Log: activities-tests.log.
- Initial parser security test exposed Serde's unknown-field tolerance on internally tagged unit variants. Changed empty commands to empty struct variants; rerun passed with unknown keys rejected.
- `python3 -m py_compile crates/activities/tools/xtts_cpu.py`: PASS syntax only. No local XTTS dependencies/model/reference installed; no clone inference executed.
- Prior-art read-only clone inspected at 46eadc10b0c02ccaad3db245af55875493ed75d8. No hosted voice calls or live Gimme calls made.
- Every network provider test is a loopback fixture; actual Plex playback, Spotify resolution, live Switchboard and cloned speech remain unverified.
- Server route tests authored in server/src/activities.rs; root/server agent owns execution/evidence.
- Real local placeholder speech now verified: installed espeak-ng, then ran `cargo run --manifest-path crates/activities/Cargo.toml -j 1 --example tts_smoke -- /tmp/chriscord-placeholder-adapter.wav`; PASS. Evidence activities-placeholder-adapter.log and activities-placeholder-smoke.log. No cloned voice/reference used.
- Provider metadata readers cap Content-Length and streamed response bytes at 2 MiB; chunked-overflow fixture passes.
- Configured-SFU activity routes now require a connected voice session and derive members from active peers; disabled-SFU mode remains an explicitly labeled state prototype.
