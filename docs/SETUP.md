# Setup and current verification status

This repository is an in-progress private chat implementation. See PROGRESS.md for what actually passed; compose/native scaffolding does not mean the whole sprint is deployable. No deployment to Shiva is authorized in this work.

## Local isolated server

Requirements: Rust, Node 20+, npm; Docker/Compose for packaging. Run `python3 scripts/init-env.py` to create a mode-0600 `.env` with random bootstrap and media encryption secrets. Never commit it. Choose an unused loopback port (`4317` by default). With Docker: `docker compose up --build`. For a local source run: `npm ci --prefix client`, `npm run build --prefix client`, export the CHRISCORD variables from the private env file, and `cargo run -p chriscord-server`. Default source bind is `127.0.0.1:3000`; do not expose development servers publicly.

Open the server's same origin in a browser. First-run setup asks for the env bootstrap token and owner account. Invite links are issued by that owner and redeemed once before expiry. The current fallback requires a password of 12–256 bytes. Passkey flow and sub-60-second acceptance must be verified before calling onboarding complete.

Caddy eventually terminates HTTPS at the chosen origin and proxies to the loopback port. WebAuthn RP/origin must exactly match that HTTPS origin (localhost is a development exception). Native builds need an explicit allowed HTTPS origin and must never allow wildcard credentialed CORS. No anonymous public discovery or registration.

## Environment contract

| Variable | Purpose | Current state |
| --- | --- | --- |
| CHRISCORD_SETUP_TOKEN | random bootstrap secret, >=32 chars | server |
| CHRISCORD_DATABASE | isolated SQLite path | server |
| CHRISCORD_BIND | listener, loopback by default | server |
| CHRISCORD_STATIC_DIR | built client asset directory | server |
| CHRISCORD_ORIGIN | public HTTPS origin | confirm exact backend config before using passkeys |
| CHRISCORD_MEDIA_DIR | encrypted media directory | media storage |
| CHRISCORD_MEDIA_KEY | 64 hex chars, 32 random bytes | media integration; back up separately |
| CHRISCORD_CLAMD_SOCKET | scanner Unix socket | quarantine unless configured and scan succeeds |
| GIPHY_API_KEY | server-side Giphy integration key | unavailable until integration is wired |
| PLEX_URL / PLEX_TOKEN | allowlisted Plex server and private token | library adapter; live playback not verified |
| GIMME_BASE_URL / GIMME_AGENT_API_KEY | Gimme v2 origin/key | fixture/dry-run only for this sprint |
| GIMME_DRY_RUN | must remain true for development | no production mutation authorized |
| SWITCHBOARD_URL / SWITCHBOARD_API_KEY | local banter chat completion endpoint | role:chat, X-Inference-Task: chriscord.dj |
| DJ_TTS_COMMAND / DJ_REFERENCE_AUDIO | local synthesizer and explicit reference | see DJ-REFERENCE.md; placeholder until supplied |
| APNS_KEY_PATH / APNS_KEY_ID / APNS_TEAM_ID / APNS_TOPIC | mounted local signing credential/identifiers | native push not yet implemented |
| FCM_CREDENTIALS_PATH | mounted local FCM credential | native push not yet implemented |
| GLUETUN_CONTAINER | existing VPN namespace name | optional VM profile, no fallback |
| VM_MEMORY_MB / VM_CPUS | bounded guest resources | optional VM profile |

Do not put service secrets into client environment variables or Vite-prefixed variables. No production key is needed to run fixture tests. Any env documented as unavailable does not enable that feature merely by being filled in.

## Uploads

Resumable uploads use bounded encrypted chunks with 64-bit total lengths. A stopped client resumes from the server's committed offset. There is no product total-length cap. Storage exhaustion is an error, not successful completion. Files remain quarantined until scanning is complete. The optional `scanning` compose profile uses ClamAV and a shared Unix socket; its internal size limits mean huge-file scanning acceptance remains open. Never use the test clean scanner in production. No plaintext media spool is written to persistent disk.

## Platforms

The Tauri client project shares the web transport/state layer. Linux needs WebKitGTK/GTK build packages. Windows/macOS CI compiles on their respective hosts; Maya must generate/compile iOS with Xcode and test permissions, passkeys, audio sessions, screen sharing and background notification removal. Android needs JDK, SDK/NDK, Rust Android targets and an emulator/device. A compiled web bundle is not an APK or proof of mobile feature parity.

## Testing

Run `cargo test --workspace`, `cargo test --manifest-path crates/media/Cargo.toml`, `cargo test --manifest-path crates/activities/Cargo.toml`, and client scripts in package.json. The explicitly ignored media `multi_gib_interrupted_upload` test writes >2 GiB and must be invoked with `-- --ignored --nocapture` separately. Its scanner drains fixture bytes; it proves storage/resume/integrity, not malware detection. Evidence retains this distinction. No keys are printed into logs.
