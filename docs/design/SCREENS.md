# Screens

Every screen of the interface, its layout at each width, and the states it has. Strings come from `client/src/ui/copy.ts`; state words are labels, not sentences.

## Layouts

| Width | Layout |
|---|---|
| Above 1100 px | Three columns: left (servers, conversations, call dock, user bar), center (conversation or settings), right (People and Chords, search, pins) |
| 760 to 1100 px (tablet, phone landscape) | Two columns. The right column is a sheet from the right edge, opened from the header |
| 760 px and below (phone) | One column with stack navigation: list, then conversation. The right column is a bottom sheet. In a call, the call bar (and, in settings, the dock) keeps mute and leave in reach |

Safe-area insets are applied once on `.hc-root`; the viewport meta uses `viewport-fit=cover`.

## Signed out (`onboarding/Onboarding.tsx`)

| Screen | Contents | States |
|---|---|---|
| Sign in | Username, password; links to "Use an invite" and "Set up a new server" | busy (button), error (inline line) |
| Join | Display name, password, token only if the link did not supply it; "Sign in" link. No setup link with an invite token | busy, error |
| Set up server | Setup token, username, password | busy, error |
| Add server (native, from the picker) | Same forms for another host, "Back" cancels | busy, error |

## Signed in

| Screen | File | Contents |
|---|---|---|
| Conversation list | `shell/ChannelList.tsx` | Channels with unread and mention counts; "In call" avatars under a channel once you are in that call |
| Direct messages | `dm/DmView.tsx`, `dm/FriendList.tsx` | Existing DMs, pick people, optional name, Start |
| Conversation | `chat/ChannelHeader.tsx`, `MessageList.tsx`, `CallBar.tsx`, `Composer.tsx` | Header, call stage, messages, call bar, composer |
| Right column | `side/RightPanel.tsx` | People tab; Chords tab only when a Chord is configured; one Chord, search or pins opens in place |
| Settings | `settings/SettingsView.tsx` | Account, Devices, Notifications, Audio and video, Report a problem; owner: Invites, Channels, Roles, Reports; About |

## States

| State | Where and how it shows |
|---|---|
| Empty | Conversation with no messages shows the empty list and composer, no sentence. Search and pins show "No results" / "No pins". Reports show "No reports". The Chords tab is absent when nothing is configured |
| Loading | "Loading" label in the message area from opening a conversation until its first page arrives |
| Error | An inline line (`ErrorLine`) above the composer or at the top of the settings pane, dismissible; field-level failures in the form that caused them. Forms clear or navigate only after success |
| Offline | "Reconnecting" in the picker, in the center column and in the user bar (one label everywhere) |
| Call elsewhere | In another conversation the call bar reads "In call in <name>" with mute, deafen, camera, share and leave. "Join" asks "Switch call" before leaving the current call. On a phone in settings the dock sits at the bottom of the pane |
| Call failed | Call bar and dock read "Call failed" with the error |
| Update | `shell/UpdateBanner.tsx` above the shell: downloading, ready (Restart, Later), failed |
