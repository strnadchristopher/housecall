# Independent VM/media integration source review

Parent-assigned reviewer `/root/vm_media_review`, gpt-6-astra/xhigh, read-only. Final source review found and corrected stale Unix socket restart, cross-session borrowed voice presence, and numeric peer0 departure cleanup. Reviewer reread fixes and found no further confirmed source/privacy defect in the bounded slice. Private publisher never subscribes user tracks; exact UID/generation/owner-session/lease gates and isolated opt-in mounts/networks reviewed. UI action descriptors use the existing generic renderer; no UI file changes.

Independent checks: `./node_modules/.bin/vitest run tests/voice-lifecycle.test.ts --maxWorkers=1` in `/home/christopher/GitHub/.worktrees/chriscord/sprint/client`:8/8 passed, exit0,770ms. Reviewer tool chunk0766da retained the output; no separate stdout file was created. Separate in-memory TypeScript/browser/API fixture reproduced peer0 missing DELETE before fix and required DELETE `/api/channels/synthetic-room/voice/0` after fix. Python AST, `sh -n infra/vm/entrypoint.sh`, and PyYAML/private-mount/network/UID assertions passed. No Rust/Kotlin build, Docker engine, GStreamer capture, SFU runtime, real guest audio/video, browser rendering, or hardware acceptance was performed by reviewer.

Owner checkpoint checks:35 client tests, TypeScript/Vite,11 policy/watchdog tests, rustfmt, offline locked no-dependency Cargo metadata and diff whitespace checks pass. These do not extend the independent review to unexecuted systems. Final VM hashes below include the corrected numeric0 source. Final docs/runner changes are separate source deltas recorded by the candidate manifest.

- `server/src/vm_media.rs` SHA256 `5c66bb315920ee2390ef62f489afcd9772142882cccf14cf0450d9c3e5d9b277`
- `server/src/vm.rs` SHA256 `3076498627f3ae8437276af016002ac0b6a3851520dbcceb57b6b8e247d6f974`
- `server/src/activities.rs` SHA256 `6f3b2ff68750548cc6cf01e9507e8e8724a2605da379838740a7f14932741f20`
- `crates/sfu/src/lib.rs` SHA256 `f2d43743903afc10e44f03e145c0866ead3a725d2bb7236d2590f2b28e12d83c`
- `client/src/transport/voice.ts` SHA256 `03a4eb4d666be0dbd197bc274c89332a13405d8b23f4d7bbbdb005580cd7bf30`
- `client/tests/voice-lifecycle.test.ts` SHA256 `c2046841b95cb8cf301e3c854c504e5e441537229fba45c9a0eedd629bc65c84`
- `client/src/App.tsx` SHA256 `becad0a16ed78024419ec6d6270e78de645c1f9fb5e956a7308ab55e297db989`
- `compose.vm-media.yaml` SHA256 `902bf925ae1f815a91a132d549ccabfdcff5eb57a3b82017a45ba1b366fa796a`
- `infra/vm/entrypoint.sh` SHA256 `ea15ad0723e1abb23e530f06597c7472713d6cdb360e7b42cecefe2291d73474`
- `infra/vm/media/publisher.py` SHA256 `990331a657730ac1cb5d0930278c06ae338b1ada2d8e4fd09e51344efdc401b4`
- `infra/vm/media/policy.py` SHA256 `80731c95564bb705638d38d0cd43f9b695a60b6ec5fa077b1838e1965af52fc5`
- `infra/vm/media/network.py` SHA256 `74fbec6c5019fbd86669df5c1872deab8f1a296eb7ba8884a39c69a8e59f31c2`
- `infra/vm/media/relay.py` SHA256 `3b54967f1fe2ee4c2a73c84c2c73b09ff824cc01ff2f540c5d206e3a27165f80`
