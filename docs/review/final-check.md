# Housecall final check (2026-11-11)

Scope: `hc-ui` at `abbb902` (shots, tokens, fix log) and the security documents in the `hc-spec` worktree. Read-only apart from this file. About 25 minutes; this is a spot check, not a second full review.

## Verdicts

- **UI: not yet at the bar; usable on the owner's devices tonight, not ready to show publicly.** The default dark scheme is a true neutral black and the layout is simple and coherent on desktop and phone. What holds it back: a hard grey outline on every container, a light scheme that landed in the guideline's banned "slop gray", a live call that is invisible until you join it, and one phone capture that looks broken (finding 1).
- **Security spec: sound default, honest about most limits, two gaps to close before it is built.** All features are off at genesis, no host key exists until the owner signs `features_set`, and no server setting can turn one on. The gaps: the host can attack any member's password offline and the summary words this as a "breach" problem (finding 9), and the owner's key has no compromise story (finding 10).
- **Code: the fix log's claims hold where I checked.** Four fixes checked in the source, all true (list at the end). `scripts/check-public-safe.sh` was refused by the harness again, so `public-safe: OK` is still unseen.

## Findings

1. **[UI] Major, verify first.** `docs/ux/phase-2/2-in-call.png`. The 390x844 in-call capture shows the call dock and composer at the top of the screen, no header, no messages and blank space below. `4-sheet.png` from the same run shows the normal layout, so this may be a capture taken mid-transition. **Fix:** reproduce Join on a phone viewport. If the layout really collapses, it is a blocker. If not, retake the image.

2. **[UI] Major.** `docs/ux/phase-2/2-list-with-live-call.png`, `client/src/ui/shell/ChannelList.tsx:18`. With a call running in `general`, the conversation list shows nothing: the live marker is drawn only for this client's own call. Fix log 8 records this as unfixed. For an app named Housecall this is the main job. **Fix:** the server reports which conversations have a call and who is in it; the list row and the call bar show it before Join. Do not ship to more people until this exists.

3. **[UI] Major.** `client/src/ui/tokens/tokens.css:40`, all `main-*` and `sign-in-*` shots. Fix 14 raised `--hc-line` to 3:1 for field boundaries, and the same token outlines the centre panel, the sign-in card, the message toolbar and the composer. The result is a hard light-grey 1 px outline around every container, which is the guideline's "hairline light border on boxes". **Fix:** split the token. Keep a 3:1 line for inputs only. Containers get their edge from the tonal step between `--hc-bg` and `--hc-surface` (guideline "self-colored borders and tonal elevation").

4. **[UI] Major.** `tokens.css:92-94`, `main-1440-light.png`, `sign-in-390-light.png`. The light scheme (`#dde2e5`, `#eaeef0`, `#f7f9fa`) is the cool UI-kit grey the guidelines ban as "the slop gray". Fix 10 moved from one banned neutral (beige) to the other. The brown ink and brown button on blue-grey paper also read as two palettes. **Fix:** make light the counterpart of the new dark: neutral paper with equal R, G and B, neutral ink, amber only on small live and primary elements. Reshoot.

5. **[UI] Major.** `client/src/ui/tokens/directions/c.css:29-31,74-76`, `main-1440-dark-c.png`. Direction C still has green-tinted dark surfaces (`#0e1411`, `#151d19`, `#202b25`) and pale sage light surfaces. The owner's decision is neutral black with no tinted surfaces. **Fix:** give C the same neutral surfaces as A and keep only its accent, type and radius, or remove C from the switcher.

6. **[UI] Minor.** `main-1440-dark.png`, `-light`, `-b`, `-c`; `client/src/ui/styles/index.css:196,208`. The desktop shots were taken with the pointer over the first message. They show the action toolbar floating above the "Today" label, outside the message it belongs to, and the hover band covering the day label (a side effect of fix 15 moving the label into the message item). **Fix:** keep the day label outside the row's hover area, anchor the toolbar to the top right of the message body, and take the shots with the pointer parked off the list.

7. **[UI] Minor.** `tokens.css:60-61`, fix log 11. In direction A, medium and bold are both 700, so names, titles, "Call", "Join" and tab labels all carry the same weight and the hierarchy is flat. The only typeface is still a Google Fonts face, which the guidelines rule out. Both are recorded as deviations, neither is resolved. **Fix:** owner picks B or C's typeface for the default (both have a real 500), or sources a medium cut for A.

8. **[UI] Minor, grouped.**
   - `docs/ux/phase-2/4-sheet.png`: the pressed People button shows the browser's default sky-blue tap highlight, a colour outside the palette. No `-webkit-tap-highlight-color` rule exists in `index.css`. Set it to transparent and draw a pressed state from the tokens.
   - The same sliders icon means conversation settings in the header and app settings in the user bar. Use two different icons.
   - `sign-in-*.png`: "Set up a new server" is still offered to everyone who signs in (fix 18, partly fixed).
   - `docs/ux/phase-2.md:19`: Watch Now takes 8 taps against a limit of 5. Needs the owner's decision on a Watch entry in the call bar.
   - `design/shots/` has no capture of a call, the sheet, settings, a DM, offline, 844x390 landscape or the new 1100 px breakpoint. Fixes 2, 4 and 13 have no committed image. Add these to `tests/run-shots.mjs`.
   - `docs/review/ui-review.md:5` cites a path in a private home directory. Remove it before the repo is public.

