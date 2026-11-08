# Chriscord v0.1 implementation report

## Commits

- `50f8c89` — harden the server and desktop clients.
- `e98e542` — add deployment and desktop release artifacts.
- This report is committed separately after those implementation commits.

## Completed

- Enforced invite-only onboarding with a one-time owner setup token, email-address invites, seven-day single-use links, Argon2id passwords, login and invite-accept rate limits, session revocation on account disable, and route-class authentication tests. Resend delivery uses `RESEND_API_KEY`, `CHRISCORD_MAIL_FROM`, and `CHRISCORD_PUBLIC_URL`; when the API key is absent, the server logs a development invite link.
- Added the app and ClamAV scanner Compose services, bind-mounted app data, the `lo-proxy` network alias, deploy instructions, and tag/manual draft-release workflows for NSIS, universal macOS DMG, AppImage, and DEB.
- Desktop builds default to `https://chriscord.littleobelisk.com`; the login screen allows an override. Incomplete visible controls are disabled or labeled “coming soon.”

## Verification

- `bash scripts/recovery-check.sh server`: 96 passed, 4 explicitly ignored; formatting, clippy, release build, cargo audit, and cargo deny passed. The ignored cases need a live ClamAV fixture, an explicit multi-gigabyte upload fixture, a process-interruption fixture, or a manual multi-browser DJ fixture.
- Client unit tests: 35 passed across 3 files. TypeScript typecheck and Vite build passed. Chat Playwright flow: 1 passed.
- `docker build` from the repository root passed; receipt: `evidence/recovery-docker-build-20261108T040231-1258178/`.
- `docker compose config --quiet` and release-workflow YAML parsing passed.
- Linux Tauri gate and AppImage/DEB packaging passed. Bundles: `client/src-tauri/target/release/bundle/appimage/Chriscord_0.1.0_amd64.AppImage` (105 MB) and `client/src-tauri/target/release/bundle/deb/Chriscord_0.1.0_amd64.deb` (3.1 MB).
- Launched the AppImage with Xvfb and a disposable XDG profile; the Chriscord window reached the sign-in screen and showed the production server URL. Screenshot: `evidence/native-linux-launch-20261108T042955/login.png`.

## Deployment values for Noah

Set `CHRISCORD_SETUP_TOKEN` (remove after first-owner setup), `CHRISCORD_MEDIA_KEY` (32-byte hex key), `CHRISCORD_DATA_DIR`, `LO_PROXY_NETWORK` (`lo-proxy`), `CHRISCORD_ORIGIN`, `CHRISCORD_PUBLIC_URL`, `RESEND_API_KEY`, `CHRISCORD_MAIL_FROM`, `SFU_HOST_BIND` (`0.0.0.0`), `SFU_PORT` (`50000`), and `SFU_PUBLIC_IP`. The scanner uses ClamAV over a shared Unix socket.

Caddy's upstream is `http://chriscord:3000` on `lo-proxy`. The optional host HTTP mapping is `127.0.0.1:4317` for diagnostics. Permit and forward public **UDP 50000** to the host for SFU media. HTTPS/TCP 443 remains on the existing Caddy listener; the app currently uses HTTP polling and HTTP voice signaling, and media bypasses Caddy.

## Remaining limits

- No deployment, DNS, Caddy, firewall, or credential access was performed. Live Resend delivery was not exercised because no credentials were read.
- The known 20-peer SFU failure was not investigated further; the reported 10-peer run passed. There is no TURN service, so direct UDP may fail on restrictive networks.
- Windows and macOS packages are configured in CI but were not built locally; macOS is unsigned. Mobile release work is out of scope.
