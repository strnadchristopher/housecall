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
- `scripts/test-server.sh` could not be marked executable here (`chmod` and `git update-index --chmod` needed approval), so CI and docs call `bash scripts/test-server.sh`. The release owner can run `chmod +x` and `git update-index --chmod=+x scripts/test-server.sh` and switch back to the bare path if wanted.
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
- Real-device and visual checks of the lightbox and layout were not done (the release owner's job).
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

## Phase 4

Call stage in the center, chat in the right column (tasks 4.1 to 4.4).

### Commits
- `e7134ea` feat(call): full call stage with chat in the side panel
- (this handoff) docs: phase 4 handoff. It also rewords two earlier lines of this file that named a person, so `scripts/check-public-safe.sh` passes.

### What changed
- `ui/shell/nav.ts`: `SideTab`, `sideTabs(inCall, chordsConfigured)`, and `isStaged(call, currentId, main)`.
- `AppShell`: when staged (live or connecting call, looking at the call's own conversation, not in Settings) the center is header, `<CallStage full />`, error line and `<CallBar />`. MessageList and Composer are not rendered there. An effect selects the Chat tab on entering the stage and falls back from Chat to People once the call is over. Otherwise the layout is unchanged, and `<CallStage />` (no picture) still keeps remote audio mounted while another channel or Settings is open.
- `RightPanel`: tabs come from `sideTabs`; new `side/ChatTab.tsx` renders `MessageList compact` and `Composer compact`.
- `CallStage` and `Tile`: one tile per participant, joined to `call.media` by `participantId`. A tile shows the live picture or a large `Avatar`, the name (with "(you)"), a muted or deafened glyph on your own tile, a 2px accent ring while speaking, and a button covering the tile that pins it. A pinned tile (or yours while you share your screen) takes the center and the rest sit in a strip. Layout is `repeat(auto-fit, minmax(min(100%, 18rem), 1fr))` with 16:9 tiles.
- Every remote stream is still a `<video data-testid="remote-media">`, hidden when it has no picture. Your own camera preview is `data-testid="local-media"`, so the remote-media count is unchanged.
- Speaking: `VoiceSession.levels()` samples `getStats` audio levels at 4 Hz (inbound-rtp by track id to peer id, plus the local media-source while the mic is open) and notifies only on change. `core/call.ts` has `SPEAKING_LEVEL` and `isSpeaking`; `CallState` gains `speaking: string[]` and `localVideo`.
- A remote picture counts as live while video frames keep arriving (4 s), so a peer who switches the camera off shows their avatar even if the track never reports `mute`.
- Narrow widths (sheet layout): the CallBar has a Chat button with a mentions count that opens the right column on the Chat tab.
- UI guidelines applied (also in the commit body): bare icons with no box; a plain 2px tonal ring with no glow or pulse; nothing moves on hover; content visible by default; flat tonal avatars; no em dashes; the name label is a solid surface so its text clears the video.

### Tests run (real results)
- `npm run build` (in `client`): passed.
- `npm test` (in `client`): 3 files, 40 tests passed (includes the new `sideTabs`, `isStaged` and `isSpeaking` cases).
- `HOUSECALL_TEST_VOICE=1 npx playwright test`: 4 passed, 0 failed (the original three-browser RTP test, the new "call stage owns center", the new phone-width stage test, and the saved-device warning test).
- `HOUSECALL_TEST_SHELL=1 npx playwright test`: 2 passed, 0 failed.
- `npx playwright test` (default, chat.spec.ts): 1 passed.
- `bash scripts/check-public-safe.sh`: OK.
- I also read a Chromium screenshot of the two-person stage (light theme) and it matched the intended layout. It is not committed.

### Unverified
- Real devices, real microphones for the speaking ring (tests only use Chromium's fake beep), the dark theme on the stage, and the iOS layout. These are the release owner's checks.
- `npm run shots` was not run, so the screenshot set has no call stage yet.
- Tauri builds were not run.

### Deviations from the plan
- The stage owns the center only while you look at the call's own conversation, not whenever `nav.main === "chat"`. If you open another channel during a call you get that channel with the "In call in ..." bar, and the call dock reopens the call. Otherwise you could not read any other channel while in a call. Because of this, the Chat tab always shows the selected conversation, which is the call's, so `ChatTab` needs no `chat.open(call.conversationId)` call (the plan's fallback) and I added none.
- Screen share is not given the full width for remote sharers: the SFU carries one video transceiver per peer and swaps its track, so a receiver cannot tell a screen from a camera. You can pin any tile to spotlight it. Your own tile is spotlighted automatically while you share.
- Mute and deafen glyphs show on your own tile only: the backend reports no per-participant mute state.
- The composer test id in this codebase is `screen-composer`, not `composer`, so the new E2E uses that.
- `shell.spec.ts` now clicks the People tab before counting people, since a call opens the right column on Chat. It also asserts that Chat is the selected tab.
- Added a phone-width E2E (390 px) beyond the plan: stage is the main screen, the CallBar Chat button opens the sheet on the Chat tab.
- Not done, per the brief: no extra guard for a call whose conversation is not the selected one (skipped as an unlikely race, see above).

## Phase 5

### Commits
- `b0d9324` feat(ui): enter/exit motion for menus, sheets and settings (tasks 5.1 to 5.4)
- `7d1b2fb` feat(profile): animated GIF avatars and server icons (task 5.5)
- the handoff commit that adds this section

### What changed
- `Presence` (`ui/kit.tsx`) keeps children mounted for 190 ms (`--hc-dur-base`) after `show` turns false. The exiting copy is `inert` and `pointer-events: none`, so it never blocks a click underneath. Under reduced motion it unmounts at once. The timing lives in `afterExit` (`ui/tokens/motion.ts`) so it can be unit tested.
- CSS (`styles/index.css`): `.hc-anim-slide-right`, `.hc-anim-pop`, `.hc-anim-fade`, enter plus exit keyframes, opacity and transform only, inside `prefers-reduced-motion: no-preference`. Existing `--hc-dur-*` and `--hc-ease-*` tokens were reused, so no new tokens.
- Applied to: the settings layer (`AppShell.tsx`; settings is now an overlay layer over the center, so the chat can mount underneath while it slides out), the sheet scrim, the emoji picker (composer and message reactions), the GIF picker, the unsend confirm, and the lightbox.
- Already animated before this phase and left alone: the right sheet and the server picker list (both transform/opacity transitions).
- Picker focus: `EmojiPicker` now returns focus to its opener only if focus is lost or still inside the picker when it unmounts. Without this, the 190 ms exit would pull focus off the composer after an emoji is picked.
- Task 5.5: server `image_blob.rs` validates GIFs separately (at most 2 MB, logical screen 1 to 1024 on each side, else `ApiError`). Other types keep 512 KB. The body limit on `/me/avatar` and `/servers/{id}/icon` is now `MAX_GIF_BYTES + 1`. Client: `prepareImage` returns a GIF (detected by `GIF8` magic bytes) unchanged after a 2 MB check, and resizes everything else. The avatar picker accepts GIF and its hint and type error mention GIF (new `copy.profile.pictureHint` and `pictureType`, and a `typeError` prop on `MediaDropzone`).
- `Avatar` already rendered an `<img>` with `object-fit: cover` (`.hc-avatar img`), so nothing changed there.
- UI guidelines applied (also in the commit body): content visible by default (the animation runs on the element, nothing is gated on it), only opacity and transform animate, no new shadows or hover movement, motion off under reduced motion, nothing delays a click.

### Tests run (real results)
- `npm run build` (in `client`): passed.
- `npm test` (in `client`): 4 files, 47 tests passed (new: 3 in `tests/motion.test.ts`, 4 `prepareImage` cases in `tests/profile.test.ts`). `motion.test.ts` was added to the `test` script.
- `HOUSECALL_TEST_SHELL=1 npx playwright test`: 3 passed, 0 failed (the shell test, the profile test now with the GIF avatar step, and the new reduced-motion test).
- `npx playwright test` (default, chat.spec.ts): 1 passed.
- `cargo test -p housecall-server --test profile`: 13 passed, 0 failed (includes the 1.5 MB GIF avatar and icon upload, and a 2 MB + 1 GIF rejected with 413).
- `cargo test -p housecall-server --lib image_blob`: 7 passed, 0 failed.
- `bash scripts/test-server.sh`: all 6 steps passed (fmt, workspace, media, activities, sfu, clippy).
- `bash scripts/check-public-safe.sh`: OK.

### Unverified
- How the motion looks and feels on real devices, and the sheet and scrim on a phone. It was only checked through Playwright, which does not judge smoothness.
- Animated playback in every place an avatar shows (message, People, call tile, server picker). Those all use the one `Avatar` component, but the E2E only loads the GIF in the user bar.
- The wizard step transitions and the snap viewer in plan task 5.3: those screens do not exist yet (Phases 6 and 7). They should wrap their steps and viewer in `Presence` with `hc-anim-fade` or `hc-anim-slide-right`.

### Deviations from the plan
- `Presence` has no `requestAnimationFrame` and no separate `state`. `data-state` comes straight from `show`, so a re-shown element never flashes its exit animation. The default is 190 ms rather than 180 to match `--hc-dur-base`.
- The `Presence` wrapper is a `display: contents` div that is also `inert` while exiting, a small addition to the plan's version.
- The unit test covers `afterExit` (fake timers: still there at 189 ms, gone at 190 ms, immediate under reduced motion, cancelled if it returns) rather than rendering `Presence`, because the client has no DOM test environment (no jsdom) and I did not add a dependency. The E2E covers the real component.
- There is no separate DeviceMenu animation. It is a settings pane, not a popup, so it rides on the settings slide. The plan's "message context menu" is the message action bar, which is not a popup, so the reaction picker and unsend confirm got the pop instead.
- The GIF E2E generates the GIF with ffmpeg piped to stdout, so no file is written. It checks the avatar response through `waitForResponse` (type `image/gif`, identical bytes), then `naturalWidth > 0` on the user-bar image.
- Per the brief, GIF avatars are not paused under reduced motion and there is no still-frame fallback.
- Skipped as unlikely or hypothetical: re-entering a settings layer that is mid-exit with a different section, and a Lightbox Escape listener lingering for the 190 ms exit.

## Phase 6

Integration setup: server creation wizard and Settings > Integrations, one shared component (tasks 6.1 to 6.6).

### Commits
- `df7f207` feat(setup): owner-only `/api/setup/status` with names and booleans only (6.1)
- `4f2b810` test(setup): assert anonymous 401 and member 403 for `/api/setup/status`
- `c1397f2` feat(setup): copyable integration steps checked against `.env.example` (6.2)
- `3a5314d` feat(setup): server creation wizard and Settings > Integrations (6.3 to 6.6)
- the handoff commit that adds this section

### What changed
- `server/src/setup.rs`: `GET /api/setup/status`, owner only (403 for members, 401 without a session). Returns `{"integrations":[{id, ready, missing?}]}` for calls, media, scanner, transcode, dj, gimme, plex, giphy and vm. `missing` holds env var names (and the text `compose profile: vm`); no value is ever read into the response. It is in the route inventory automatically (the inventory parses `.route(` in `src/`).
- `.env.example`: added `DJ_ENABLED=false` (compose already reads it) and a commented `HOUSECALL_FFMPEG=/usr/bin/ffmpeg`, so the cards only name documented variables.
- `client/src/ui/setup/steps.ts`: title, one-line why and ordered steps (with copy snippets) for all nine cards.
- `client/src/ui/setup/IntegrationSetup.tsx`: the one component. Cards with Ready (bare check) or Needs setup, the missing names, steps with Copy, and Check again (one refetch). One line says readiness is the same for every server on the host. The calls card has a Test microphone and camera button: mic level meter and camera preview through `acquireMedia` with the saved devices; tracks and the AudioContext stop on Stop test and on unmount. Members see "Ask the server owner to set this up." and send no request.
- `client/src/ui/setup/CreateServerWizard.tsx`: five steps (name and icon, channels, calls, extras, invite) as `Presence` slides, step dots, Back and Next. Step 1 does `POST /api/servers` then `PUT .../icon` (icon failure keeps the server and shows a message). Step 2 creates the optional Voice lounge and Music channels once each. Steps 3 and 4 are `IntegrationSetup` filtered to the calls card and to dj, gimme, plex, giphy, vm and transcode. Step 5 creates a 7 day invite and shows it with Copy. Escape after step 1 asks to confirm; leaving keeps the server.
- `ServerPicker`: owners get a Create server row. Settings: new Integrations section, shown to everyone in the server group (members get the ask-owner text).
- `ChatStore.createServer(name, icon?)` and `IdentityProvider.loadSetupStatus()` in `core/` and `adapters/legacy/`. `createServer` makes the new server current, so later channel and invite calls apply to it.
- UI guidelines applied (also in the commit body): say less, state as words plus a bare check (no chip, no icon tile), tonal cards with no shadow or glow or hover movement, step dots instead of a rail, content visible by default, clear the cut (stage padding for focus rings), no em dashes, every control clicked with a real pointer in the spec. I viewed one screenshot of the calls step (light theme) and fixed the faint card tone and an 8 px misalignment against it.

### Tests run (real results)
- `npm run build` (in `client`): passed.
- `npm test` (in `client`): 5 files, 50 tests passed (new: `tests/setup-steps.test.ts`, 3 tests: every `{code}` variable exists in `../.env.example`, no secret-looking values, cards match the server's ids).
- `HOUSECALL_TEST_SETUP=1 npx playwright test`: 1 passed, 0 failed (new `setup.spec.ts`: full five-step wizard with a GIF icon and `waitForResponse` on the icon PUT; Escape confirm; device test with the fake camera and mic; Check again via `waitForResponse`; all nine cards in Settings; a member sees the ask-owner text and sends no status request; the new server shows its icon in the picker).
- `HOUSECALL_TEST_SHELL=1 npx playwright test`: 3 passed on four of the last six runs. Two runs failed 2 of 3 (see "Test environment" below); the same code passed on re-run.
- `npx playwright test` (default chat.spec.ts): 1 passed.
- `cargo test -p housecall-server --test setup --test route_inventory --config 'profile.dev.package.housecall-server.opt-level=1'`: 2 passed, 0 failed (`setup.rs` sets `GIMME_AGENT_API_KEY=sentinel-xyz` plus Plex and Giphy sentinels and asserts none appear in the body; 401 anonymous, 403 member, 200 owner, ids and keys exact).
- `cargo test --locked --workspace --config 'profile.dev.package.housecall-server.opt-level=1'`: all suites passed, 0 failed (59 + 1 + 2 + 13 + 1 + 16 + 1 + 4 tests in the main binaries; the others report 0).
- `cargo clippy --workspace --all-targets --config '...opt-level=1' -- -D warnings`: clean.
- `cargo fmt --all --check` (first step of `bash scripts/test-server.sh`): passed.
- `bash scripts/check-public-safe.sh`: OK.

### Test environment problem (please read)
- `bash scripts/test-server.sh` **failed at "workspace tests"** in my session: `setup::status_is_owner_only_and_never_returns_config_values` got 404. This is not the code. `target` is a symlink into a sibling worktree's target directory, and a library with the same crate name and workspace-relative path was already built there without the new route. Cargo then reports `housecall-server` as Fresh even after I edit the source, and links that stale library (the e2e server binary at `target/debug/housecall-server` has the same problem, which is likely what failed two shell spec runs).
- I worked around it with `--config 'profile.dev.package.housecall-server.opt-level=1'`, which gives only that crate its own artifact hash and rebuilds it from this worktree's source. All results above that mention it used that flag. The media, activities and sfu steps of the script were not run separately, because I did not touch those crates.
- The release owner should run `bash scripts/test-server.sh` from a target directory that does not share artifacts with another worktree, or rebuild `housecall-server` first.

### Unverified
- The wizard and cards on a real phone and in the dark theme; only a desktop light-theme screenshot of the calls step was viewed.
- Passing steps against a real SFU: the test host has no call port, so the calls card is only seen in its "Needs setup" state. The Ready state is covered only by the server test of the JSON shape, not by a browser run.
- Mic meter movement with a real voice (the fake device is a tone, and the spec only checks that the meter and a decoded camera frame appear).
- Gimme under Compose can never read Ready: `compose.yaml` pins `GIMME_DRY_RUN` to `"true"` on purpose (SETUP.md says production calls are not authorised). The Gimme card says so and gives the standalone settings instead of changing the compose file.
- The `docker compose up -d app` and `docker compose --profile vm up -d` commands in the steps were not run. The service name `app` comes from `compose.yaml`.

### Deviations from the plan
- `/api/setup/status` has no `detail` text (the field is accepted by the client type but the server never sets it) because nothing real to report was available without reading config values. The `transcode` row names `HOUSECALL_MEDIA_KEY` when uploads are off, and `dj` names `SFU_PUBLIC_IP` or `HOUSECALL_MEDIA_KEY` when its prerequisites are off.
- There was no existing one-shot "create server" form to replace, and the picker's Add Server row is for connecting another host (native builds only). The wizard is opened from a new owner-only Create server row.
- Steps in the wizard use one `Presence` per step in a shared grid cell, so the leaving step slides out in place.
- Integrations are listed for members too (with the ask-owner text), so the plan's non-owner case is reachable from the UI.
- Fixed an existing bug that the new picker row exposed: pressing ArrowDown on the closed trigger opened the list and the container handler then moved the index again (hidden before because the list had one row).
- Skipped as unlikely or hypothetical: a second wizard opened while the first is mid-exit, and Escape while the Create server request is in flight.
