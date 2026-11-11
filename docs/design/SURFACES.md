# Surfaces of the old UI and where each one lives now

Source: `client/src/App.tsx`, `client/src/ui/Shell.tsx`, `client/src/ui/screens/*`, `client/src/ui/Onboarding.tsx`,
`client/src/ui/DesktopUpdater.tsx`, read at `4e990a8` before anything was deleted.

"Removed by plan" refers to PLAN section 1 and the brief: the "Together" row, separate voice entry points,
passkey screens, the theme picker, the create-server screen.

## Signed out

| # | Old surface | New home |
|---|---|---|
| 1 | Sign in (username, password) | `onboarding/SignIn.tsx` |
| 2 | Server URL field on sign-in, invite and setup | Same screens, "Server address" field. Shown on native builds; on web it is hidden because the page host is the server |
| 3 | Accept invitation (token, display name, password, three-step indicator) | `onboarding/JoinServer.tsx`. The token field is hidden when the link supplied it. The step indicator is dropped (the form is one step) |
| 4 | First-run setup (setup token, username, password) | `onboarding/CreateAccount.tsx` (first-admin setup) |
| 5 | Mode switch (Sign in, Use invitation, First-run setup) | Text links under each onboarding form |
| 6 | Invite deep link and `#invite=` prefill | `adapters/legacy/identity.ts` keeps `subscribeInviteLinks`; opens `JoinServer` |
| 7 | "Sign in with passkey", "Passkeys coming soon on desktop" | Removed by plan |
| 8 | Password length hint | Field label "Password, 12 or more characters" |
| 9 | Error alert, busy state | Inline error line and busy button in every onboarding form |
| 10 | Dusk scene with obelisk | Removed with the old identity (PLAN 3.4 deletes the old screens) |

## Shell

| # | Old surface | New home |
|---|---|---|
| 11 | Brand header with connection state | `shell/ServerPicker.tsx` trigger (mark, server name, status) |
| 12 | Servers button, servers list, open server | `shell/ServerPicker.tsx` |
| 13 | Create server form | Removed by plan |
| 14 | Conversations list | `shell/ChannelList.tsx` |
| 15 | New DM (name, member picker) | `dm/DmView.tsx` and `dm/FriendList.tsx`, opened by the mail icon in the user bar |
| 16 | "In this conversation": Search | Search button in `chat/ChannelHeader.tsx`, results in `side/SearchPanel.tsx` |
| 17 | "In this conversation": Pins | Pins button in `chat/ChannelHeader.tsx`, list in `side/SearchPanel.tsx` |
| 18 | "In this conversation": Members | `side/PeopleTab.tsx` |
| 19 | "Together" row | Removed by plan |
| 20 | Together: Voice and video | `chat/CallBar.tsx`, `shell/CallDock.tsx`, `call/CallStage.tsx` |
| 21 | Together: Activity controls | `side/ChordsTab.tsx` and the Chord panels |
| 22 | Together: Gimme request | `chords/gimme/GimmePanel.tsx` |
| 23 | Together: Upload file | Attach control in `chat/Composer.tsx` |
| 24 | Together: Giphy picker | `chat/GifPicker.tsx` in the composer |
| 25 | "Run the place": Issue invitation | `settings/Invites.tsx` |
| 26 | "Run the place": Review reports | `settings/Reports.tsx` |
| 27 | "Run the place": Create channel | `settings/Channels.tsx` |
| 28 | "Run the place": Manage roles | `settings/Roles.tsx` |
| 29 | You: Notifications | `settings/Notifications.tsx` |
| 30 | You: Devices | `settings/Devices.tsx` |
| 31 | You: Capabilities | `settings/About.tsx` |
| 32 | You: Report a problem | `settings/ReportProblem.tsx` |
| 33 | You: Sign out | `settings/SettingsView.tsx` |
| 34 | User plate (avatar, name, online or offline) | `shell/UserBar.tsx` |
| 35 | Call dock "Return to call" | `shell/CallDock.tsx` with mute, deafen, camera, screen share, leave |
| 36 | Phone tab bar (Chats, Call, Together, More) and drawer | Stack navigation in `shell/AppShell.tsx`; the "Together" tab is removed by plan |
| 37 | Theme picker and five themes | Removed by plan |

## Conversation

| # | Old surface | New home |
|---|---|---|
| 38 | Message list, grouping by author | `chat/MessageList.tsx` |
| 39 | Typing indicator | `chat/MessageList.tsx` footer line |
| 40 | Message: author, time, markdown body, mention highlight | `chat/Message.tsx`, `chat/Markdown.tsx` |
| 41 | Reply marker with quoted parent | `chat/Message.tsx` |
| 42 | Pinned mark | `chat/Message.tsx` |
| 43 | Reactions (thumbs up only) | `chat/Message.tsx` with the full `chat/EmojiPicker.tsx` |
| 44 | Owner mark beside the name | Role label in `side/PeopleTab.tsx` |
| 45 | Video attachment with Play, inline player, Close video | `chat/Message.tsx` attachment row and inline player |
| 46 | Message actions: Reply, Preview link, React, Pin or Unpin, Edit, Unsend | `chat/Message.tsx` action row (hover or focus on desktop, tap on phone) |
| 47 | Unsend confirmation on touch | `chat/Message.tsx` inline confirm |
| 48 | Link preview screen (host, title, description, url) | Inline preview under the message in `chat/Message.tsx` |
| 49 | Mark read | Automatic when the newest message is on screen (`chat/MessageList.tsx`) |
| 50 | Gimme request status rows in the conversation | `chat/GimmeCard.tsx` |
| 51 | Upload playback error | Error line under the inline player |
| 52 | Composer: message field, Send, Save edit | `chat/Composer.tsx` |
| 53 | Composer: mention suggestions for members and roles | `chat/Composer.tsx` |
| 54 | Composer: attachment chips with remove | `chat/Composer.tsx` |
| 55 | Composer: reply and edit banner with Cancel | `chat/Composer.tsx` |
| 56 | Typing signal sent while writing | `adapters/legacy/chat.ts` |

