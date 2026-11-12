| Task | Taps | Verdict |
|---|---|---|
| join from the invite link | 1 | ok |
| find the main chat and post | 3 | ok |
| come back next day and post | 4 | ok |
| change the colour | 1 | ok |
| leave settings | 1 | ok |

- Join screen asks for: Display name / Password, 12 or more characters
- After joining she lands on a list ("Conversations"), not in a chat.
- "general" row: background rgb(33, 33, 33), height 44 px, colour rgb(237, 237, 237), chevron no.
- Next day she has to sign in again with username and password (session is memory-only on web).
- After signing in she lands on the list again.
- Chat header top edge at y=0; .hc-root padding-top 0px (the root pads by env(safe-area-inset-*), so on an iPhone the page background shows as a band under the status bar).
- Settings shows these at once: Account, Devices, Notifications, Audio and video, Report a problem, Integrations, About.
- No colour, theme or appearance setting anywhere in Settings.
- A member has no way to invite anyone: Invites is owner-only and nothing says to ask the owner.
- Leaving settings (Back) lands on: the list.

Console errors: none
