# Adversarial UX pass (skill: dogfood/adversarial-ux-test)

**What was tested:**
- **Candidate:** the production build of the real client (`App.tsx`, unchanged, with the designed UI). It was served by `vite preview` on :1522 and proxied to the UI fixture API on :3131 (in-memory mock; see `client/src/ui/workbench/fixture-api.mjs`).
- **Browser:** Chromium with Pixel 7 emulation.
- **Script:** `client/src/ui/workbench/adversarial.mjs`.
- **Session logs:** `before/session.json` and `after/session.json`. Screenshots sit next to each log.

**Limits:**
- This is a headless emulation against a fixture backend. It is not a native Android or iOS device test, and it says nothing about the Rust server.
- Signup was a cold start: a new account via an invite link, not a pre-seeded admin.

## Persona

**Rosa Delgado**, 61. Maya's mum, who gets invited for movie nights. Phone only. WhatsApp is the only app she uses. She wears reading glasses and gives up after two dead ends: "If I can't find it, I'll just text Maya."

Her jobs:
1. Get in from the link Christopher sent her.
2. Say she's bringing food.
3. Answer Maya.
4. Delete the message she sent to the wrong chat.
5. Get on the call.
6. Watch the movie with everyone.
7. Complain that she can't hear.
8. Find her way back.

## Rosa's review (in character, abridged)

> "The sign-in screen is pretty, I'll give it that. It told me my password was too short only AFTER I pressed the button. Then I tapped a message to reply and a row of little symbols appeared on top of the message above it. Somehow I had two of those rows open at once. I tried to delete my wrong message and nothing happened. I pressed it again and still nothing. Where's the phone button? Maya's WhatsApp has a phone button. I found the movie thing and there's a form asking me for 'milliseconds'. I'm not doing maths. There's a red Stop button that does nothing and won't say why. And I pasted something into the logs box, pressed send, and you just threw it away without telling me."
>
> Verdict: "Lovely to look at. I'd text Maya."

## Pragmatism filter

| # | Finding | Filter | Action |
|---|---|---|---|
| 1 | **Message actions on touch overlapped.** Tapping a message opened an inline toolbar that overlapped the row above. Several rows could stay open at once, and one rendered squashed. Unsend could not be completed (T4 failed, `before/T4 …-FAILED.png`). | RED: affects every phone user. Unsending is a core requirement. | **Fixed.** On touch devices, tapping a message now opens a bottom sheet with full-width labelled actions. Unsend asks "Unsend for everyone?" before it acts. Desktop keeps the hover toolbar. Retested: T4 passes (`after/t4-action-sheet.png`, `after/t4-confirm.png`). |
| 2 | **No way to reach the call from a chat.** Rosa had to find the drawer, then "Voice and video" (T5). | RED: any competent user expects a call button in the conversation header. | **Fixed.** A call button in the conversation header opens the channel's call. On phones, Search, Pins and Members moved into the drawer to make room. Retested: 1 tap. |
| 3 | **Disabled "Stop activity" gave no reason** for anyone who isn't the host (T6). | RED: a dead-looking control. | **Fixed.** The line "Only the person who started it can stop it." now sits next to the button. |
| 4 | **Control desk opened on phones.** It showed seven raw fields (milliseconds, IDs) by default. | RED on phones; fine for the owner on desktop. | **Fixed.** The desk is collapsed by default on phones and stays open on desktop, where the engineering E2E uses it. The underlying fields are a contract gap (UI-REQUESTS R-6). |
| 5 | **Unconsented logs were dropped without a word.** Logs pasted without the consent tick were silently not sent (T7). | RED: silent data loss, even though the privacy behaviour itself is correct. | **Fixed.** An inline warning appears as soon as there is text without the tick: "Without the tick, these logs stay on this device and are not sent." It does the same for a screenshot. Retested: warning shown before submit. |
| 6 | **Password length was only reported after submit.** | YELLOW: real, but the label already says 12 characters. | **Improved.** The password hint now counts live ("4 more to go." then "Long enough."). Validation itself stays with engineering, per the contract. |
| 7 | **Jargon in contract labels:** "Activity controls", "Capabilities", "Control command", "Giphy picker". | YELLOW: the labels are engineering-owned accessible names that the E2E suite depends on. | Logged as UI-REQUESTS R-3, with proposed wording. |
| 8 | **Join always sends camera and microphone.** There is no audio-only join. | GREEN: a feature request that needs transport work. | UI-REQUESTS R-5. |
| 9 | "Why does it need a password at all, I have a fingerprint." | WHITE / known. | Native passkeys are an engineering gate (`docs/CLIENT.md`). The UI already offers "Add passkey" under Devices. |

## Counts after the fixes (`after/session.json`)

| Task | Taps | Result |
|---|---|---|
| T1 join from invite | 3 | ok (short password rejected with an alert, then the account was created) |
| T2 post in movie-night | 4 | ok |
| T3 reply | 3 | ok |
| T4 unsend | 4 | ok: the first tap only asked; confirming removed the message |
| T5 call | 1 | ok |
| T6 watch party as a guest | 1 | ok: the reason is shown and the desk is collapsed |
| T7 report | 3 | ok: warning shown before submit |
| T8 back to chat | 3 | ok |

No uncaught page errors occurred. The console recorded only expected HTTP failures:
- the deliberate 400 for the too-short password (T1, both runs);
- a 404 from `GET /activity` when no activity existed yet (T6, before run). `useChriscord` treats this as "none".

No tickets were created; none were authorized.
