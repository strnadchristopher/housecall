# Adversarial UX baseline: phone, before the mobile work

Plan Task 0.4. Candidate: the unmodified `bc7e751` client served by Vite against a local `housecall-server`
(fixture database, synthetic accounts `owner` and `linda` only). Viewport 390×844, touch, dark scheme.
Driven by `client/tests/e2e/linda.spec.ts`; re-run with `node tests/run-linda.mjs <out-dir>` from `client/`.
Raw run log: [`mobile-baseline/result.md`](mobile-baseline/result.md). No console errors during the run.

**Persona.** Linda, 61, Alex's aunt. iPhone, texts and Facebook only. She was texted an invite link and
wants to say hi in the family chat, and will give up if she sees a word she doesn't know.

**Tasks tried.** Open the invite link and create an account, find the main chat and post, come back the next day
and post again, change the colour, invite her sister.

## Linda's review (in character)

> Overall: maybe, if my nephew sits next to me.
>
> The good: once I was in the chat, typing hi and pressing the arrow worked, and the letters are big enough.
>
> The bad: after I joined, it showed me a black page that says "Conversations" and the word "general" in a grey box.
> Is that a button? A heading? There's no arrow, nothing says tap me. I tapped it because it was the only thing there.
> The next day it asked for my **Username**. I never made a username, it asked me for a **Display name**! Then it
> dumped me on that same list again instead of the family chat. The little sliders at the top right turned out to be
> settings, and settings is a row of loose words that wrap like a sentence; I couldn't tell which one I was on.
> There's no way to change the colour. I wanted to send my sister the link and there's nothing for that at all.
> And when I pressed the back arrow in settings it didn't take me back to my chat, it took me to that list.
>
> Verdict: "It works once you know where everything is, and I don't."

Screenshots: [1 invite link](mobile-baseline/1-invite-link.png), [2 first screen](mobile-baseline/2-first-screen.png),
[3 general](mobile-baseline/3-general.png), [4 posted](mobile-baseline/4-posted.png),
[5 next day](mobile-baseline/5-next-day.png), [6 after sign-in](mobile-baseline/6-after-sign-in.png),
[7 settings](mobile-baseline/7-settings.png), [8 settings, whole page](mobile-baseline/8-settings-full.png),
[9 no invite](mobile-baseline/9-no-invite.png), [10 after leaving settings](mobile-baseline/10-after-settings.png).

## Filtered findings (pragmatism layer applied)

Severity: **material** = any user would hit it (RED), **minor** = real but narrow (YELLOW), **noise** = persona only (WHITE).

| # | Finding | Evidence | Severity | Fixed by |
|---|---|---|---|---|
| 1 | After joining and after every sign-in the app opens on the "Conversations" list, not in a chat. One extra tap every time, and the list itself is the confusing screen. | 2, 6 | material | Task 6.3 (open on `main`) + `refresh()` prefers the server's general chat |
| 2 | Conversation rows don't look tappable: a row is plain text with no chevron; only the current row gets a fill. | 2 | material | Task 6.4 (row background, 52 px, chevron) |
| 3 | The top-left arrow in a chat goes "back" to a list that isn't a previous screen; the list is really a menu. | 4 | material | Tasks 6.2/6.3 (hamburger + slide-out drawer) |
| 4 | Settings on a phone is a wrapping row of loose words above the pane, with no clear current item and no grouping beyond one "Server" label. | 7, 8 | material | Tasks 7.2–7.4 (iOS-style tree) |
| 5 | Leaving settings lands on the list, not the chat she opened it from. | 10 | material | Task 7.4 (phone back from root returns to the chat) |
| 6 | No way to choose a colour; the whole app carries an amber tint. | 7, 8 | material (the owner's direct request) | Phase 1 + Task 7.5 |
| 7 | On an iPhone the root pads by `env(safe-area-inset-*)`, so the page background shows as a flat band under the status bar instead of the header running behind it. Measured: `.hc-root` padding comes from `env()`; Playwright reports 0 because it has no notch. | code, 4 | material | Phase 2 |
| 8 | Join asks for a **Display name**, but the value becomes the login name and Sign in asks for **Username** the next day. | 1, 5 | material | Task 5.4 (label "Username"; part 2) |
| 9 | Join shows no server name or host: "Join" with nothing about what she is joining. | 1 | material | Task 5.4 ("Join {host}"; part 2) |
| 10 | Next day she must type username and password again. | 5 | material | Addendum A Phase K (Keychain session) + Task 4.3/4.5 remembered hints |
| 11 | Two settings entries that open different places: the chat header's sliders icon ("Server settings") opens About for a member; the gear in the user bar opens Account. Neither looks like the other. | 4, 7 | minor | Task 7.3 (both open the root on phones) |
| 12 | A member can't invite anyone, and nothing tells her to ask the owner. Invites is owner-only and simply absent from her settings. | 9 | material | **Unplanned** (see below) |
| 13 | "Integrations", "Audio and video", "Devices" mean nothing to her. | 7 | noise | Words are standard and accurate; grouping (finding 4) is the real fix |
| 14 | "I don't want a password at all." | 5 | noise | Invite-only servers need an account |

## Unplanned

- **Finding 12, members can't invite.** No task in the plan lets a non-owner invite or ask the owner for an invite,
  and settings doesn't say why there's nothing there. Options for the developer/owner: a member-side "Ask the owner for
  an invite" line in Settings, or member invites gated by a server setting (server change, core lane). Reported to
  the developer before Phase 5 as required by Task 0.4.
