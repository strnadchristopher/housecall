# Recovery execution gates for Noah

Source remains in `/home/christopher/GitHub/.worktrees/chriscord/sprint`, integrated UI HEAD `aecee37e93a4532c6bbe465ee5b8e2ab7fd9d5d6` plus retained dirty engineering changes. No push, deployment, live Gimme, existing VPN changes or credential invention is authorized. All original BRIEF.md acceptance checks remain in force.

The heavy lock is legitimately held by Switchboard acceptance PID1031327/unit `sprint-recovery-switchboard.service`. Noah has queued the retained historical SFU profile behind its completion. Do not disturb, bypass or repeatedly probe this owner. Until the profile receipt arrives, preserve the frozen launcher/test/package files recorded in `evidence/recovery-vm-frozen-paths-20261108T022913Z.json`; do not replace `target/release/chriscord-server`. Other assigned source work continues.

After the lock becomes available, run these serially from the source directory. Each invocation acquires the SAME read-open lock, waits at most 60 seconds, checks the 12 GiB disk floor, bounds runtime and creates a unique evidence directory with log/exit/source delta. Exit75 can mean initial refusal or a during-run disk-floor stop; inspect the receipt. The command guard monitors free disk every0.5s and terminates only its owned process group if the12GiB floor is reached. No broad cache/source/evidence cleanup.

```bash
bash scripts/recovery-check.sh sfu-profile
bash scripts/recovery-check.sh server
bash scripts/recovery-check.sh native-push-browser
bash scripts/recovery-check.sh chat-browser
bash scripts/recovery-check.sh android-tests
bash scripts/recovery-check.sh android-apk
```

Return the SFU `voice.json`, output/exit and binary checksum immediately to the implementation owner before running another load attempt. The first measurement diagnoses worker phase cost; it is not a capacity pass. A corrected candidate must subsequently pass 30 peers, sustained decoded audio/video and disconnect/recovery checks without increasing queue/deadline limits to hide overload. Browser native-command injection checks session integration only; it is not Kotlin/Keystore/FCM proof.

The Android gates need write access to the existing host Gradle cache and a toolchain able to resolve the pinned Firebase/WorkManager dependencies. No production Firebase configuration is needed for unit tests or an unconfigured APK. Device instrumentation (`PushStoreTest`) needs the disposable emulator and `/dev/kvm`; retain its own installed APK checksum and emulator receipt. Do not run an emulator concurrently with compile/browser load. The previously passing APK predates native push and Opus integration.

Fresh real-scanner/Compose and VM checks require host Docker/KVM access, unavailable in the current sandbox. Exact serial fixture commands are now packaged in `scripts/recovery-host-check.sh`:

```bash
bash scripts/recovery-host-check.sh compose
bash scripts/recovery-host-check.sh vm
bash scripts/recovery-host-check.sh android-device
```

This runner acquires the same lock, checks disk, preserves pre-existing stable-name receipts in a unique evidence directory, builds exact-source fixture artifacts, applies bounded timeouts and records terminal exit. Compose refuses an existing fixture project and uses only `chriscord-sprint-compose`; the signature cache must already exist as `chriscord-sprint-scanner_scanner-db`. VM builds the two local fixture images and checksum-verifies the pinned Debian base before the full guest input/VPN/persistence/reset scenario. Android builds the dedicated local-HTTP debug APK plus test APK, then runs real Keystore/reconciliation instrumentation before the installed-WebView regression; it refuses its fixed fixture ports when occupied. Android force-clears only the disposable Chriscord test application. No live accounts/providers are used.

The packaged recovery-bound.py guard enforces the12GiB floor during builds, downloads and fixture execution; it preserves the process-group leader until cleanup and reap. A timeout/kill without verified cleanup is not a pass. Harness SIGTERM handling runs fixture cleanup; inspect `cleaned_owned_containers_and_network` and Compose terminal logs. Only isolated owned projects/volumes may be removed. Original >2GiB bytes must remain quarantined with the current ClamAV hard limit; successful upload followed by rejection does not satisfy usable playback. The OPTIONAL whole-object WithSecure experiment, if selected, needs authentic licensed engine provisioning, policy/privacy qualification and real large-media tests described in `docs/WHOLE-OBJECT-SCANNER.md`. The stock image contains no WithSecure installation. Final exact-source runtime, native distributables and hardware media/push/passkey gates remain pending.

