# Chriscord: sprint brief (owner: Astra / gpt-6-astra, lead engineer)

You are the lead architect and engineer. Plan, orchestrate your own subagents (Codex multi-agent; give each a disjoint set of files), and do all the engineering. Commit early and often on branch `sprint` in this worktree. Never push, never deploy, and never touch another repo except read-only clones in `vendor-ref/` (gitignored).

## What it is
Chriscord is a private Discord + Telegram replacement for Christopher and his friends, a group of roughly 5–30 people. Christopher self-hosts it on his Unraid server "Shiva" (Docker; Caddy reverse proxy at littleobelisk.com; Tailscale available). It has to replace Discord and Telegram for them, so feature parity with Discord's everyday use matters more than enterprise features.

## Hard requirements
1. **Private by design.** Nobody gets in without Christopher's invitation: single-use, expiring invite links he issues, no open registration, no public discovery. Use strong auth (passkeys/WebAuthn plus a fallback), device-bound sessions with revocation, per-endpoint authorization tests, rate limiting, upload scanning and size handling, strict CSP, no third-party trackers, secrets only from env, and encryption at rest for media. Write `docs/THREAT-MODEL.md`. Fuzz the parsers and protocol (`cargo fuzz` or proptest), run `cargo audit`/`cargo deny`, and keep a security test suite. Decide whether DMs need E2EE (OpenMLS is a candidate) and justify the decision in `docs/DECISIONS.md`.
2. **Rust backend.** Suggested stack: axum + tokio, Postgres or SQLite, and an in-house Rust WebRTC SFU (str0m or webrtc-rs) for voice/video/screen. Very low resource use, near-zero VRAM. One `docker compose up` deploys it on Shiva. You may deviate from the suggestions if you justify it.
3. **Clients:** Windows, macOS, Linux, iPhone, Android. All of them must perform well and feel like one design language. Suggested: Tauri 2 (desktop + mobile) sharing one UI codebase. If you choose native mobile instead, justify it. iOS signing/device installs happen later on a Mac (Maya); you only need a project that builds. Android must build to an APK here or on Romeo.
4. **Chat:** servers/channels, DMs and group DMs, threads/replies, @mentions (user, role, @everyone) with autocomplete and notifications, reactions, edits, **unsend that deletes the message everywhere and retracts its push notifications** (APNs/FCM/desktop), typing indicators, read state, search, pins, rich embeds, markdown, built-in **Giphy** picker (API key from env), and **uploads with no size limit**. Use resumable chunked upload (tus or similar) with server-side video transcoding/thumbnails, streamed playback, and no cap except disk.
5. **Voice/video:** very low-latency camera streaming (target under 150 ms glass-to-glass on LAN, measured), screen share, and **highest-bitrate audio by default** (Opus 510 kbps stereo/fullband, toggleable per user), with noise suppression optional, not forced.
6. **Activities** (launchable in a voice channel; everyone in the channel sees them in sync):
   - **Watch party (Plex):** browse Christopher's Plex library and stream a movie in-app, with synced play/pause/seek, server-side transcoding through Plex, and subtitles. Plex token from env.
   - **DJ "Steve Forever":** study `github.com/strnadchristopher/steve-forever` (private; `gh repo clone` works here) for prior art. Search any song in the UI; accept YouTube, SoundCloud and Spotify links (Spotify resolves to metadata, then a matched playable source; yt-dlp for YT/SC). It has a shared queue, votes/skip and synced playback. Between songs, an AI DJ talks like a real radio disk jockey, funny and in character, **in Steve Harvey's voice**. Generate the banter text through the local Switchboard (`https://switchboard.littleobelisk.com/v1/chat/completions`, model `role:chat`, header `X-Inference-Task: chriscord.dj`) and the voice with a local TTS voice-clone model. Never use a hosted voice-clone API. The voice is for this private group only and never public; note that in DECISIONS.md. Build a pluggable TTS interface plus the clone pipeline, document exactly which reference audio it needs, and use a placeholder voice until Christopher supplies a reference clip.
   - **Shared VM (rabb.it-style):** research what rabb.it was. Run a Debian VM on Shiva (KVM/QEMU in a container) whose outbound traffic goes only through the existing gluetun VPN container (kill-switch: no VPN, no network; test it). Stream it into the activity at low latency (WebRTC). One user controls the mouse and keyboard at a time (request/handoff), and everyone else watches with audio. Persistent disk and a reset-to-snapshot option.
7. **Gimme integration:** a slash command / UI action to request movies and shows from Gimme and post status updates into a channel. Read `~/.hermes/skills/media/gimme-movie-requests/SKILL.md` and `~/.hermes/skills/media/gimme-app-operations/SKILL.md` for the API; use only test or dry-run calls.
8. **In-app bug reports and feature suggestions** (with optional screenshot and logs, consented), visible to Christopher in an admin view.
9. **Very easy setup:** the server is one compose file plus a first-run wizard; clients take an invite link, then passkey, then they're in, in under 60 seconds.
10. **Multiple themes.** Theme tokens live in one place.

## UI/UX ownership (important)
Claude Opus 5.5 owns all visual and interaction design. You must not design visuals. Build the client with clean separation: state, data, transport and hooks are yours; presentational components, layout, theming and motion belong to Opus under `client/src/ui/**` (or the equivalent you choose). As **milestone 1**, write `docs/UI-CONTRACT.md`: every screen, flow and state, the data and props available, and the events each component emits, with functional unstyled placeholder components. Commit it, then create the file `UI_CONTRACT_READY`. Opus works in a parallel branch against that contract; Noah merges. Keep the contract updated whenever you add a feature (append a changelog section).

## Testing: intense, end to end
- Playwright E2E across multiple simulated users: invite, then join, chat, @mention, unsend (verify notification retraction), upload a multi-GB file (resumable and interrupted), voice/video with fake media devices, measured latency, and every activity in sync across 3+ clients.
- Security tests: unauthenticated and cross-user access to every route, invite reuse/expiry, session revocation, upload abuse, SSRF on link embeds.
- Load test: 30 concurrent users in voice with video.
- Shared VM: verify VPN-only egress and the kill-switch.
- Mobile: Android emulator E2E (Romeo, `ssh -i ~/.ssh/id_ed25519_ideapad_hermes -o IdentitiesOnly=yes christopher@ideapad`, may need SDK install under ~); iOS: a buildable project plus the test plan for Maya.
Keep evidence (logs, screenshots, numbers) in `evidence/`.

## Environment
Noah: 4 cores, 15 GB RAM. Rust is installed (`~/.cargo/bin`). Keep builds incremental; use `sccache` if helpful. Don't run more than 2 heavy compiles at once. Do not use Archie's GPU.

## Anti-loop rules
- Keep `PLAN.md` (milestones with acceptance checks) and `PROGRESS.md` (verified vs. remaining, with evidence paths) current.
- If an approach fails twice, write the blocker in PROGRESS.md and move to the next milestone; don't retry the same thing a third time.
- Never block on Christopher. Use env placeholders for keys (Giphy, Plex, APNs/FCM) and document them in `docs/SETUP.md`.
- Prefer finished, tested vertical slices over broad stubs. A stub counts as not done.

## Done when
Every requirement above is implemented with passing E2E/security evidence, the UI contract is complete, the server deploys with one compose file locally (dry run; no Shiva deploy), desktop builds succeed for Linux (plus Windows/macOS via CI config), and an Android APK builds. Then create `SPRINT_DONE` with a one-paragraph summary.
