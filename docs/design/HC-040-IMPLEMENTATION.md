# HC-040 implementation handoff

For the implementer (Sol medium) and the correctness reviewer (Sol high). `docs/design/HC-040.md` is the spec; this file says what is left, where it is, and how to tell it is done. Build what the spec says. Make no visual decisions; where the spec is silent, use its nearest pattern and say so in your receipt.

## 1. Ground rules

- CSS: paste from `design/040/css/NN-*.css` (the spec's CSS blocks are copies). Skip lines marked `mock-only`. Delete the 0.3.0 rules a block replaces.
- Copy: every string goes in `client/src/ui/copy.ts` under the key the spec gives. Strings marked L in section 10.5, and every quoted string in 11.12, are security-contract text: do not reword, shorten or merge them.
- Security behaviour is fixed by `docs/security/LINK-V1.md` and `DM-V1.md` (paper-reviewed in `REVIEW-0.4.0.md`). If a screen here seems to need a protocol change, stop and ask.
- No new dependencies beyond the ones the contracts name (`qrcode-generator`, `jsqr`, `tauri-plugin-biometric`). No decoration that the spec does not draw.
- Each flow has one primary action per screen. Do not add helper text; if a screen needs explaining, the layout is wrong.
- Motion is transform and opacity only. Content is visible without animation; reduced motion changes states in place.
- Existing test ids, routes, keyboard behaviour and every current nav, settings, Apps, chat, call and phone surface stay.

## 2. Where things are

| Work | Spec | CSS | Mockup (`design/040/`) |
|---|---|---|---|
| Sidebar channel model, voice sheet | 3 | `03-sidebar.css` | `sidebar.html` |
| LIVE mark, stream preview | 4 | `04-live.css` | `live-preview.html` |
| Voice stage | 5, 18.1 items 1-4, 6, 12, 13, 18.2 | `05-stage.css` | `voice-stage.html` |
| Call card, call strip | 6 | `06-callcard.css` | `call-card.html` |
| User bar, profile, person card | 7 | `07-profile.css` | `profile.html` |
| Message actions | 8 | `08-message-actions.css` | `message-actions.html` |
| Snap camera, QR scanner | 9 | `09-camera.css` | `snap-camera.html` |
| QR login (reconciled) | 10 | `10-qr.css` | `qr-login.html`, `qr-login-new.html`, `link.html` + `link.js` |
| Encryption surfaces (reconciled) | 11, 11.12 | `11-encryption.css` | `encryption.html`, `recovery-key.html` |
| How security works | 12 | `12-security.css` | `security.html` |
| Splash, shell entrance | 13 | `13-splash.css` | `splash.html` |
| Motion, sounds | 14 | `14-motion.css` | `sounds.html` |
| Icons | 15 | | `icons.html`, `icons.js` |
| Empty, loading, error | 16 | `16-states.css` | `states.html` |
| Create server, first run, Apps | 17 | `17-setup.css` | `setup.html` |

Open a mockup from disk with `?s=<state>`; its states are in `<meta name="hc-states">`. Pictures: `design/040/shots/<file>[-state]-<1280|390>-<dark|light>.png`.

## 3. Corrections to the current UI implementation

Source references are `hc-040-ui/client/src/ui/`, read at closeout; line numbers drift, selectors do not. Full before and after: spec 18.1. "Pictured" means a real-app screenshot exists (`after-voice-*`, `after-fixes-*`); "not pictured" means capture it when done.

| # | Fix | Source | Done when |
|---|---|---|---|
| 1 | Voice stage, wide: tiles sized by `stageGrid()` (18.2), not `auto-fit` | `call/CallStage.tsx`; `.hc-stage__grid` `styles/index.css:228`, `.hc-tile` `:235` | 1280 x 800, two people, side chat open: each tile is at least 540 px wide; four people: 2 x 2; one: at most 640 px. No tile overflows; resize reflows without animation |
| 2 | Voice stage, phone: tiles fill the height, no aspect ratio | same, in `@media (max-width: 47.5em)`; `05-stage.css` | 390 x 844, two people: tiles reach from the header to the bar with 8 px gaps; three: two columns, last spans both; nine: the grid scrolls, rows at least 8.5rem |
| 3 | Stage bar replaces the call bar on the stage | `chat/CallBar.tsx:50-80`; `.hc-callbar*` `:354-369` | Centred bar that hugs its buttons; Leave is 60 x 44 solid `--hc-danger`; no avatars and no accent text in the bar; header meta reads "2 inside · 0:05" in muted ink. `CallBar` remains only as the idle Call row of a DM |
| 4 | Phone stage bar: no Share screen; Camera off is not pressed | `CallBar.tsx` | Under 47.5em there are four buttons. Camera off: crossed icon, no `is-active`. Camera on: `is-lit`. Mute and deafen: `is-active` |
| 5 | LIVE on the stage | `CallStage.tsx` | While someone shares: their tile shows `.hc-livepill`, a separate `hc-tile--stream` exists and enters with `.is-entering`; "Watch stream" arrives with that tile focused |
| 6 | Tile caption and speaking edge | `.hc-tile figcaption` `:244`, `.hc-tile::after` `:242-243` | Caption chip is stage colour at 80%, `--hc-text-sm`. Speaking edge is `--hc-live`, animates opacity only (no `border-color` transition) |
| 7 | Person card | new `people/PersonCard.tsx`; CSS already at `:1160-1169`; rows in `shell/ChannelList.tsx` (`.hc-vrow__open`), People rows, tile names | Click a person row: popover beside it, 280 px, clamped 8 px inside the window. Phone: `.hc-sheet`. Volume and "Mute for me" only for someone in your call. Your own card: "Edit profile", no actions. Escape and outside click close; focus returns to the row. Not pictured |
| 8 | Reconnecting | `CallStage.tsx`, `shell/CallDock.tsx`, `.hc-signal[data-busy]` | Drop the network mid-call: header meta "Reconnecting", tiles stay, bars seek, line two "Reconnecting" muted, mute choice kept, no toast, nothing shifts. Recovery restores the head count. Failure: shut door, "Couldn't join Lounge", primary "Try again". Not pictured |
| 9 | Long-press, phone | `shell/ChannelList.tsx` | A 450 ms press on a person row with LIVE opens the stream preview sheet; 8 px of movement or `pointercancel` cancels; the following click is swallowed; a short tap still opens the person card; `contextmenu` does the same with a mouse. Not pictured |
| 10 | Live and join row motion | `ChannelList.tsx`; `03-sidebar.css`, `14-motion.css` | A person joining: their row fades and rises 4 px once; other rows do not animate. LIVE mark fades in. Reduced motion: in place. Leaving: unmount at once. Not pictured |
| 11 | Message actions, phone | `chat/Message.tsx:85`; `.hc-msg__bar` `:271-277`; `08-message-actions.css` | Tap a message at 390: a fixed tray over the composer with six labelled buttons; no message moves by a pixel (compare before and after screenshots); tap another message: the tray stays; tap elsewhere: it closes |
| 12 | Splash | new `brand/Splash.tsx`; remove `Launch` (`onboarding/Onboarding.tsx:39,64`) and `.hc-launch*` (`:608-612`); `13-splash.css` | Ready in under 300 ms: no mark, shell enters. Slower: rise, door, then the mark flies to the picker logo and exactly one mark is on screen at every frame. Phone opening in a conversation: fade. Reduced motion: whole mark, fade, no flight. Once per launch. Frames to match: `splash-t200` to `splash-t1180`. Not pictured |
| 13 | Dead rule | `.hc-composer__row` `:394` | The `border: thin solid var(--hc-line)` declaration is gone; the lip at `:854` is the only edge |

Order: 1 to 4 first (they are one screen), then 11, 12, 7, 5, 6, 8, 9, 10, 13.

## 4. New flows: action, input, states

One primary action and the fewest inputs each. Every state below must exist; "recovery" is how the person gets out of a failure without help.

### 4.1 QR login, showing device (spec 10.2; `qr-login.html`). Native only

| State | Primary action | Input | Recovery |
|---|---|---|---|
| Hidden (decoy, blurred) | "Show my QR code" | none | |
| Starting | busy button | | start failed: `ErrorLine`, same button |
| Shown, 60 s | none (other device acts) | none | at 0: Hidden; "Hide now" |
| Claimed (`approve`) | typing the second digit | one two-digit field | "Deny"; expiry ring |
| Verify (`verify`) | "Log in Pixel 9" (desktop), OS unlock (phone) | password on desktop only | wrong password: inline, retry; OS prompt cancelled: "Unlock to log in Pixel 9"; "Deny" |
| Approved | "Done" | | |
| Mismatch, tag failed, used twice, expired | "Make a new code" | | one press starts a fresh link |

Reviewer must fail the build if any of these is true (LINK-V1 section 16): the number appears anywhere on this device; an Approve or Yes button sits with the number field; a second attempt is possible after a wrong number; `claim_tag` is checked after the prompt renders; `approve` is sent before verification resolves or after a cancelled OS prompt; the code stays sharp past 60 s; the web build can reach this screen.

### 4.2 QR login, new device (spec 10.3; `qr-login-new.html`, `snap-camera.html?s=scan`)

| State | Primary action | Input | Recovery |
|---|---|---|---|
| Explainer | "Scan QR code" | none | "Use a password instead" |
| No camera or refused | "Log in with a password" | | |
| Scan | none (camera) | | wrong code: inline 3 s, keeps scanning; close |
| Server (`confirm`) | "Continue" | none | "Cancel" |
| Browser notice (`browser`, web only) | "Continue" | none | "Cancel" |
| Number (`number`) | none (waiting) | none | "Cancel" |
| Success | none, 600 ms | | |
| Ended (seven causes, 10.3) | "Scan again" | | "Use a password instead" |

Reviewer checks: nothing is sent before "Continue"; the username first appears with the number; no digits other than the number on that screen; `housecall://link-scan` opens the scanner and carries nothing; every `housecall://link?…` is refused; after the web route loads, `location.href` has no `#link=`.

### 4.3 The `/link` page (spec 10.6; `link.html`, `link.js`)

Ship as `link/index.html` and `link/link.js`. Primary "Open in Housecall" is the fixed `href="housecall://link-scan"`. `link.js` removes the fragment from the address bar before anything else. Malformed or missing code: one heading, one line, no buttons. Reviewer: the app link never contains the code; no inline script; no request is made.

### 4.4 Encryption surfaces (spec 11 and 11.12; `encryption.html`, `recovery-key.html`)

| Flow | Primary action | Input | Waiting, error, recovery |
|---|---|---|---|
| Key changed banner | "Compare safety numbers" (text button: "I understand") | none | composer disabled until acknowledged; waiting messages shown as one line |
| Key problem (`rollback`) | "Compare safety numbers" only | none | clears by itself; no way to accept |
| Locked on this device | "Use another device" | none | "Enter recovery key" |
| Recovery words at sign-up | "I've written them down" | none | "Copy the words" |
| Check two words | "Finish" | two words | wrong word inline; "Show the words again" picks two new positions |
| Enter recovery key | "Unlock my DMs" | one textarea, live count | three distinct errors (11.6); text kept; "Use another device instead" |
| View recovery key | "Show key" | password | wrong password inline; replaced elsewhere: 11.12 row 15 |
| Replace (`replace`) | "Replace" | password | "Cancel" |
| Reset (`reset`) | "Reset security key" | then password | "Cancel", which has initial focus |
| Get your security key (first 0.4.0 launch) | "Scan a QR code from a device where you're logged in" | none | "Enter recovery key"; "I can't do either" |

Reviewer checks: the lock icon and "End-to-end encrypted" appear only for label rule 3; every `enc = 0` row in a locked DM carries "Not encrypted"; the web client never shows words, never creates, resets or replaces a key, and shows the browser notice before the words field.

## 5. Evidence

- Rendered during closeout at 1280 x 800 and 390 x 844, dark and light; only the representative subset listed in `.sprint/takeover-design.md` was visually inspected (not every variant): `qr-login` (new states `verify`, `mismatch`; `approve` redrawn), `qr-login-new` (new `browser`; `confirm`, `number`, `expired`, `denied` redrawn), `link`, `encryption` (new `rollback`; `changed` redrawn), `recovery-key` (new `replace`; `reset` redrawn). Command: `node design/040/shoot.mjs qr-login link.html encryption recovery-key`.
- Not re-rendered: every other mockup. Their pictures are the earlier committed ones (sections 1 to 17).
- `snap-camera.html` was not changed. Its `wrong` state still shows the old words "That isn't a Housecall login code"; the spec string (10.5, `camera.scanWrong`) is the contract's.
- Real-app pictures (`after-voice-*`, `after-fixes-*`) show the app before the corrections in section 3. There is no real-app picture of any section 4 flow: none is built yet.

## 6. Decisions for Christopher

None of these blocks the work above; each has a default that is already in the spec.

1. **Stage header buttons.** The real stage header keeps search, pins and channel settings; spec 5.1 removes them. Default: keep them (existing navigation). Remove only if you say so.
2. **"Not end-to-end encrypted" on every channel.** DM-V1 14.1 asks for this label on channels and voice channels as well as group DMs. The spec now follows it. My view: on channels it is noise, since "How security works" already says it. Changing it means changing DM-V1 14.1, which is the security owner's call.
3. **"Locked on this device".** DM-V1 14.1 has no label for "the account has keys, this device does not". The spec uses "Locked on this device" (the browser says "Locked in this browser", which is DM-V1's). Confirm, or supply the contract's wording.
4. **Desktop verify button.** LINK-V1 gives no label for the password step. The spec uses "Log in Pixel 9" and "Unlock to log in Pixel 9". Confirm these do not count as the forbidden "Approve button next to the field" (they are on a later step, after the number has matched).
5. **`/link` wording.** LINK-V1 section 2 quotes "To log in to the Housecall app, open it and scan this code again from there." and section 10 gives the button caption "Then scan this code again from inside the app." The page uses the caption only, to avoid saying it twice. Say if both are required.
6. **Timers not in the contract.** The approve prompt shows the seconds left before the 120 s window closes, and "View recovery key" hides after 60 s. Both are stricter than the contract, not looser. Remove either if unwanted.
7. **Elapsed call time.** Moved from the bar to the header ("2 inside · 0:05"). Say if you would rather drop it.
