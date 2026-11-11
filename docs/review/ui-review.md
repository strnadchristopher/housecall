# Housecall UI review (branch `hc-ui`, `4e990a8..063e284`)

**Verdict: ship after fixes.** Fix findings 1 and 2 before any deploy. Fix 3 to 9 before a native or iOS build goes out.

Reviewed against `~/.hermes/plans/housecall/brief-ui.md`, `.brief/UIDesignGuidelines.md`, `.brief/PLAN.md` (1, 3.4, 4.3, 4.4, 0.8, 0.9, Phase 2) and `.brief/DECISIONS-1111.md`. "Reviewer capture" means a screenshot I took with a temporary Playwright script against the real test server (`tests/start-server.mjs`, fictional users `owner` and `mara`). Those images are in `client/test-results/review-shots/`, which git ignores, so they are not committed.

## Findings

1. **Blocker.** `docs/CLEANUP-HANDOFF.md:37`. The public-safe pattern fails at HEAD: this line names a fixture username and a hostname that both match the script's personal-name and personal-host patterns. `HANDOFF.md:54` says the check was never run. **Fix:** remove or reword the line, then run `scripts/check-public-safe.sh` until it prints `public-safe: OK`.

2. **Blocker.** `client/src/ui/shell/AppShell.tsx:45` with `client/src/ui/styles/index.css:314`. Reviewer captures `phone-call-elsewhere-390-{dark,light}.png`. On a phone, the call dock lives in `.hc-left`, which is hidden on the conversation screen. Steps: join a call in `general`, go back, open `garden`. Result: no dock, no mute, no leave and no sign that the microphone is live. The call bar shows an idle "Call / Join" (measured: `phoneDockVisibleElsewhere=false`). PLAN 3.4 puts the mobile dock "above the tab area" so it is always visible. **Fix:** on phones, render the dock (or a compact in-call strip with mute and leave) outside `.hc-left`, above the composer or the safe-area bottom, whenever `call.phase !== "idle"`. In the call bar of another channel, show "In call in #general", not a bare Join.

3. **Major.** `client/src/adapters/legacy/LegacyHost.tsx:23`. An inactive host returns `null`, which unmounts its `CallStage` (remote audio elements) and `CallDock`. Its `VoiceSession` keeps publishing the microphone. So on Tauri, switching servers in the picker during a call leaves you transmitting with no visible control, and you stop hearing the call. **Fix:** keep the active call's stage and dock mounted at app level whatever the active host is, or leave the call (after a confirm) when switching hosts. Add a test.

4. **Major.** `client/src/ui/tokens/motion.ts:17`, `client/src/ui/styles/index.css:104-110,308`. Reviewer capture `landscape-844x390-dark.png`. Every width above 760 px gets the three-column desktop layout (288 + 304 px fixed columns). On an iPhone in landscape (`Info.plist` enables it) and on iPad portrait, the center column is about 230 to 250 px wide. The composer placeholder wraps, the message area is about 150 px tall, and targets drop to 32 px. The wide layout has no safe-area padding, so the notch covers the left column in landscape. **Fix:** add an intermediate breakpoint that drops the right column into the sheet below roughly 1100 px. Apply safe-area insets in all layouts, or lock phones to portrait.

5. **Major.** `client/index.html:1`. The viewport meta lacks `viewport-fit=cover`, so every `env(safe-area-inset-*)` in `index.css:299,311-320,343` resolves to 0 on iOS. The brief's "safe-area insets respected" requirement is unmet, and `HANDOFF.md:33` says it was never measured. **Fix:** add `viewport-fit=cover`, then verify on an iPhone with a notch and home indicator (top bar, composer, sheet, dock).

6. **Major.** `client/src-tauri/icons/*` is unchanged on this branch. The desktop, Android and iOS icons are still the old obelisk studio artwork. Brief rule 7 bans studio artwork, and PLAN 0.9 requires app icons from the new identity. **Fix:** generate the icon set from `client/src/ui/brand/logo.svg` (`npx tauri icon`, which is not a bundle build) and commit only `icons/`.

