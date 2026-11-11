# Phase 2 UX receipt: the Dana tasks at 390x844

Run with `node tests/run-dana.mjs` (in `client`), which starts the test server with voice and the synthetic Plex fixture and drives `tests/e2e/dana.spec.ts`. **Dana is a scripted client, not a person.** It measures taps and what is on screen. It does not replace a session with a real first-time user. Screenshots and the raw table are in `docs/ux/phase-2/`.

Rule (PLAN): more than 5 taps for any task is RED.

| Task | Taps | Verdict |
|---|---|---|
| Join from the invite link | 1 | ok |
| Find the live call and join it | 2 | ok by taps, **fails "find"** (below) |
| Send a GIF | 2 | ok |
| Start Watch Now | 8 | **RED** |
| Message the friend | 5 | ok |

Typing is not counted as a tap.

## Findings

1. **RED: Start Watch Now takes 8 taps.** People sheet, Chords tab, Gimme, Start Watch, Browse library, library, Watch Now, then close the sheet. Not fixed in this pass: shortening it is a flow redesign (for example a Watch entry on the call bar), which the fix brief excludes. Needs an owner decision.
2. **Dana cannot see that a call is live before joining it.** On the list, the channel shows no "In call" group, and the call bar reads "Call / Join" with no people. The current SFU reports the roster only to a session already in the call (`docs/design/HANDOFF.md`). She joins blind. This waits for the LiveKit adapter.
3. The invite screen offers only "Join" and "Sign in". No server, key or port question appears (the "Set up a new server" link is not offered with an invite token).
4. After joining, the phone starts on the conversation list, one tap from the channel.

Not tested here: a real person, a real phone, real network conditions.
