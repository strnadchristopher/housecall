# Adversarial UX re-run after UI part 2 (onboarding, invites, access requests, pending)

Persona, tasks and setup as in [the baseline](adversarial-mobile-baseline.md) and
[part 1](adversarial-mobile-after-part1.md): Linda, 61, iPhone, texts and Facebook only, local `housecall-server` + Vite,
synthetic accounts, 390×844, touch, dark scheme. New this run: her sister **Rosa** has no link at all and has to
sign up, ask the owner to let her in, wait, and log in.
Driver: `client/tests/e2e/linda.spec.ts`, run with `node tests/run-linda.mjs mobile-after-part2/linda`.
Raw log and screens: [`mobile-after-part2/linda/`](mobile-after-part2/linda/result.md). No console errors.

| Task | Taps | Verdict |
|---|---|---|
| Join from the invite link | 1 (Join) | ok |
| Find the main chat and post | 2 | ok |
| Come back next day and post | 3 (password is the only thing typed) | ok |
| Change the colour | 2 | ok |
| Invite her sister (member) | 2, reaches "Invite people" with who to ask | ok |
| Leave settings | 2, lands in the chat | ok |
| Rosa: ask to join without a code | 4 (Sign up, Continue, Request access, Send request) | ok |
| Rosa: log in once approved | 2 (Log in, Log in); the status re-checks when she comes back to the app | ok |

## Rant (in character, short)

"The first screen has a big lit door, fine, and two buttons that say what they do. My link took me straight to
'Join Housecall' and asked for a username and a password. That's it. Next morning it already knew I was linda.
I wanted to get Rosa in and it told me Christopher does the inviting and gave me a button to text him. Rosa didn't
have a code; she typed the address, pressed Request access and it said the owner has it and she can close the app.
When she came back it said Approved and let her in with her password. I'd have liked fewer words about 'servers'."

## Pragmatism filter

| # | Finding | Filter | Status |
|---|---|---|---|
| 8 | "Display name" on Join vs "Username" elsewhere (baseline) | RED | **Fixed.** "Username" everywhere in onboarding |
| 9 | Join doesn't say what she's joining (baseline) | RED | **Fixed.** "Join {server name}" with the host underneath, from the server's public info |
| 10 | Password again the next day (baseline) | RED | **Fixed on native** (core lane, Keychain/Keystore). Web stays memory-only by decision; Log in now remembers her and asks only for the password |
| 12 | Members can't invite and aren't told why (baseline, unplanned) | RED | **Fixed (smallest).** Members get Settings → *server* → Invite people: "Invites to {server} come from its owner, {name}. Ask them for an invite code to pass on." plus **Message {name}**, which opens a direct conversation (e2e-tested) |
| 13 | Pending screen didn't say what happens next; Rosa would sit there | RED | **Fixed.** One line: the owner has it, you can close the app, it checks again when you come back. It now re-checks on returning to the app, not only every 30 s |
| 14 | "Message owner" button looked dimmed (it borrowed the chat's global busy flag) | RED | **Fixed.** Own busy state |
| 15 | Buttons looked dim after a tap on phones (sticky `:hover` on touch) | RED | **Fixed.** Hover tints only under `(hover: hover)`; `:active` gives the press feedback |
| 16 | Disabled Continue on Sign up / the server door read as broken | YELLOW | **Fixed.** Always enabled; an empty field explains what to paste |
| 17 | Access requests icon read as a bell | minor | **Fixed.** A closed doorway with a knob |
| 18 | Wide settings: "Appearance" truncated beside "Lavender" | minor | **Fixed.** Current-value details are phone-only |
| 19 | The word "server" ("Set up a new server", "Server address") | WHITE | Needed for the person who runs it; Linda never has to touch either path |
| 20 | Request flow is 4 + 2 taps across two sessions | WHITE | Each tap is a decision (sign up, where, ask, send; then log in, log in). Nothing to remove without losing the password step |

No material finding is open for this part. Device-only questions (keyboard over the actions on iPhone, the
`housecall://` link from Notes, cold relaunch through the Keychain) stay with Maya and the emulator.