7. **Major.** `client/tests/e2e/plex.spec.ts`, `reports.spec.ts`, `upload-video.spec.ts`, `native-push.spec.ts` still drive the deleted UI (`screen-login`, "Voice and video", "Activity controls", "Password (at least 12 characters)"). CI's `node tests/run-plex.mjs` will fail, and the reports, Plex and upload-to-message flows now have no end-to-end coverage. Separately, `client/playwright.config.ts:9-10` makes `HOUSECALL_TEST_SHELL=1` also run `shots.spec.ts`, which rewrites eight tracked PNGs under `design/shots/` on every acceptance run. **Fix:** port the four specs to the new selectors (helpers already exist), and give the screenshot run its own env flag.

8. **Major.** Missing or false deliverables:
   - `docs/ux/phase-2.md` (Dana test, brief step 11) does not exist. "Find the live call and join it" cannot pass today, because the roster is visible only after Join (`HANDOFF.md:26`).
   - `docs/design/SCREENS.md` and `COMPONENTS.md` (PLAN 0.9, brief rule 1) do not exist.
   - `docs/design/SURFACES.md:13,15,16,42-50` names files that do not exist (`onboarding/SignIn.tsx`, `JoinServer.tsx`, `CreateAccount.tsx`, `settings/Invites.tsx`, `Reports.tsx`, `Channels.tsx`, `Roles.tsx`, `Notifications.tsx`, `Devices.tsx`, `About.tsx`, `ReportProblem.tsx`), yet line 131 says "Every file named in the new home column exists."
   - `HANDOFF.md:30` says the test server takes the email fallback, but `server/src/lib.rs:614-646` always returns `link` and needs no email.

   **Fix:** run and record the Dana test at 390x844. Write SCREENS.md (including states: empty, loading, error, offline, call elsewhere) and COMPONENTS.md. Correct SURFACES.md and HANDOFF.md to the real file layout and behaviour.

9. **Major.** `client/src/ui/styles/index.css:198-203`, `chat/Message.tsx:84-91`. Every message's hidden action toolbar (Reply, React, Pin, Edit, Unsend) is in the Tab order. Measured: from the channel button to the composer took 22 Tab presses with three messages, 14 of them inside message toolbars. A real channel makes the composer unreachable by keyboard. **Fix:** use a roving tabindex. The message row is one tab stop, arrow keys move between messages, and Tab or Enter enters that message's toolbar. Also add a skip-to-composer shortcut.

10. **Major.** `client/src/ui/tokens/tokens.css:86-96`. Screenshots `main-1440-light.png`, `list-390-light.png`, `invite-390-light.png`. The default light scheme is beige and peach throughout (`#e8d3c4` page, `#f3e3d7` surfaces, `#fcf1e7` raised). This is the "cream / beige editorial background" the guidelines ban. Calling it "fired clay" in `design/directions/README.md:12` does not change what renders. **Fix:** choose a light base that is not in the cream, beige or oat family. For example, take the warmth from the ink and accent rather than the paper. Re-shoot the light set.

11. **Major.** `client/src/ui/tokens/tokens.css:9-29`. The default direction's only typeface, Inria Sans, is on Google Fonts. The guidelines say the identity "cannot rest on anything off the Google shelf". The two alternates (Martian Grotesk, Apfel Grotezk) do not have this problem. Also, `--hc-weight-medium` equals `--hc-weight-bold` (700), so the scale has two weights, not three. **Fix:** either pick a non-Google OFL face for A, or record this as a known deviation for the owner's direction pick and present B or C as compliant alternatives.

