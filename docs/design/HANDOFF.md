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
- `HOUSECALL_TEST_SHELL=1` now also starts the SFU in `tests/start-server.mjs` and selects `shell.spec.ts`. The screenshot run has its own flag, `HOUSECALL_TEST_SHOTS=1` (it rewrites tracked PNGs in `design/shots/`).
- `Composer.tsx`: the hidden file input is `aria-hidden` (it repeated the button's accessible name).
- `styles/index.css`: `.hc-people span` also matched the avatar and pushed its initial to the top; now excludes `.hc-avatar`.
- `docs/design/SURFACES.md`: end-check result appended.
- `design/shots/`: 14 images (see below).

## Gaps

- **Who is in a call is visible only after you join it.** The current SFU reports the roster only to a session in the call (`adapters/legacy/call.ts`). The channel avatars and the call bar count therefore appear after Join. Showing them to everyone waits for the LiveKit adapter.
- **GIF** is tested with the capability flag and the three provider routes answered by Playwright; no real Giphy key or network was used.
- **Uploads** are tested only to the "held" state (no virus scanner in the fixture). The attach-to-message path after a scan is not covered here.
- **Shared browser controls** that were rendered disabled in the old UI (start video, request control, reset) are not rendered (no backend).
- **Invite `link` field**: the server always returns `link` and needs no email (`server/src/lib.rs`, invite creation). The UI renders `link`; the email path and its copy were removed after the review, and the e2e helper asserts the link directly. (An earlier version of this note said the test server took an email fallback; that was wrong.)
- **Add Server and multiple hosts** (Tauri) are implemented but not exercised; the tests run the web build only.
- **Dana persona**: run as a script at 390x844 after the review; see `docs/ux/phase-2.md`. It is a scripted client, not a person.
- **Touch-target size** (44 px) was measured by the reviewer (none under 44 px on the phone screens). Safe-area insets now apply (`viewport-fit=cover`, padding on `.hc-root`) but were not checked on a device with a notch.

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

Regenerate with `HOUSECALL_TEST_SHOTS=1 npm run e2e --prefix client` (not `HOUSECALL_TEST_SHELL`). Avatar initials now use `--hc-font-initial` (Apfel Grotezk in A), whose O is round; Inria Sans's O read as a zero.

## To check by hand

- Run `scripts/check-public-safe.sh`.
- Join a real call from two devices and look at the call stage tiles, dock and device menu on a phone.
- Add Server with an address and with an invite link in the desktop build.
- Settings sections and Chord panels with a configured Gimme, DJ and shared browser.
- Safe-area insets and 44 px targets on an iPhone.

## Neutral black dark scheme

Owner decision (overrides the earlier warm charcoal): direction A dark is a neutral black. Light mode is unchanged. Directions B (neutral ink) and C (green-black) have no warm or brown dark ground, so they are unchanged.

| Token | Old | New |
| --- | --- | --- |
| `--hc-bg` | `#171311` | `#0c0c0c` |
| `--hc-surface` | `#1f1a17` | `#151515` |
| `--hc-surface-raised` | `#2b2420` | `#212121` |
| `--hc-line` | `#786d64` | `#787878` |
| `--hc-text` | `#f3ebe1` | `#ededed` |
| `--hc-text-muted` | `#b3a597` | `#a6a6a6` |

Accent, on-accent, live, danger and focus are unchanged. The accent is no longer mixed into any surface: avatar faces, the mention row, `@me` chip and own reactions now step in lightness from `--hc-text`. The mention row keeps a 2px solid accent rail on its left edge.

Computed WCAG contrast:

| Pair | bg | surface | raised |
| --- | --- | --- | --- |
| text | 16.71 | 15.60 | 13.75 |
| text-muted | 8.04 | 7.50 | 6.61 |
| line | 4.43 | 4.14 | 3.65 |

Also: `--hc-on-accent` on `--hc-accent` 8.74; `--hc-danger` on surface 7.43. The app icon source (`src-tauri/icons/housecall.svg`) and `logo.svg` use the new ground and ink; icons were regenerated with `tauri icon`. `index.html` has no theme-color, there is no web manifest, `tauri.conf.json` sets no window background, and the iOS launch screen uses the system background colour, so nothing else repeated the brown.