## Pages

| # | Old surface | New home |
|---|---|---|
| 57 | Invite a friend (email, expiry, link or "sent" state) | `settings/Invites.tsx`: copyable link; email field appears only when the server asks for one |
| 58 | Members list | `side/PeopleTab.tsx` |
| 59 | Search messages | `side/SearchPanel.tsx` |
| 60 | Pinned messages | `side/SearchPanel.tsx` |
| 61 | Device sessions with Revoke | `settings/Devices.tsx` |
| 62 | Add passkey | Removed by plan |
| 63 | Notifications list | `settings/Notifications.tsx` |
| 64 | Enable desktop notifications, enable or disable background notifications | `settings/Notifications.tsx` |
| 65 | Create channel (name, server, members) | `settings/Channels.tsx` (member picker instead of typed ids; server is the current one) |
| 66 | Roles: create, assign member, delete | `settings/Roles.tsx` |
| 67 | Bug report or feature suggestion (description, kind, logs and consent, screenshot and consent) | `settings/ReportProblem.tsx` |
| 68 | Review reports (list, download screenshot, resolve) | `settings/Reports.tsx` |
| 69 | Server capabilities | `settings/About.tsx` |
| 70 | Resumable upload (choose, upload, pause, resume, progress) | Upload chip in `chat/Composer.tsx` |
| 71 | Upload scan state, Check scan status, Retry scanning | Upload chip in `chat/Composer.tsx` |
| 72 | Prepare video and thumbnail, job status | Upload chip in `chat/Composer.tsx` |
| 73 | Attach to message | Automatic when the upload is ready |
| 74 | GIF search, choose (drops the link into the message) | `chat/GifPicker.tsx`; shown only when the server has a Giphy key |
| 75 | "GIFs are switched off" page | Not rendered: the GIF control is left out when the server reports no Giphy key |
| 76 | Gimme request (title, TV toggle, request or preview, status list) | `chords/gimme/GimmePanel.tsx` |
| 77 | Voice: join with microphone and camera, join with microphone only | Join in `chat/CallBar.tsx` (microphone only), camera toggle in the call controls |
| 78 | Voice: input device list, refresh, select microphone and camera | `call/DeviceMenu.tsx` |
| 79 | Voice: Leave, Mute, Share screen | `chat/CallBar.tsx`, `shell/CallDock.tsx` |
| 80 | Voice: Opus bitrate and noise suppression | `call/DeviceMenu.tsx` |
| 81 | Voice: status line (phase, bytes, frames, error) | `call/CallStage.tsx` state label and error; byte and frame counters stay on the stage element as data attributes for tests |
| 82 | Remote media tiles | `call/Tile.tsx` |
| 83 | Activities: start Plex watch party, start DJ session | `chords/gimme/GimmePanel.tsx` (Watch), `chords/steve/StevePanel.tsx` (DJ) |
| 84 | Activities: snapshot (state, position, host, controller), queue | Chord panels |
| 85 | Activities: Play, Pause, Seek, Stop | Chord panels |
| 86 | Activities: select media by id, enqueue by title and link, handoff by user id | Chord panels: library picker, song search, host picker |
| 87 | Activities: Vote to skip | `chords/steve/StevePanel.tsx` |
| 88 | Plex library browser, "Watch together" | `chords/gimme/GimmePanel.tsx` |
| 89 | Plex player, Show or Hide subtitles, playback error | `chords/gimme/GimmePanel.tsx` |
| 90 | DJ song search, "Prepare and queue", shared audio, playback error | `chords/steve/StevePanel.tsx` |
| 91 | Shared VM: media status, live stream, Stop shared video and audio | `chords/browser/SharedBrowserPanel.tsx` |
| 92 | Shared VM: previous reset outcome, Check outcome, Retry the same reset | `chords/browser/SharedBrowserPanel.tsx` |
| 93 | Shared VM controls that were rendered disabled ("coming soon": start video, request control, reset) | Not rendered (rule 1: no dead controls). Listed under Gaps in HANDOFF |
| 94 | Desktop updater banners (downloading, ready with Later and Restart, failed with Dismiss) | `shell/UpdateBanner.tsx` over `IdentityProvider.update` |
| 95 | Back to conversation | Back control in each stacked view, Escape on desktop |
| 96 | Fixture workbench (`ui/workbench`) | Removed (brief step 8); the running app with the real test server replaces it |

## Check at the end

Recorded at the end of the work; see the bottom of this file.
