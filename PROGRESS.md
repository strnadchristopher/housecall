# Sprint progress

## Verified
- Repository is a registered clean sprint worktree at base b2e22a7bcf00195d80045a799048009bf431e1cc, initially README.md and BRIEF.md only.
- Rust 1.98.1, Node 20.19.2, npm, gh, Docker CLI and systemd-run are available. Noah has 15 GiB RAM and approximately 39 GiB free disk; memory is already under pressure, so builds are bounded.
- No configured Git remote in this worktree: no remote fetch possible. No push/deploy performed.

## In progress
- Milestones 2–7: core chat and browser passkeys verified; media, native builds, SFU and VM hardening in active implementation. See timestamped checkpoints below.

## Remaining
- Full acceptance matrix in PLAN.md remains incomplete. Checkpoints below distinguish working slices from pending gates.

## Blockers / attempts
- Missing external credentials and device services use documented env placeholders and fixture tests. Specific failed approaches are recorded below.

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
- Server passing snapshot: 8 module tests, 1 integrated media HTTP lifecycle test, 9 security tests (evidence/server-tests.log). After this snapshot, two-slot Argon2 concurrency guard and stricter WebAuthn origin validation were added; final regression still pending.
- SDK37 is advertised by generated Tauri template but absent from the official installed repository (`platforms;android-37` not found). Recorded evidence/android-sdk37.log. Android project now targets available API35; dependency compatibility remains to be built, no identical SDK37 retry.
- Rust dependency audit at the expanded 274-crate lockfile passed. cargo deny additionally required explicit allowance for TLS root-store data license CDLA-Permissive-2.0; this is a license allowlist entry, not a security-advisory suppression.
- Three-user browser E2E passed (29.0 s scenario; 37.8 s runner). Covers invite/chat/mentions/desktop-notification adapter closure, unsend, edits/replies/pins/search, DM isolation, virtual-authenticator passkey register/login/replay rejection, revoked bearer rejection, three-user activity control state, explicit Gimme dry run and a 5 MiB quarantined upload. Evidence/client-e2e.txt, client-playwright.json, client-three-user.png. Notification object is instrumented browser fixture, not APNs/FCM evidence. Nine client unit tests pass.
- 30-user HTTP chat load passed: 300 messages and 9000 membership events; 3.47 s send phase, debug server peak RSS 49332 kB. Evidence/load-chat.json. This does NOT satisfy 30-user voice/video load or LAN media latency.
- Expanded cargo deny now passes advisories/bans/licenses/sources at current pre-SFU lockfile; evidence/cargo-deny.log. Final lockfiles still need checks after SFU/native additions.
- Native Rust audit found real upstream glib 0.18.5 unsoundness RUSTSEC-2024-0429 and proc-macro-error unmaintained warning RUSTSEC-2024-0370. Added exact two-line glib upstream pointer-mutability backport under patches/glib, retaining licenses and visible advisory diagnostics. Native rebuild and optimized regression are pending; do not treat the earlier in-flight unpatched build as final security evidence.
- Real ClamAV fixture passed: clean encrypted media released, EICAR test string rejected/quarantined and unreadable (evidence/media-live-clamd.log). Initial fixture bind-mount ownership prevented socket creation; corrected only .runtime/scan to image UID/GID100:101, restarted only owned scanner fixture. This verifies small-file scanning, not huge-media analyzer coverage.
- Large encrypted fixture on disk is progressing at debug-crypto throughput (~4 MiB/s), with bounded buffers. Attempt to extend its runtime using systemctl set-property was rejected (RuntimeMaxUSec is not dynamically settable). Original15-minute bound remains; no success claimed before terminal receipt.

## Checkpoint: native build, SFU transport and security hardening
- Linux Tauri release binary built successfully in 14m50s (evidence/client-native-linux.txt). This initial artifact predates the glib backport; the patched rebuild is required before treating it as final. Optimized glib pointer regression passes (evidence/native-glib-regression.log). Upstream version-based advisory remains visible, no security ignore.
- Backend pre-transcode snapshot passes22 tests, including namespace/role/voice authorization. SFU standalone fixture establishes real ICE/DTLS/SRTP and forwards encoded frames between authorized peers, isolates an outsider and handles revocation (evidence/activities-sfu-tests.log). Browser decoded-media evidence is being collected separately.
- The disk-backed large upload was deliberately stopped at committed offset1,925,185,536 before its15-minute unit limit. A separate bounded process resumes the same encrypted store, verifies the complete2,147,483,771-byte payload and removes only its own fixture on success. Evidence/media-multigib-before-interruption.log and media-multigib.log. Until terminal pass this remains pending; fixture scanner is not a malware analyzer.
- Isolated Gluetun fixture exposed direct Docker-subnet IPv4/DNS egress even with tunnel down. UID-scoped firewall test closes that gap for IPv4; IPv6 fixture baseline fails so it is not a valid IPv6 kill-switch proof. Production VM boundary is being revised before acceptance; no Shiva/existing Gluetun modifications. Evidence/vm-killswitch*.
- Link metadata module adds fixed HTTPS443, all-answer public-IP DNS checks, address pinning, no redirects/proxies, bounded HTML and text-only output. Integration/security tests pending.