12. **Minor.** `client/src/adapters/legacy/chat.ts:144-146`. Reviewer capture `dm-1440-dark.png`. A DM's People tab lists only you and people who have posted. A new DM with `mara` showed only `owner`. **Fix:** take members from the channel's member list (`/api/channels` or the DM's `member_ids`), not from message authors.

13. **Minor.** `client/src/adapters/legacy/call.ts:78,91`, `chat/CallBar.tsx:24-29`. Join in another channel calls `voice.join`, which `close()`s the current call without the server `DELETE` (`transport/voice.ts:105-106`) and without asking, so a stale peer can linger. Deafen mutes playback but leaves the microphone open. **Fix:** route Join-elsewhere through `leave()` first, behind a one-tap "Switch call" confirm. Make deafen also mute the microphone and restore it on undeafen.

14. **Minor.** `client/src/ui/styles/index.css:247`. The composer textarea sets `outline: 0`. Its only focus cue is a 1 px border change on the row, unlike the 2 px `--hc-focus` ring used everywhere else. Input borders (`--hc-line` on `--hc-surface`) measure 1.38:1 to 1.54:1 in every direction, below the 3:1 non-text contrast for field boundaries. All text pairs pass 4.5:1 (lowest: a-light muted on bg, 5.07). **Fix:** use the standard focus ring on the composer row (`:focus-within`). Raise `--hc-line` to at least 3:1 against `--hc-surface`, or give fields a tonal fill that reaches 3:1.

15. **Minor.** Accessibility semantics:
    - `side/RightPanel.tsx:24-34`: the tablist has no arrow-key handling, no `aria-controls`, and its tabpanel is unlabelled.
    - `chat/EmojiPicker.tsx:11-14`: declared `role="listbox"` with options that have no keyboard model, no focus on open and no Escape to close.
    - `shell/ServerPicker.tsx:83`: `Logo label=""` renders `role="img"` with an empty name.
    - `shell/AppShell.tsx:64`: the right column is labelled "People" even on the Chords tab.
    - `chat/MessageList.tsx:33`: `role="separator"` on an `<li>` inside `<ol>`.

    **Fix:** implement the WAI-ARIA tabs pattern, make the emoji grid plain buttons with focus management, use `aria-hidden` on decorative marks, label the aside generically, and move the day divider out of the list semantics.

16. **Minor.** User-facing strings outside `copy.ts`, against brief rule 3:
    - `adapters/legacy/hosts.ts:56,62,66`, `identity.ts:45,102-103`, `chat.ts:317,327,335`.
    - Raw server values rendered as text: `settings/sections.tsx:187` (`report.status`), `:205` (capability ids), `chords/browser/SharedBrowserPanel.tsx:26-27` (`browser.phase`, `resetOutcome`).

    **Fix:** adapters return error codes that the UI maps through `copy.ts`. Map every server enum to a copy label.

17. **Minor.** `client/src/ui/settings/sections.tsx:199-211`. Reviewer capture `settings-about-1440-light.png`. "About" dumps 18 internal flags to every member, including "Passkeys: Available" (removed by plan) and "Gimme dry run: Available". This goes against D6 (simplicity). **Fix:** show only member-facing features (Calls, File uploads, GIF search, Watch, DJ, Shared browser), owners only, or drop the section.

18. **Minor.** `client/src/ui/onboarding/Onboarding.tsx:30-31`, `copy.ts:17`. Screenshots `invite-390-*.png`, `sign-in-*.png`. "Set up a new server" appears on the sign-in and invite screens for every visitor, including Dana arriving from an invite link (D6: never ask about servers in the normal path). Separately, the same offline state reads "Reconnecting" in the picker and center (`ServerPicker.tsx:86`, `AppShell.tsx:52`) but "Offline" in the user bar (`UserBar.tsx:15`). Reviewer capture `offline-1440-dark.png`. **Fix:** hide setup unless the server reports it is unclaimed, and never show it with an invite token. Use one offline label.

19. **Minor.** Dead code left from the old UI:
    - `transport/passkeys.ts:90-125` (`registerPasskey`, `authenticatePasskey`) and the `@simplewebauthn/browser` dependency (`package.json:17`), kept only by `tests/native-auth.test.ts`.
    - `ui/tokens/motion.ts:4-14` (`reducedMotion`, `duration`, never called).

    **Fix:** delete them with their tests, keeping only `cancelNativePasskey` if the Android bridge still needs it.

20. **Minor.** `client/src/adapters/legacy/identity.ts:109-123`, `settings/sections.tsx:47-52,68,78`, `core/identity.ts:51`, `tests/e2e/helpers.ts:27-32`. The `needsEmail`, email field and `sentTo` path can no longer trigger against this server (finding 8), and email invites are removed by plan (PLAN 1). **Fix:** remove the path and its copy, and assert `link` directly in the helper.

21. **Minor.** `client/src/ui/side/RightPanel.tsx:24-34`, `side/ChordsTab.tsx:14`. The Chords tab is drawn and selectable when no Chord is configured, and leads to an empty pane (the shell spec asserts zero buttons). `SharedBrowserPanel.tsx:29` shows "Check reset" even when `vm_reset` is false. Both are dead controls under brief rule 1. **Fix:** hide the tab when `chords.chords` is empty, and gate Check reset on the capability.

22. **Minor.** `client/src/ui/settings/sections.tsx:104`, `dm/FriendList.tsx:15`, `sections.tsx:120`. `c.run` swallows failures, so `.then(...)` still navigates away or clears the form after a failed create-channel, start-DM or create-role, and the error appears on a different screen. Separately, switching channels clears messages (`hooks/useHousecall.ts:221`) and shows an empty list with no loading state. **Fix:** have the store methods resolve to a success flag and act only on success. Show a loading state (label, not sentence) until the first page arrives.

23. **Minor.** `client/src/ui/chat/CallBar.tsx:41`, `copy.ts:43`. "Encrypted in transit" sits under every live call as a descriptive subtitle (copy rule 3). It is also a security statement made before the D1 security-level design exists. The current SFU decrypts media, and a reader can take this for end-to-end protection. **Fix:** remove it. Security wording arrives with the D1 bar.

24. **Minor.** `client/src/ui/kit.tsx:66-71` with Inria Sans. All screenshots. The avatar initial "O" renders as a narrow oval that reads as the digit zero ("0 owner"). This was noted in `HANDOFF.md:62` and left unfixed. **Fix:** set avatar initials in a face or cut whose O is clearly round (or widen the initial's tracking box), and check every letter A to Z against the digits.

25. **Minor.** `client/src/ui/styles/index.css:247`. Composer growth depends on `field-sizing: content` alone. Support in the WebKit engines behind the iOS and Linux shells (WKWebView, WebKitGTK) is not established, and the only check was Chromium. Where the property is missing, the one-row textarea will not grow, so multi-line drafts scroll inside a single line. Not verified on device. **Fix:** add a small auto-resize fallback (set `rows` or `height` from `scrollHeight` on input), or verify on the minimum iOS and on WebKitGTK and record the result.

## What I ran

All commands were run from the `hc-ui` worktree root on 2026-11-11. Disk before cargo: 18G free on `/`.

| Command | Result |
|---|---|
| `npm run build --prefix client` | exit 0 (Vite chunk-size warning for `plex` 600 kB and `index` 408 kB) |
| `npm test --prefix client` | 3 files, 35 tests passed |
| `cargo build -p housecall-server` | finished (so the e2e fixture runs current server code) |
| `npm run e2e --prefix client` | chat spec: 1 passed |
| `HOUSECALL_TEST_VOICE=1 npm run e2e --prefix client` | voice spec: 1 passed |
| `HOUSECALL_TEST_SHELL=1 npm run e2e --prefix client -- tests/e2e/shell.spec.ts` | shell spec: 1 passed (shots spec deliberately not run; it rewrites tracked files) |
| `HOUSECALL_TEST_PLEX=1 npm run e2e --prefix client` | **blocked**: the harness required approval and I could not grant it. Finding 7 rests on the selectors in the spec. |
| `scripts/check-public-safe.sh` | **blocked** the same way. I ran its exact `git grep` pattern and exclusions directly. Result: one hit after the script's allow-list (finding 1). |
| `wc -l client/src/App.tsx` | 23 |
| `grep -rn -i together client/src/ui` | no output |
| Temporary Playwright review script (deleted after use) at 1440x900, 390x844 and 844x390, dark and light, plus reduced motion | Captures named above. Phone touch targets on the list, conversation and settings screens: none under 44 px. Reduced motion: picker and phone stack transitions are 0s. Measured values are quoted in findings 2, 9 and 12. |
| Token contrast computed for directions A, B and C, dark and light | All text pairs at or above 4.5:1. Field borders 1.38:1 to 1.54:1 (finding 14). |

Not verified: the Tauri desktop, Android and iOS shells (no bundle builds, per D4); upload to message with a scanner; Gimme, DJ and shared-browser panels with live integrations; Add Server across two hosts.

## Fix log

Commits (short hashes): A `dc46a79`, B `f881f3e`, C `5c7e185`, D `891311e`, E `c5b7705`, F `b8f3bce`, G `30c65f2`.

| # | Result |
|---|---|
| 1 | Fixed (A). Stale line reworded. The Grep tool with the script's pattern finds only the allow-listed upstream URL. `scripts/check-public-safe.sh` itself was refused by the harness, so I did not see `public-safe: OK` printed. Run it once. |
| 2 | Fixed (B). In another conversation the call bar reads "In call in <name>" with mute, deafen, camera, share and leave; on a phone in settings the dock is shown in the pane. Shell spec checks it at 390x844. |
| 3 | Fixed (B), without a test. An inactive host now leaves its call, so the microphone never runs with no controls. There is no confirm. No React-level test harness exists and the web e2e has one host. |
| 4 | Fixed (B). New 1100 px breakpoint: the right column is a sheet; safe-area padding now on `.hc-root` for all layouts. Not checked on a device or re-captured at 844x390. |
| 5 | Fixed (B): `viewport-fit=cover`. Not verified on an iPhone. |
| 6 | Fixed (D). Icons regenerated from the logo. I also committed the tracked platform icon images under `src-tauri/gen/android` and `gen/apple`, which the review did not list; no config changed. |
| 7 | Fixed (E, plus runner in G). All four specs ported; screenshot run has its own flag (`HOUSECALL_TEST_SHOTS`, `tests/run-shots.mjs`). Plex and native-push pass. Reports and upload-video are ported but **not run**: no ClamAV socket here. |
| 8 | Partly fixed (F). Written: `docs/ux/phase-2.md` (scripted Dana run, not a person), `SCREENS.md`, `COMPONENTS.md`; `SURFACES.md` and `HANDOFF.md` corrected. The Dana run finds: Watch Now takes 8 taps (RED) and a live call is not visible before joining. Neither is fixed (flow redesign / needs the LiveKit adapter). |
| 9 | Fixed (B). Roving tabindex, arrows, Enter/Escape for the toolbar, skip link. Chat spec asserts it. |
| 10 | Fixed (B). Light scheme is cool grey with warm ink; screenshots refreshed (G). |
| 11 | Not fixed, recorded as a known deviation in `design/directions/README.md` for the owner's direction pick (a non-Google face cannot be sourced here). |
| 12 | Not fixed. `/api/channels` returns no member list, so it needs a server change. |
| 13 | Fixed (B). Join elsewhere asks "Switch call" and leaves properly first; deafen closes and restores the microphone. |
| 14 | Fixed (B). Composer focus ring; `--hc-line` at least 3:1 against surface and raised in all directions (computed). |
| 15 | Fixed (B, C). Tabs pattern, emoji group with focus and Escape, decorative logo hidden, aside labelled "Details", day label moved into the message item. |
| 16 | Partly fixed (C). Server enums (browser phase, reset outcome, report status, capability ids) map through `copy.ts`. Adapter error strings are still in the adapters (larger refactor). |
| 17 | Fixed (C). About lists six member-facing features. |
| 18 | Partly fixed (C). No setup link with an invite token; one "Reconnecting" label. Hiding setup otherwise needs the server to report it is unclaimed, which it does not. |
| 19 | Fixed (C). Passkey flows, their test and the dependency removed; `cancelNativePasskey` kept. `reducedMotion`/`duration` removed (B). |
| 20 | Fixed (C). Email path removed; helper asserts the link. |
| 21 | Fixed (B). Chords tab hidden when empty; Check reset gated on `vm_reset`. |
| 22 | Fixed (C). `attempt` returns success; forms act only on success; "Loading" label while a conversation opens. |
| 23 | Fixed (B). Subtitle removed. |
| 24 | Fixed (F). Initials use Apfel Grotezk (round O); glyph sheet checked A to Z against 0 to 9. |
| 25 | Fixed (B). Script fallback when `field-sizing` is missing. Not verified on WebKit. |

### Test results (2026-11-11, from `client`)

| Command | Result |
|---|---|
| `npm run build` | exit 0 (chunk-size warning only) |
| `npm test` | 2 files, 26 tests passed (the passkey test file was removed with finding 19) |
| `npm run e2e` | chat: 1 passed |
| `HOUSECALL_TEST_SHELL=1 npm run e2e` | shell: 1 passed |
| `HOUSECALL_TEST_VOICE=1 npm run e2e` | voice: 1 passed |
| `npm run test:plex` | plex: 1 passed |
| `HOUSECALL_TEST_NATIVE_PUSH=1 npm run e2e` | native-push: 1 passed |
| `node tests/run-dana.mjs` | 1 passed (results in `docs/ux/phase-2.md`) |
| `node tests/run-shots.mjs` | 1 passed; 14 images in `design/shots/` refreshed |
| `HOUSECALL_TEST_REPORTS=1` / `HOUSECALL_TEST_UPLOAD_VIDEO=1` | not run: need a ClamAV socket (`.runtime/scan/clamd.sock`), absent |
| `scripts/check-public-safe.sh` | not run (refused); Grep with its pattern: only the allow-listed upstream URL |
