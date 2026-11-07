# SFU transport verification (2026-11-07)

- `cargo test --manifest-path crates/sfu/Cargo.toml -j 1 -- --nocapture`: PASS (2 tests), 1.82 seconds test time after compilation. See activities-sfu-tests.log.
- Real localhost UDP ICE/DTLS/SRTP with three authenticated synthetic Opus publishers. Per-peer received encoded frames: 28 each; forwarded: 52, 50, 50; forwarded payload bytes: 4160, 4000, 4000. All three test receivers received at least 50 frames from other peers, never their own payload.
- Fourth peer in a different room received zero media. Revoked Alice disappeared after the one-second authorization sweep; Bob could not remove Cara's transport.
- SDP JSON parser property test passed. Initial compile errors (Option API and borrow scope) were fixed; first attempt preserved in activities-sfu-build-attempt1.log.
- This proves encrypted media transport and room/session isolation with synthetic encoded payloads. It does not prove browser decoding, Opus 510 kbps achieved bitrate, 30-camera load, screen-share UX or physical glass-to-glass latency. Root/client browser testing is separate.
- server/src/voice.rs integration and configured-voice activity gating are implemented. Root/server owns integrated compile/test evidence.
- Upstream str0m reference commit: 8e0067cca6a45ae4ea0532148d08a3d803d29841; source inspected read-only. Adaptation attribution and MIT license included under crates/sfu.
