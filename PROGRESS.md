# Sprint progress

## Verified
- Repository is a registered clean sprint worktree at base b2e22a7bcf00195d80045a799048009bf431e1cc, initially README.md and BRIEF.md only.
- Rust 1.98.1, Node 20.19.2, npm, gh, Docker CLI and systemd-run are available. Noah has 15 GiB RAM and approximately 39 GiB free disk; memory is already under pressure, so builds are bounded.
- No configured Git remote in this worktree: no remote fetch possible. No push/deploy performed.

## In progress
- Milestone 1: contract and unstyled handoff.

## Remaining
- All implementation and acceptance checks in PLAN.md. No functional feature is yet verified.

## Blockers / attempts
- None yet. Missing external credentials and device services will use documented env placeholders and fixture tests, not production calls.

## Evidence policy
Evidence files contain commands, observed outcomes and fixture/live distinction. Do not store tokens, private content, production URLs with credentials, or full environment dumps.

## Checkpoint: contract and encrypted media
- UI contract committed c795860; marker committed 880c3dd. All required screen IDs, states and intent boundary enumerated. Generic semantic HTML fixture is functional; visuals remain Opus-owned.
- Encrypted resumable store committed 6ec58da. Six security/property tests pass, one separately invoked >2 GiB fixture still running: evidence/media-tests.log and evidence/media-multigib.log. The fixture clean scanner is not real scanning evidence.
- Compose configuration validates (`docker compose config --quiet`). Docker unprivileged socket access denied; sudo local daemon access works. No container runtime acceptance yet.
- Linux native GTK/WebKit dependencies installed in bounded user-systemd job, evidence/native-deps.log. JDK installation running for local Android fallback.
- Romeo SSH timed out twice with BatchMode and 10-second connection timeout; approach blocked. No third identical attempt. Build Android locally next; emulator on Romeo remains unverified.
- API/client/activity code is in progress with separate agents; test logs are provisional until reviewed. No voice/SFU, live push, live activity playback, VM kill-switch, mobile E2E or platform build gate is complete.
- Large media first attempt stopped after ~1.4 GiB: `/tmp` is tmpfs and reached 97% across this shared host. This did not establish disk-backed low-memory behavior. Cleaned only the exact owned fixture directory; changed large test to repository target on real disk and buffered manifest serialization (avoids tiny write syscalls). Evidence/media-multigib-attempt1.log is incomplete, not a pass. Next run uses the corrected disk fixture.
- Activity domain/provider tests now pass 16 checks, including 3-member revisions, VM control lease, URL/protocol proptests, bounded provider replies and Gimme/Plex/Switchboard loopback fixtures (evidence/activities-tests.log). Actual media playback and live provider calls are not established by these fixtures.
- Local Android JDK21, command-line tools, platform35/build-tools35, NDK28.2 and aarch64 Rust target installed successfully; logs evidence/android-*. APK and emulator tests still pending.
- Initial cargo audit passed at the 165-dependency lock snapshot; cargo deny identified only private-crate license metadata and unversioned path dependency policy failures. Corrected private publication metadata/version declarations; final larger lock audit/deny rerun still required.