9. **[SPEC] High.** `SUMMARY.md` ("cannot read it", "cannot test guesses at it without its own secret"), `THREAT-MODEL.md` P4 and L2, `PROTOCOL.md` 2.3 and 7.3. The host always holds its own OPAQUE secret and every member's key blob, and the blob is encrypted under the password alone. So the host, the very party "End-to-end encrypted" is a promise about, can guess any member's password offline, with no approval step and no trace. At the review's own estimate (about 10^3 guesses per second per GPU, 10^10 guesses for a score-4 password) that is roughly 115 GPU-days per account, which a motivated host can rent. A success gives `RS`: all history and all future messages, while the victim sees level 4. The threat model admits this under A2b, but the summary files it under "after a server breach". **Fix:** state it in the summary's "What is not protected" list as a hostile-host attack, and in the level-4 detail sheet. Then reduce it: let an account with at least one registered device keep no password-only blob on the server (new devices get `RS` from an approving device), and make that the default for the owner and admins.

10. **[SPEC] High.** `PROTOCOL.md` 3.3 kind 14 and the paragraph after the table, 15.2, 20.3. I found no rule about the owner's key being used on the web client and no recovery from its theft. The owner's `ak_sign` alone signs `features_set`. If the owner signs in once on a hostile host's web page, or loses the password race in finding 9, the attacker holds the owner key. They can turn on every host feature, and they can sign `key_replace` on the owner with a valid `old_proof` and become the owner for good. There is no ownership transfer and no entry that removes an owner, so honest members' only remedy is to abandon the server. Admin keys carry the same risk for `member_add` with full history. **Fix:** (a) the web client must not load owner or admin accounts, and a native client shows a warning factor when an owner or admin has a `platform = web` certificate; (b) write the owner-compromise procedure into 15.6 and the threat model, even if the answer in v1 is "create a new server"; (c) consider requiring a second admin's signature on `features_set`.

11. **[SPEC] Medium.** `SECURITY-LEVELS.md` 1 and 3, `REVIEW.md` resolution 11. "Member on web app" and "Host serves this app" stay at level 3, above "Server sees files" (2) and "Server reads messages" (1). A host that alters the web page reads everything that member can read, text and files, in private channels and DMs too, which no host feature can reach. Three filled segments out of four understates it. The resolution's argument ("levels order what the host reads by design") is about intent; D1 says the bar must never overstate. **Fix:** rank both web factors at level 1, or draw them as their own warning state. Update the fixtures in section 11.

12. **[SPEC] Medium.** `PROTOCOL.md` 15.6. The compromise procedure is thin and partly contradictory. "Turn everything off (one disable entry plus rotation)" cannot be both: a disable sets `host_key: null`, so there is nothing to rotate. On rotation the old key is destroyed, but the stored wraps addressed to it are dropped only on full disable, so anyone who copied the old private key and later gets a database copy still reads every epoch since the feature was turned on. Nothing says how an owner would learn of a compromise or what members are told. **Fix:** define compromise as: disable entry, forced new epoch in every public channel, deletion of all wraps to the old `key_id`, a member notice that says the key may have been copied and from which date content was exposed, then optional re-enable with a new key. Delete old wraps on rotation as well.

13. **[SPEC] Medium.** `SUMMARY.md` level table ("Bot can read: Not the host"), `PROTOCOL.md` 16.1 and 16.3. The bot runner may run on the server machine, and for this project's own bot it normally will. Then the host reads every channel the bot is in, including private channels, while the summary tells the owner it is "not the host". **Fix:** change the wording to "whoever runs the bot, which is often the host". In the detail sheet, say the same and name the bot's operator.

14. **[SPEC] Low.** `PROTOCOL.md` 15.5 `push_text`, `DECISIONS.md` E.9. After the fix to review finding 14, the host forwards the sender's signed ciphertext and the device decrypts it. The host no longer needs class T for any message that fits, yet the feature still wraps T to the host and drops the channel to level 1. That is host access with no purpose. **Fix:** remove the T wrap from `push_text`. Notification text then works at level 4 and stops being a host-assisted feature; oversize messages stay content-free.

15. **[SPEC] Low.** `PROTOCOL.md` 3.5 item 4, `DECISIONS.md` E.10. On a household server, if nobody else opens the app for 24 hours, the one person online sees "Not verified" and cannot send. That will happen most weekends on a server of three people, and it teaches members to ignore level 0. The rule also does not stop the attack it was added for when the removed member colludes (review finding 5, stated). **Fix:** owner decision before build. My recommendation: keep the warning, do not pause sending, and lengthen the window to 7 days.

## Fix-log claims checked in the code