Noah owns protected Git index writes, review/merge and subsequent separately scoped rollout. Do not change sandbox permissions to permit commits. Physical Android FCM and Apple APNs require authentic provisioning; Maya Xcode/iOS and physical LAN camera latency cannot be replaced with mocked receipts.

Current-source native Linux and the new media source preflight have explicit gates:

```bash
bash scripts/recovery-check.sh native-linux
bash scripts/recovery-host-check.sh vm-media-preflight
```

The VM media preflight builds the two source/audio images and verifies required GStreamer elements with networking disabled. It is not a guest/SFU playback test. The existing `vm` gate tests the serial Debian fixture, QMP input, persistence and offline reset; it does not test the new WebRTC publisher. A desktop-guest/three-viewer acceptance harness and app-driven safe snapshot reset remain source work. `compose.vm-media.yaml` is an explicit opt-in overlay; do not apply it to an existing live VPN or deployment. Its parsed source/mount/UID checks passed; Docker-engine validation and new image behavior are pending.

Optional WithSecure experiment only, not a required purchase or release prerequisite: if Noah selects this adapter, first qualify its local-only processing, private scratch policy and full-object coverage, then run:

```bash
CHRISCORD_FSANALYZE=/opt/f-secure/linuxsecurity/bin/fsanalyze bash scripts/recovery-host-check.sh whole-object
```

This gate rebuilds the exact server under the lock and records its checksum, then executes `scripts/test-whole-object-engine.py`. The script requires20GiB free initially, generates24seconds of real1920×1080 raw video plus stereo audio (>2GiB), uploads it with an offset-inspection/resume checkpoint, requests the authenticated end range, derives scanned MP4 and decodes/seeks at0s and22s. A clean ZIP containing the actual >2GiB video plus a benign final entry must release successfully; its encrypted upload and plaintext ZIP are deleted before constructing a same-structure/same-entry-length ZIP with the harmless EICAR test entry beyond2GiB. The latter must remain quarantined with original/derivative access blocked. API423 combines detection, unsupported input, engine error and timeout, so this establishes quarantine only: even with the clean control, a positive vendor detection beyond2GiB remains separately unqualified. No padded or sparse oversized file substitutes for media payload. Backend termination precedes owned temporary-file removal on success/failure; the resource guard enforces12GiB throughout. This is scripted but unexecuted because the engine is absent. A clean CLI result alone does not prove unsupported/nested/encrypted coverage, browser/native decoding, malicious archive coverage generally, or engine service privacy; those qualification gates remain open.

The `sfu-profile` receipt explicitly identifies the retained optimized instrumented binary as historical and hashes it. Its purpose is phase-cost diagnosis before the source optimization; all acceptance runtimes must then be rebuilt from the frozen final manifest. Each normal/host runner records allowlisted tracked AND untracked sources, the four explicit runtime launcher inputs, and a before/after identity check. A differing source manifest returns76 and invalidates frozen-candidate acceptance.

## New VM continuation source gates (after queued profile receipt)

Do not run these while the current Switchboard/profile reservation is pending. The existing frozen runners are unchanged. In the same host heavy-lock lane, with one bounded worker and `scripts/recovery-bound.py` covering each command, build:

```bash
sudo -n docker build -f infra/vm/desktop/Dockerfile.prepare -t chriscord-vm-prepare:local infra/vm/desktop
sudo -n docker build -t chriscord-vm:fixture infra/vm
sudo -n docker build -f infra/vm/media/Dockerfile -t chriscord-vm-publisher:local infra/vm/media
sudo -n docker build -f infra/vm/media/Dockerfile.audio -t chriscord-vm-audio:local infra/vm/media
sudo -n docker build -t chriscord-app:vm-fixture .
python3 scripts/prepare-vm-desktop.py
python3 scripts/test-vm-desktop.py --desktop-receipt /absolute/path/from-preparation/receipt.json
```

These are individual payload commands for the existing locked/resource-guarded host execution, not authorization to bypass that lane. Use a new per-run log and do not overwrite earlier evidence. Preparation needs the retained pinned Debian base and source-built appliance; its explicit package downloads are fixture-only. The final runtime records exact image IDs and source hashes but does not establish their build provenance by itself: retain the preceding source-bound build logs too. No live VPN/production server is targeted. The supervisor reset and status route Rust tests must compile/pass in the regular server gate before runtime acceptance. New11 Python supervisor tests and2 client transport tests are lightweight; full actual QEMU/browser/UID/firewall and physical timing remain distinct gates.
