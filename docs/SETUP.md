# Setup and current verification status

This repository is an in-progress private chat implementation. See PROGRESS.md for what actually passed; compose/native scaffolding does not mean the whole sprint is deployable. No deployment to Shiva is authorized in this work.

## Local isolated server

Requirements: Rust, Node 20+, npm; Docker/Compose for packaging. Run `python3 scripts/init-env.py` to create a mode-0600 `.env` with random bootstrap and media encryption secrets. Never commit it. Choose an unused loopback port (`4317` by default). With Docker: `docker compose up --build`. For a local source run: `npm ci --prefix client`, `npm run build --prefix client`, export the CHRISCORD variables from the private env file, and `cargo run -p chriscord-server`. Default source bind is `127.0.0.1:3000`; do not expose development servers publicly.

Open the server's same origin in a browser. First-run setup asks for the env bootstrap token and owner account. Invite links are issued by that owner and redeemed once before expiry. The current fallback requires a password of 12–256 bytes. Browser passkey enrollment/login passes a virtual-authenticator E2E; native OS passkey bridging and sub-60-second onboarding remain acceptance gates.

Caddy eventually terminates HTTPS at the chosen origin and proxies to the loopback port. WebAuthn RP/origin must exactly match that HTTPS origin (localhost is a development exception). Native builds need an explicit allowed HTTPS origin and must never allow wildcard credentialed CORS. No anonymous public discovery or registration.

## Environment contract

| Variable | Purpose | Current state |
| --- | --- | --- |
| CHRISCORD_SETUP_TOKEN | random bootstrap secret, >=32 chars | server |
| CHRISCORD_DATABASE | isolated SQLite path | server |
| CHRISCORD_BIND | listener, loopback by default | server |
| CHRISCORD_STATIC_DIR | built client asset directory | server |
| CHRISCORD_ORIGIN | public HTTPS origin | WebAuthn RP/origin validation |
| CHRISCORD_CLIENT_ORIGINS | comma-separated exact native client origins | explicit CORS allowlist, no wildcard |
| SFU_BIND / SFU_PUBLIC_IP | source-mode UDP bind / advertised IP | both required to enable Rust SFU |
| SFU_HOST_BIND / SFU_PORT | compose UDP host interface / same host+container port | loopback:50000 default; choose LAN/Tailscale address explicitly |
| CHRISCORD_MEDIA_DIR | encrypted media directory | media storage |
| CHRISCORD_MEDIA_KEY | 64 hex chars, 32 random bytes | media integration; back up separately |
| CHRISCORD_CLAMD_SOCKET | scanner Unix socket | quarantine unless configured and scan succeeds |
| GIPHY_API_KEY | server-side Giphy integration key | search/media proxy implemented; unavailable without key |
| PLEX_URL / PLEX_TOKEN | allowlisted Plex server and private token | library adapter; live playback not verified |
| GIMME_BASE_URL / GIMME_AGENT_API_KEY | Gimme v2 origin/key | fixture/dry-run only for this sprint |
| GIMME_DRY_RUN | must remain true for development | no production mutation authorized |
| SWITCHBOARD_URL / SWITCHBOARD_API_KEY | local banter chat completion endpoint | role:chat, X-Inference-Task: chriscord.dj |
| DJ_TTS_COMMAND / DJ_REFERENCE_AUDIO | local synthesizer and explicit reference | see DJ-REFERENCE.md; placeholder until supplied |
| PUSH_ENABLED / PUSH_TOKEN_KEY | opt-in worker and separate32-byte hex token-encryption key | default disabled; server provider tests and native bridges tracked separately |
| APNS_PRIVATE_KEY_PEM / APNS_KEY_ID / APNS_TEAM_ID / APNS_TOPIC / APNS_SANDBOX | env-provided P-256 signing credential/identifiers; sandbox false by default | APNs provider; native registration/background receipt pending |
| FCM_SERVICE_ACCOUNT_JSON | env-provided service-account JSON with RSA private key | FCM HTTP v1 provider; native registration/background receipt pending |
| GLUETUN_CONTAINER | existing VPN namespace name | optional VM profile, no fallback |
| VM_MEMORY_MB / VM_CPUS | bounded guest resources | optional VM profile |
| VM_KVM_GID / VM_TUNNEL_INTERFACE | host KVM group / tun0 or wg0 | reserve UID47191 in shared Gluetun namespace; literal resolver in infra/vm/resolv.conf |

Do not put service secrets into client environment variables or Vite-prefixed variables. No production key is needed to run fixture tests. Any env documented as unavailable does not enable that feature merely by being filled in.

## Uploads

Resumable uploads use bounded encrypted chunks with 64-bit total lengths. A stopped client resumes from the server's committed offset. There is no product total-length cap. Storage exhaustion is an error, not successful completion. Files remain quarantined until scanning is complete. The scanner compose service uses ClamAV and a shared Unix socket; its internal size limits mean huge-file scanning acceptance remains open. Never use the test clean scanner in production. No plaintext media spool is written to persistent disk.

## Platforms

