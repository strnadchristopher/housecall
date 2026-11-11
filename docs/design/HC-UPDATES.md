# Housecall updates: handoff log

## Phase 1

Status: code complete and committed. Three verification steps could not run because the sandbox required approval for them (see "Unverified"). Treat 1A E2E and 1B as not yet run.

### Commits
- `b1f792b` wip: finish previous phase (the three `crates/*/Cargo.lock` files had only package reordering; `npm run build` and `npm test` passed first)
- `1394849` fix(call): fall back to default devices and audio-only instead of failing join
- `557a3c4` test(call): e2e for joining with a missing saved microphone
- `08313b4` feat(ci): one server test script that CI and contributors share
- the commit that adds this file

### What changed
- `client/src/transport/voice.ts`: `acquireMedia()` tries saved device, then default device, then no camera. `VoiceStatus` gains `warning` and `camera`. `join()` uses it and `camera()` retries without `deviceId` when the saved camera is gone. With no microphone, the error is "No microphone found. Plug one in or allow microphone access, then try again."
- `client/src/core/call.ts` and `adapters/legacy/call.ts`: `CallState.warning`. `refreshDevices` drops a saved device id that is no longer listed. It does nothing while ids are blank (before capture permission), so a valid saved id is not discarded.
- `client/src/ui/chat/CallBar.tsx`, `ui/styles/index.css`: a `role="status"` warning line with a text "Dismiss" button (reuses `copy.common.dismiss`). Design rules applied: "Say less" and "Labels as tinted pill chips" (plain text line, no chip, icon tile or glow).
- `scripts/test-server.sh`: CI's six steps in order, `PASS`/`FAIL` per step, summary, exits on the first failure, `CARGO_TARGET_DIR` defaults to `$PWD/target`. CI runs it as `bash scripts/test-server.sh`. `docs/SETUP.md` and `CONTRIBUTING.md` name it. `cargo audit` and `cargo deny` stay in CI as separate steps.

### Tests run (real results)
- `npm run build` (client): passed after each commit.
- `npm test` (client): 2 files, 30 tests passed (26 before, plus 4 new in `tests/voice-lifecycle.test.ts`: saved-device fallback, mic-only fallback, no-microphone message, camera-on fallback mid-call).
- `npx vitest run tests/voice-lifecycle.test.ts`: 12 passed.

### Unverified
- 1A E2E `HOUSECALL_TEST_VOICE=1 npx playwright test -g "missing device"`: written (`tests/e2e/voice.spec.ts`) but NOT run; the command needed approval that was not available. The full voice spec was not re-run either, so "whole voice spec stays green" is unconfirmed.
- 1B `bash scripts/test-server.sh`: NOT run (approval required), so no summary to paste. The baseline counts from the brief are unconfirmed on this commit. No Rust code changed in this phase, only the script, CI, docs.
- `scripts/check-public-safe.sh`: NOT run (approval required). New fixtures use `example.test` style names and no real data, but this is unchecked.
- The unit tests were written together with the implementation, so I did not observe the plan's "3 failed" red state first.

### Deviations from the plan
- The "no microphone" unit test uses `await expect(session.join(...)).rejects.toThrow()` because `join` rethrows after setting `failed`.
- `scripts/test-server.sh` could not be marked executable here (`chmod` and `git update-index --chmod` needed approval), so CI and docs call `bash scripts/test-server.sh`. Noah can run `chmod +x` and `git update-index --chmod=+x scripts/test-server.sh` and switch back to the bare path if wanted.
- Device selection is not persisted in this app (plain React state), so the plan's `localStorage` injection does not apply. The E2E instead injects a stale microphone id into `enumerateDevices`, selects it in Settings, and joins; Chromium itself rejects the unknown id.
- The adapter joins with the camera off, so the join-time "no camera" fallback is covered by the unit test and the transport, while the E2E covers the saved-microphone path.

## Phase 2

Status: code complete and committed. The upload E2E could not run here (no ClamAV), so the inline-media UI is verified by build, types and unit/server tests only. Treat the E2E as not yet run.

### Commits
- `feat(media): attachment display kind` (server `attach_kind.rs`, `kind` on each attachment in `fn message()`, tests)
- `feat(chat): attachment kind in client types and authenticated media fetch` (`Attachment.kind/thumbnail`, `Chat.fetchMedia`, `messageView` mapping, vitest case)
- `feat(chat): render images, gifs and videos inline` (`Attachments.tsx`, `useMediaUrl.ts`, `Message.tsx`, CSS, copy, e2e spec)
- the commit that adds this section