| Fix | Claim | Result |
|---|---|---|
| 3 | An inactive host leaves its call | True: `client/src/adapters/legacy/LegacyHost.tsx:25-27`. No test, as the log says. |
| 5 | `viewport-fit=cover` added | True: `client/index.html:1`. |
| 9 | Roving tabindex and arrow keys in the message list | True: `client/src/ui/chat/MessageList.tsx:16-30`, `Message.tsx:51,104-109`. |
| 23 | "Encrypted in transit" removed | True: no match anywhere under `client/src`. |

## Public repo check

- `README.md:11` and `SECURITY.md:15` say plainly that messages are not end-to-end encrypted today and that no audit has happened. Good.
- `.brief/` is not tracked.
- `scripts/check-public-safe.sh`: refused by the harness. A search with its pattern over tracked, non-hidden files finds only the allow-listed release URL (`client/src-tauri/tauri.conf.json:48`). Hidden paths such as `.github/` were not searched. Run the script once before the repo is made public.

## Not checked

Device behaviour (iOS safe areas, WebKit composer growth), the Tauri shells, the test suites (not re-run), `PROTOCOL.md` outside sections 3.3, 3.5, 15 and 16, `CRACK-PLAN.md`, and `THREAT-MODEL.md` beyond the lines cited.

## Fix log (UI and code items)

Applied on `hc-ui`. Only the [UI] findings were in scope; the [SPEC] findings (9 to 15) were not touched.

| # | Finding | Status | What changed |
|---|---|---|---|
| 1 | In-call phone capture looks broken | **Fixed, was a real bug** | Not a mid-transition capture. After Join on 390x844 the shell was scrolled 658 px up: the off-screen People sheet (`translateY(100%)`, 78% of 844) gave `.hc-shell` scrollable overflow, and a programmatic scroll moved the whole shell, so `.hc-center` sat at y=-658. `.hc-shell` is now `overflow: clip` on phones (`index.css`). `dana.spec.ts` asserts the header is on screen (y >= 0) and the bar sits between header and composer; the new `2-in-call.png` shows the normal layout. |
| 2 | Live call invisible before Join | **Fixed** | Server: `GET /api/voice/rooms` (`server/src/voice.rs`, `Sfu::rooms` in `crates/sfu`) returns user ids per channel, only for channels the caller belongs to, with no peer ids or diagnostics. Client: `CallState.active`, polled every 4 s; `ChannelList` shows the avatars on the row and `CallBar` shows "Call in progress" with names before Join. `voice.spec.ts` now asserts a member who has not joined sees both. |
| 3 | Hard outline on every container | **Fixed, one exception** | Removed the `--hc-line` border from the centre panel, sign-in card, message toolbar, server picker list and emoji/GIF panels; they take their edge from the tonal step (toolbar and picker get a soft shadow). `--hc-line` stays for inputs. Exception: the composer row keeps it, because it is the message input and needs a 3:1 boundary (fix 14). Say if you want it removed too. |
| 4 | Light scheme is the banned slop grey | **Fixed** | Neutral paper `#e6e6e6 / #f1f1f1 / #fbfbfb`, neutral ink `#1a1a1a`, muted `#595959`, line `#6e6e6e`; amber `#8a4a00` only on the accent, live and primary elements. |
| 5 | Direction C tinted surfaces | **Fixed** | C uses the same neutral surfaces and text as A in both schemes; it keeps its terracotta accent, type and radii. |
| 6 | Hover band and toolbar over the day label | **Fixed** | The day label is row 1 of the message grid; the hover band is a `::before` on row 2 only. The toolbar moved into the message body, anchored top right. Shots are taken with the pointer parked; a deliberate hover shot was added. |
| 7 | Flat weight, Google Fonts face | **Not done** | Needs the owner's choice of typeface (B or C, or a medium cut for A). |
| 8 | Minor group | **Partly fixed** | Done: tap highlight set to transparent and a pressed state on icon buttons; the user bar now uses a new `gear` icon, the header keeps the sliders; the private path removed from `ui-review.md`; new shots for settings, DM, offline, 844x390, 1100 px and a hover state. Not done: "Set up a new server" for everyone (needs a product decision), Watch Now at 8 taps (owner's decision on a Watch entry), and a committed image of an in-call desktop view. The in-call and sheet phone shots are in `docs/ux/phase-2`, refreshed by the Dana run. |

Other changes: `npm run test:dana` and `npm run shots` scripts in `client/package.json`.

### Test results (run on this tree, after the last change)

| Command | Result |
|---|---|
| `npm run build` (client) | passes (tsc and vite) |
| `npm test` (client) | 2 files, 26 tests passed |
| `npm run e2e` (client, chat suite) | 1 passed |
| `HOUSECALL_TEST_VOICE=1 npm run e2e` | 1 passed, including the new live-call assertion |
| `npm run test:dana` | 1 passed (phone run, header and layout assertions) |
| `npm run shots` | 1 passed, refreshed `design/shots` |
| `cargo test --workspace` | all suites passed (51, 16, 4, 1, 1, 1 tests; 1 ignored) |

Not run: the Plex, load, upload-video, native-push, shell and reports e2e suites, and `scripts/check-public-safe.sh`. The test server uses the prebuilt `target/debug/housecall-server`, so rebuild it before running the e2e suites after server changes (`cargo build -p housecall-server`).
