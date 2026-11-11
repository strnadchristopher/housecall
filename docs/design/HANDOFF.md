# Housecall UI handoff

Branch `hc-ui`. Implementation finish after the designer's stop; identity, tokens, typefaces, motion and component structure unchanged.

## What works (checked by the tests below)

- First-admin setup, sign in, accept invite (phone and desktop widths).
- Channel chat: send, edit, reply, pin, react, unsend, search, pins, mentions with notifications, direct messages, device revoke.
- Server picker: Up, Down, Home, End, type-ahead, Escape, focus returns to the trigger, a second click during the animation reverses it, `transition-duration` is 0s under reduced motion, no "Add Server" row on the web build.
- Composer: attach (upload chip), emoji, GIF (GIF tested against locally answered routes, see Gaps), send.
- Call: Join, live count and duration, avatars under the channel name, call dock, Leave. Three browsers exchange audio and video through the current SFU (voice spec).
- Right column People and Chords tabs; the Chords tab is empty when nothing is configured.
- Phone: one column with stack navigation; list, conversation and the people sheet.

## Changes in this session

- `client/tests/e2e/shell.spec.ts` (new), `shots.spec.ts` (new, evidence run), `helpers.ts`, `chat.spec.ts`, `voice.spec.ts` finished against the new UI.
- `HOUSECALL_TEST_SHELL=1` now also starts the SFU in `tests/start-server.mjs` and selects `shell.spec.ts` and `shots.spec.ts` in `playwright.config.ts`.
- `Composer.tsx`: the hidden file input is `aria-hidden` (it repeated the button's accessible name).
- `styles/index.css`: `.hc-people span` also matched the avatar and pushed its initial to the top; now excludes `.hc-avatar`.
- `docs/design/SURFACES.md`: end-check result appended.
- `design/shots/`: 14 images (see below).

## Gaps

- **Who is in a call is visible only after you join it.** The current SFU reports the roster only to a session in the call (`adapters/legacy/call.ts`). The channel avatars and the call bar count therefore appear after Join. Showing them to everyone waits for the LiveKit adapter.
- **GIF** is tested with the capability flag and the three provider routes answered by Playwright; no real Giphy key or network was used.
- **Uploads** are tested only to the "held" state (no virus scanner in the fixture). The attach-to-message path after a scan is not covered here.
- **Shared browser controls** that were rendered disabled in the old UI (start video, request control, reset) are not rendered (no backend).
- **Invite `link` field**: the UI renders `link` when the server returns it and falls back to the email form otherwise. The test server still takes the fallback path, so the `link`-present path ran only through the helper's `#invite=` check on the returned URL, not against a server that omits the email.
- **Add Server and multiple hosts** (Tauri) are implemented but not exercised; the tests run the web build only.
- **Adversarial UX test (Dana persona, `docs/ux/phase-2.md`) was not run.** Not in this session's brief; nothing is recorded as tested.
- **Touch-target size** (44 px) and safe-area insets were not measured; only reviewed in screenshots.

## New dependencies

None.

## Switching directions

`?direction=b` or `?direction=c` in the URL, remembered in localStorage; `?direction=a` returns to the default. A review aid only; no UI.

## Commands run and results

| Command | Result |
|---|---|
| `npm run build --prefix client` | exit 0 (chunk size warning only) |
| `npm test --prefix client` | 3 files, 35 tests passed |
| `npm run e2e --prefix client` | 1 passed (chat spec) |
| `HOUSECALL_TEST_VOICE=1 npm run e2e --prefix client` | 1 passed (voice spec) |
| `HOUSECALL_TEST_SHELL=1 npm run e2e --prefix client` | 2 passed (shell spec, screenshot run) |
| `wc -l client/src/App.tsx` | 23 |
| `grep -rn -i "together" client/src/ui` | no output |
| `scripts/check-public-safe.sh` | **not run**: the harness refused to execute it without approval. I ran the same pattern with the Grep tool over `client/src/` and `client/tests/`: 0 matches. `docs/` and `design/` were not searched. Run the script once yourself. |

Cargo was not used, so the disk guard did not apply.

## Screenshots (`design/shots/`, fictional people and messages)

`main-1440-{dark,light}.png`, `main-390-{dark,light}.png`, `list-390-{dark,light}.png`, `sign-in-{1440,390}-{dark,light}.png`, `invite-390-{dark,light}.png`, `main-1440-dark-b.png`, `main-1440-dark-c.png`. Regenerate with `HOUSECALL_TEST_SHELL=1 npm run e2e --prefix client`. Settings, call stage with tiles and the server picker open are not in the set.

Seen while checking them: in direction A the owner avatar's "O" is narrow enough to read as a zero; B and C render it as a letter. Not changed.

## To check by hand

- Run `scripts/check-public-safe.sh`.
- Join a real call from two devices and look at the call stage tiles, dock and device menu on a phone.
- Add Server with an address and with an invite link in the desktop build.
- Settings sections and Chord panels with a configured Gimme, DJ and shared browser.
- Safe-area insets and 44 px targets on an iPhone.