### What changed
- Images and GIFs (up to 25 MB) render in the message through an authenticated blob URL and open in a lightbox (`role="dialog"`, Escape closes, focus returns, Download action). Videos render as a `<video controls>` in place with the transcode thumbnail as poster, no Play click. A video with no transcode yet shows a `role="status"` "Processing video" row. Everything else, and any image that fails to load, keeps the file card with Download.
- Refresh on transcode: any server event already makes the poll loop call `refresh()` (`hooks/useHousecall.ts`), and `transcode.rs` already emits `media.ready` when a job finishes. No emit was added. The message list therefore picks up `video_path` and flips to playable without a reload.
- Design rules applied (also in the commit body): bare icons with no tile; no shadow, glow or pill chip on media; content visible by default with no opacity-0 entrance; clear the cut (`object-fit: contain` inside `overflow:hidden`, lightbox controls inset from the edge); no hover movement; terse copy, no em dashes. Skeleton shimmer is stopped by the existing global `prefers-reduced-motion` rule.

### Tests run (real results)
- `cargo test -p housecall-server --lib attach_kind`: 1 passed.
- `cargo test -p housecall-server --test media`: 2 passed (existing upload test plus new `message_attachments_carry_a_display_kind`: png=image, gif=gif, mov=video_pending, pdf=file).
- `npm test` (client): 2 files, 31 tests passed (30 before, plus 1 for attachment kind mapping).
- `npm run build` (client): passed after each commit.
- `npx playwright test` (default, `chat.spec.ts`): 1 passed.
- `HOUSECALL_TEST_UPLOAD_VIDEO=1 npx playwright test`: 2 failed, 0 passed. Both stop at the attach step (`getByTestId("attached")` never appears) because `.runtime/scan/clamd.sock` does not exist and `clamd` is not installed or runnable here (no Docker permission). The first test fails at line 38, before any line I changed. This is the environment, not a result about the code.
- `HOUSECALL_TEST_UPLOAD_VIDEO=1 npx playwright test --list`: both specs load.