The Tauri client project shares the web transport/state layer. Linux needs WebKitGTK/GTK build packages. Windows/macOS CI compiles on their respective hosts; Maya must generate/compile iOS with Xcode and test permissions, passkeys, audio sessions, screen sharing and background notification removal. Android needs JDK, SDK/NDK, Rust Android targets and an emulator/device. A compiled web bundle is not an APK or proof of mobile feature parity.

## Testing

Run `cargo test --workspace`, `cargo test --manifest-path crates/media/Cargo.toml`, `cargo test --manifest-path crates/activities/Cargo.toml`, and client scripts in package.json. The explicitly ignored media `multi_gib_interrupted_upload` test writes >2 GiB and must be invoked with `-- --ignored --nocapture` separately. Its scanner drains fixture bytes; it proves storage/resume/integrity, not malware detection. Evidence retains this distinction. No keys are printed into logs.

Native dependency note: patches/glib contains the exact upstream pointer-mutability safety correction required by Tauri's GTK3 dependency graph. See patches/README.md and evidence/client-cargo-audit.log. Cargo audit skips registry matching for the local path override, so retain the original glib advisory receipt; the patch must be checked and the native target rebuilt before release. No global advisory suppressions are applied.

## Voice networking

Compose binds HTTP and SFU UDP to loopback by default for isolated local testing. Caddy carries HTTPS/signaling; it does not carry the SFU UDP media port. For eventual LAN/Tailscale service, set SFU_HOST_BIND to the chosen host interface and SFU_PUBLIC_IP to its reachable IP, retaining the same SFU_PORT externally and internally. Restrict firewall exposure to the intended friends network. Three Chromium clients have exchanged real decoded media locally; cross-NAT/TURN, mobile transport and physical latency remain unverified. No TURN relay is currently configured.

Text link previews use authenticated explicit user actions. The server fetches only public HTTPS443 destinations, validates every DNS answer and pins the selected IP, disables redirects and environment proxies, limits HTML to512KiB, and returns title/description as text. It does not fetch remote thumbnails or execute page HTML. A preview request reveals the server IP to that destination; previews are not fetched automatically while typing.

CPU media derivatives use CHRISCORD_FFMPEG (default /usr/bin/ffmpeg) and CHRISCORD_TRANSCODE_TIMEOUT_SECONDS (default21600, maximum86400). They run one job at a time, require scanned source and outputs, and produce encrypted fragmented MP4/JPEG through bounded pipes. See API.md for restart, cancellation, and non-seekable input limitations.

### Durable Gimme requests

Compose keeps `GIMME_DRY_RUN=true`: requests persist and appear in channel history without contacting Gimme. An explicitly configured standalone runtime can enable provider requests with `GIMME_DRY_RUN=false`, `GIMME_BASE_URL` and `GIMME_AGENT_API_KEY`; use HTTPS except loopback test fixtures. No production Gimme calls were made during this sprint.

The worker discovers API v2, saves the submission intent before sending, and retains an accepted job ID across restart. Provider errors stop tracking visibly; an uncertain submission is never automatically repeated. Inspect the saved request/provider job before creating a new request. This implementation does not confirm a torrent, cancel a download, or interpret a subscription as completed episode downloads.

### Android localhost test fixture

Normal native CSP requires HTTPS APIs. `client/src-tauri/tauri.e2e.conf.json` is an explicit debug-only overlay adding HTTP127.0.0.1:3031 for the isolated emulator backend; never ship it. Build with `tauri android build --config src-tauri/tauri.e2e.conf.json --target aarch64 --debug --apk`. Use a dedicated ADB server/AVD, wait for `sys.boot_completed=1`, install the test APK, reverse TCP3031, and run `node scripts/test-android.mjs` against an empty local database with the synthetic setup token specified in that script and native origins allowlisted. The test checks password-fallback invite/chat/unsend/revocation; native passkeys, background push and physical-device behavior require separate checks.

### DJ runtime packaging

The Compose image includes FFmpeg/ffprobe, espeak-ng placeholder speech, Python3, pinned yt-dlp2026.08.19 with verified official SHA256, and Node22. [yt-dlp EJS requirements](https://github.com/yt-dlp/yt-dlp/wiki/EJS) require a supported JavaScript runtime; the resolver explicitly selects Node and disables remote solver downloads and plugin directories. Set `DJ_ENABLED=true` to enable playback after configuring Switchboard access. `SPOTIFY_ACCESS_TOKEN` enables Spotify metadata lookup; Spotify is never treated as an audio source. The writable DJ scratch directory is `/tmp/chriscord-dj` on container tmpfs. No provider calls are made by default or by sprint tests.

DJ preparation limits are15minutes/song,60seconds/intro,32MiB downloaded source,64MiB encoded asset,512MiB total encrypted cache and one simultaneous producer. These are DJ cache safeguards, not upload-size limits. Missing local clone configuration uses synthetic placeholder speech. See DJ-REFERENCE.md for local model/reference requirements; do not supply hosted voice APIs. Browser DJ playback currently buffers a bounded asset before synchronizing, so slow links can miss its beginning. Live provider compatibility and native codec behavior still need validation.