- Patched Linux release build passes4m29s (evidence/client-native-linux-patched.txt; checksum client-artifact-sha256.txt). Actual browser SFU test passes: each of3 users receives2 Opus audio streams and decodes2 VP8 video streams (evidence/client-voice-three-user.json). Physical latency/30-user load still pending.
- New automatic route inventory passes79 private method/path pairs against missing credentials, stolen bearer alone, wrong device key and revoked session. Full server regression passes32 tests including actual FFmpeg MP4/JPEG decode, cancellation/scan safety and text-embed SSRF/property tests. Dependency upgrade may trigger a later regression snapshot.
- Strict dependency audits: media, activities and SFU standalone lockfiles pass with warnings denied. Server audit identified scraper0.24's unmaintained fxhash dependency; upgrading to current scraper0.29. Native strict audit remains failing for proc-macro-error unmaintained. Cargo audit skips registry matching for local glib override; original warning and patch regression are retained, no advisory suppression. Evidence/audit-*.log.
- VM shipping nftables UID policy passes16 network namespace checks with6 external-IPv6 baseline skips. Independent positive IPv6 baseline test proves IPv6 drop using actual Debian VM image, surviving iptables flush. No guest boot/input/WebRTC evidence yet.

- Actual process-interrupted >2GiB storage fixture PASSES: resumed offset1,925,185,536; total2,147,483,771 bytes; full authenticated decrypt through fixture scanner, final range verified, own ciphertext directory removed. Resume/scan phase614.34s in debug crypto. Peak process RSS25,244kB; systemd768MiB cgroup includes disk page cache. Evidence/media-multigib.log and media-multigib-memory.txt. This is storage/process proof; browser-network proof is a separate pending test and fixture scanning does not imply huge-file ClamAV coverage.

## Checkpoint: integrated Plex gateway and verification handoff
- Current source commits:263ab4d client adapters,3be5767 Plex gateway. Final backend gate passes35 tests, including automatic91-private-route credential inventory;4 Plex adapter tests, rustfmt and clippy -Dwarnings pass. Browser Plex playback/load/synthetic screen-latency fixtures are implemented but not yet run.
- Android ARM64 Rust library builds. First Gradle packaging attempt fails because Tauri Android requires compileSdk>=36, while app used35. SDK36 was downloaded successfully by Gradle; changed only compileSdk to36 (targetSdk35 retained) and launched bounded corrected build. Evidence/client-android-build.txt preserves the failure; client-android-sdk36.log is provisional until terminal receipt. SDK37 remains unavailable; no repeated SDK37 install.
- Server strict audit314 dependencies and cargo deny pass after upgrading scraper to0.29 (removes unmaintained fxhash). Native audit still reports compile-time proc-macro-error maintenance warning; glib local backport and optimized regression remain reviewed evidence.
- Client and server sub-agent sessions stopped with usage-limit errors after code handoff. Root owns remaining work and running verification; no replacement model/provider or silent billing change. Gimme durable worker is not implemented yet; existing dry-run/domain adapters do not satisfy that requirement.
- Reclaimed about6GiB of completed duplicate build caches/obsolete executable tests, preserving current evidence-named binaries and dependency/incremental caches. No other repository or existing service was cleaned.

- Corrected SDK36 Android build PASSES: ARM64 debug APK at client/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk. apksigner verification passes; metadata and SHA256 retained in evidence/android-apk-metadata.txt and client-artifact-sha256.txt. This proves APK assembly, not emulator/device behavior or native passkeys. Stopped task-owned Gradle daemons before the browser load measurement.

## Checkpoint: bounded voice load
- Corrected resource accounting uses the dedicated test cgroup, excluding unrelated desktop Chromium processes. The second load attempt passes5 peers (each receives4 Opus and decodes4 video streams), but fails at10: some peers receive zero streams and others receive fewer than9. Peak sampled cgroup memory1767MiB, MemAvailable6949MiB; this is a media/signaling failure, not a proven memory ceiling. No30-peer acceptance. Evidence/client-voice-load.json and client-voice-load.log; first accounting failure preserved separately. Following the two-attempt rule, moving to independent screen-share/Plex/container gates instead of repeating this load unchanged.