### Unverified
- The new E2E (png `naturalWidth > 0`, lightbox open and Escape, gif inline, `.txt` stays a card, unprepared video shows processing then plays after `POST /api/uploads/{id}/derive`, with no reload) and the edited first test (no Play click) were not run against a scanner. Please run `HOUSECALL_TEST_UPLOAD_VIDEO=1 npx playwright test` from `client/` where ClamAV is up. I started to write a stand-in scanner that always answers OK, but running it needed approval, so I deleted it rather than work around that.
- `scripts/check-public-safe.sh` was not run (needs approval). New fixtures use `video_owner`/`media_friend` and generated media only; no real data or URLs were added.
- Whether an unprepared video stays in `video_pending` long enough for the E2E to see it depends on nothing auto-transcoding on send. I found no auto-derive call in the client, but it is unconfirmed.
- Real-device and visual checks of the lightbox and layout were not done (Noah's job).
- The Rust binary was rebuilt (`cargo build -p housecall-server`), so `target/debug/housecall-server` matches this branch.

### Deviations from the plan
- Inline renderers live in a new `ui/chat/Attachments.tsx` instead of inside `Message.tsx`; `Player` moved there with them and lost its close button (inline only).
- `transcode.rs:151` was not changed: that code patches the media-job status value, which has no filename or attachment, so there is no attachment JSON to add `kind` to. The only attachment JSON is `fn message()`.
- `kind` is mapped in `data/messageView.ts` (testable, camel-casing layer) and passed through the adapter; the vitest case calls `messageDetails` rather than the adapter.
- I did not observe the red state first for the vitest case; the test was written together with the mapping.
- `useMediaUrl` also resets its state when `path` changes, so a reused row never shows the previous blob.
- The second E2E test reuses the first test's owner (`video_owner`, same password) and logs in when setup returns 409, because the server is shared by tests in one run.
- The removed `.hc-player` CSS rule had no remaining users; `.hc-film` (used by the chords panels) is kept.

## Phase 3

Profile name and avatar, server name and icon, `MediaDropzone`, report screenshot picker (tasks 3.1 to 3.6).

### Commits
- `67ab77e` feat(profile): shared image blob validation
- `ef5c9b0` feat(profile): display name, avatar, server name and icon routes (schema, routes, events, `/api/me` and `/api/members` fields)
- `f893097` fix(profile): server member list includes display name and avatar rev
- `87d0453` style(test): cargo fmt `server/tests/media.rs` (pre-existing diff from Phase 2 that made `test-server.sh` fail at its fmt step)
- `a121d69` feat(profile): client model, Account and Server settings, `Avatar` images, `MediaDropzone`, report drop zone, e2e

### What changed
- Server: `users.display_name/avatar/avatar_type/avatar_rev` and `servers.icon/icon_type/icon_rev` (idempotent ALTERs). `PATCH /api/me`, `PUT/DELETE /api/me/avatar`, `GET /api/users/{id}/avatar`, `PATCH /api/servers/{id}`, `PUT/DELETE/GET /api/servers/{id}/icon`. Avatar and icon bodies are capped at 512 KB, magic-byte checked, SVG rejected. Owner-only for server routes; icon GET needs server membership. `member.updated` goes to every channel the user is in; `server.updated` to the server's general channel. `/api/me`, `/api/members`, `/api/servers/{id}/members` and `/api/servers` carry `display_name` and `avatar_rev` / `icon_rev`.
- Two real bugs found by the new tests and fixed: (1) `INSERT OR IGNORE INTO servers VALUES(...)` in `servers::init` failed on the second startup once `servers` had extra columns, so a restart on an existing database would have crashed; both seed and create INSERTs now name their columns. (2) The global `headers` middleware overwrote every `Cache-Control` with `no-store`; it now keeps a handler's own value, so avatars and icons get `private, max-age=31536000, immutable`.
- Client: `data/people.ts` (`nameOf`, `userName`, `avatarPath`, `iconPath`; `nameOf` re-exported from `ui/format.ts`). `Person.name` is now the display name with `username` kept beside it; mentions and mention suggestions still use the username. Display names reach messages, People, the friend list, the call bar and the user bar, plus call participant names. `Avatar` takes `src` (authenticated path, shared per-session cache) and `shape="squircle"`; the server picker shows squircle icons in rows and in the trigger when an icon is set. Settings has Account (display name, picture, sign out) and a new owner-only Server section (name, icon). Images are resized client-side to at most 256 px before upload (`ui/settings/resizeImage.ts`).
- `MediaDropzone` in `ui/kit.tsx`: click to browse, drag and drop, paste, preview thumbnail, remove, type and size errors. Used by the report screenshot, the avatar and the server icon.
- Behaviour fix: a rejected report (for example no consent) used to clear the description, logs and screenshot. `submitReport` now returns success and the form clears only on success.
- UI guidelines applied (in the commit body): bare icon with no box; tonal accent fill and a dashed edge with no glow or shadow; nothing moves on hover; flat tonal arch initials (no gradient circles); no em dashes; content visible by default.

### Tests run (real results)
- `cargo test -p housecall-server --lib image_blob`: 3 passed.
- `cargo test -p housecall-server --test profile`: 11 passed, 0 failed.
- `cargo test -p housecall-server` (before the last server-list fix): all suites ok, including `route_inventory` 1 passed and `security` 16 passed.
- `bash scripts/test-server.sh`: all 6 steps passed (fmt, workspace, media, activities, sfu, clippy).
- `npm test` (client): 3 files, 37 tests passed (6 new in `tests/profile.test.ts`, added to the `test` script).
- `npm run build` (client): passed.
- `npx playwright test` (default `chat.spec.ts`): 1 passed.
- `HOUSECALL_TEST_REPORTS=1 npx playwright test`: 1 passed (drops the PNG on the zone, preview visible, report submits, owner downloads byte-exact).
- `HOUSECALL_TEST_SHELL=1 npx playwright test`: 2 passed (existing shell test, plus the new profile test: display name in the user bar and on a new message, avatar image in the user bar and on the message, server rename and icon in the picker).

### Unverified
- No real-device or phone-width visual check; Settings Account and Server use the existing settings layout, which was not screenshotted here.
- Animated GIF avatars are flattened: the client re-encodes to WebP, and the picker accepts PNG, JPEG or WebP only.
- Direct-message conversation names still come from the channel name the server stores, so a DM titled with a username is not changed by display names.
- `scripts/check-public-safe.sh` reports FAIL on two lines in the Phase 1 and Phase 2 sections of this file (lines 33 and 65), not on anything added in Phase 3. I did not edit those lines.
- The reports test writes `evidence/` in the repo root; I left it untracked and did not commit it.

### Deviations from the plan
- Drag-over uses a tonal fill and accent border, not `scale(1.01)`, because the design guidelines forbid movement on controls.
- `Avatar`, not a new component, gained the image and squircle support, because `Avatar` already existed in `kit.tsx`.
- `server/tests/route_inventory.rs` needed no edit: it discovers routes from source, and it passed with the new routes.
- `PATCH /api/me` is declared on the existing `/me` route (`get(me).patch(...)`) to avoid a duplicate path.
- Server rows from other hosts in the picker show initials, not icons: icon fetches use the active host's session, and the id `home` exists on every host, so fetching would show the wrong server's icon.
- The shell profile test signs in as the owner created by the first test in that file (the server is shared across the file), so it does not pass if run alone with `--grep`.
- `resizeImage` is unit-tested through its pure `fitWithin` only: `jsdom` and canvas are not installed. The canvas path is exercised by the shell e2e.
- Attachments on the report form: the hidden file input has no label of its own; the drop zone group carries the "Screenshot" label.
