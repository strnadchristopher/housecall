# Chriscord sprint acceptance plan

Source of scope: BRIEF.md. Worktree: sprint. Base: b2e22a7bcf00195d80045a799048009bf431e1cc.
Owner: root engineering agent; Codex subagents have disjoint file ownership. No push, deploy, production mutation, or Archie GPU use.

1. **UI contract and handoff**: enumerate every required screen/flow/state, typed data/events, functional unstyled placeholders; commit, then create UI_CONTRACT_READY. Opus owns visual/interaction design under client/src/ui. Contract capability status must distinguish working from planned features.
2. **Private chat vertical slice**: Rust/SQLite boot, one-time setup, expiring single-use invitations, passkeys plus fallback, device-bound/revocable sessions, scoped channels/DMs, replies/threads, edits/reactions/pins/read/mentions, realtime, unsend and notification tombstones. Acceptance: HTTP authorization matrix and multi-user browser tests, revocation/reuse/expiry tests.
3. **Media**: encrypted resumable disk-bounded uploads, scanning/quarantine, streaming/ranges, thumbnails/transcoding, safe embeds, Giphy proxy. Acceptance: interruption/resume including multi-GB fixture, ownership/abuse/SSRF tests, disk/memory evidence.
4. **Voice and synchronized activities**: Rust SFU with audio default 510000 bps stereo/fullband and optional suppression; camera/screen; Plex; DJ queue/votes/Switchboard/local pluggable TTS; VPN-only Debian VM/control/snapshot. Acceptance: 3-client sync, real media latency, 30-peer load, VPN kill-switch. Infrastructure/configuration alone does not count as implementation.
5. **Integrations and administration**: Gimme v2 fixture/dry-run request/job/status flow, consented reports with admin access, env setup wizard. Acceptance: mock integrations and access/consent tests.
6. **Packaging**: one compose file, Linux desktop build, Windows/macOS CI, Android APK plus emulator E2E, iOS buildable project and Maya test plan. Acceptance: local compose config/build/start test isolated from Shiva; artifact checksums and platform evidence.
7. **Security and release gate**: threat model/decisions/setup, proptest parsers/protocol, cargo audit/deny, full E2E/security regressions. Every BRIEF.md requirement mapped to evidence; only then SPRINT_DONE.

## Execution rules

No more than two heavy compiles; Rust uses jobs=2, serialize native builds when memory is tight. Secrets never logged or committed. External-service tests use isolated fixtures. Record two failures of the same approach and move to another milestone. No skipped or mocked test presented as real deployment, media latency, push delivery, device, or VPN evidence.

## Current acceptance order

UI contract and tested private-chat/media/Plex/Gimme slices are committed. Complete installed-APK Android core flow, rebuild and verify corrected Compose image, then run SFU load diagnostics after all heavy jobs stop. Continue missing DJ media orchestration, booted VM capture/control, native push and platform gaps explicitly tracked in docs/TEST-MATRIX.md. SPRINT_DONE remains forbidden while any requirement is unverified.
