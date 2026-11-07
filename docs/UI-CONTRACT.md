# UI contract v1

Engineering owns client/src/{contracts,data,state,transport,hooks}, services and packaging. Claude Opus 5.5 owns **client/src/ui/**: presentation, interaction design, layout, themes, motion. Initial UI files are deliberately unstyled semantic HTML. Replace them while preserving exported props, semantic accessibility, events and test selectors. Noah merges Opus's separate branch. No visuals have been designed by engineering.

## Common contract

`client/src/contracts/ui.ts` is the typed interface. IDs are opaque strings, timestamps epoch milliseconds, byte sizes decimal strings (never lossy JS numbers). Never pass service keys, password hashes, other users' device secrets, or raw logs into presentation. Every view exposes `phase: loading | ready | empty | error | offline | forbidden | unavailable`, an optional actionable `error`, and `busy` state. Async actions return promises and failures retain user input. A disabled capability includes a reason; a placeholder never implies a working feature.

Events carry typed intent; transport, browser permissions, authentication, validation, optimistic reconciliation and data persistence stay outside ui. The initial generic Screen uses a working form, inputs, selection and buttons; it emits submitted field values and action intents. Per-screen adapters may replace it without a visual design decision. Data lists are supplied, not fetched by UI. User text is rendered as text; future markdown must use sanitized tokens, no raw HTML.

## Screen/flow inventory

| Screen ID | Data/props beyond common | Events | Required states and transitions |
| --- | --- | --- | --- |
| setup | origin, configured, required env checks | initialize(ownerName, recovery/password, setupToken), checkConfiguration | fresh → submitting → owner session; already initialized; invalid setup credential; insecure origin |
| invite | token presence, expiry, inviter, instance name | accept(displayName, credential), createPasskey | valid → credential creation → joined; expired/reused/invalid; passkey cancelled/unsupported; fallback |
| login | instance, remembered account, supported authenticators | authenticatePasskey, loginFallback, recover | challenge, user cancellation, wrong origin, invalid/expired recovery, throttled |
| shell | current user, servers, channels, DMs, unread counts, connection | selectServer/channel, openDM, openSettings, reconnect, logout | connecting/online/offline/reconnecting/session revoked; empty membership |
| conversation | messages, members, read cursor, permissions, typing, pagination | send, edit, unsend, react, pin, reply, openThread, markRead, type, loadOlder | pending/sent/failed; edits conflict; deleted message removed; missing permissions |
| composer | draft, mentions candidates (user/role/everyone), attachments, replyTo | draftChanged, chooseMention, send, cancelReply, pickGif, attach, slashCommand | autocomplete; upload pending/quarantined; command invalid; send failure preserves draft |
| thread | parent ID/message, replies, participant IDs | reply, subscribe, close, jumpToParent | parent unsent, no replies, loading history |
| search | query, channel scope, results, pagination | search, nextPage, jumpToMessage | empty query/no results/deleted result/forbidden |
| pins | pinned messages, channel permission | jumpToMessage, unpin | empty/deleted/forbidden |
| members | members, roles, membership permission | createRole, assignRole, mentionMember, openDM | empty/search/no authority |
| direct-messages | conversations, selected recipients | createDM, addRecipient, leaveGroup | single/group, membership removed, duplicate selection |
| uploads | ID, filename, byte offset/length, scan/transcode state | chooseFile, start, pause, resume, cancel, retry | hashing/uploading/paused/interrupted/disk full/quarantined/ready/failed |
| media | media ID, authenticated source, dimensions, tracks, duration | play, pause, seek, chooseSubtitle, download | buffering/range retry/unsupported format/revoked/deleted |
| gifs | query, results with local proxy URLs, attribution | search, paginate, choose | key missing/rate limited/no results/loading |
| voice | peers, tracks, quality, audio devices, mute/deafen flags | join, leave, mute, deafen, camera, screenShare, selectDevice, setBitrate, setNoiseSuppression | requesting permission/denied/connecting/reconnecting/live; source ended |
| activities | voice participants, available activity capabilities | launch(plex/dj/vm), stop, join | must join voice, already active, unavailable backend |
| plex | library/search results, item, playback revision/clock, subtitle tracks | browse, search, select, play, pause, seek, chooseSubtitle | token missing/transcoding/buffering/ended/stale revision |
| dj | queue, nowPlaying, votes, host, playback clock, speech state | search, enqueue(query/link), voteSkip, remove, play, pause | metadata resolving/no source/source failure/banter generating/TTS unavailable |
| vm | video/audio tracks, controller, requests, snapshot status | requestControl, handoff, releaseControl, key, pointer, resetSnapshot | starting/VPN unavailable/viewing/controlling/controller left/reset confirmation |
| gimme | query/type, request ID, job phase, status | requestMovie, requestShow, poll, dismiss | dry-run, accepted/pending/completed/already owned/confirmation needed/unavailable; never auto-confirm torrent |
| notifications | notification IDs, message IDs, unread, retract tombstones | open, dismiss, configurePush | permission denied/retracted/background delivery unavailable |
| settings | theme IDs, audio prefs, notification prefs, local cache | setTheme, setAudio, setNotifications, clearCache | persisted/unsaved/permission denied; theme values owned in ui/tokens |
| devices | own sessions (safe metadata), current session | revoke, revokeOthers, addPasskey, rotateRecovery | last credential guard/current-device logout/revoked |
| invites-admin | invite expiry/use metadata, user list | issueInvite, revokeInvite, revokeUserSessions | owner only/copy link once/expired/used |
| report | kind, text, consent flags, screenshot/log preview | chooseScreenshot, includeLogs, submit | explicit consent each attachment/no diagnostics by default/submitting/success/error |
| reports-admin | reports, consented attachments, status | filter, inspect, resolve | owner only/empty/redacted attachments |

## Domain and event behavior

- Conversation types are channel, dm, group_dm. Reads/writes require current membership; local UI flags are not authorization.
- Message IDs are stable; edits advance a revision. Unsend removes body, attachments, search/pins/reactions and local notification handles. A durable deletion event/tombstone must win over stale fetch responses. An offline client reconciles before showing cached content.
- Notifications carry message IDs and opaque notification IDs. Retraction closes local desktop notifications and removes native notifications when the OS executes the client. Remote APNs/FCM cannot guarantee erasure of an already delivered alert on an offline device; expose actual delivery/retraction status, never claim otherwise.
- Invite flow targets under 60 seconds with a platform passkey. Fallback is explicit; first-run setup requires an env bootstrap credential. No public signup route.
- Upload totals have no product cap. Each request chunk is bounded; UI exposes disk-full/resume/scan states. Media must remain unavailable until scan succeeds.
- Voice requests stereo/fullband Opus 510000 bps by default; actual negotiated bitrate and measured statistics are separate fields. Noise suppression defaults off. No invented latency number.
- Activities use server-authoritative monotonically increasing revisions and clock anchors. Clients reject stale events, resync after gaps, and show connection state. VM control is one expiring lease, never a UI-only mutex.
- Report screenshot/log attachment selection requires explicit consent and preview; secrets must be redacted before upload.

## Transport boundary (initial implementation target)

Same-origin `/api` JSON and authenticated event stream. Authenticated requests use `Authorization: Bearer <session>` plus `X-Device-Key: <device secret>` until native proof-of-possession support lands; neither token goes into URLs. Session storage stays in the engineering adapter. Bootstrap `/api/setup`; invite issuance `/api/invites`; redemption `/api/invites/accept`; login `/api/login`; session `/api/me`; channels `/api/channels`; channel messages `/api/channels/:id/messages`; message mutations `/api/messages/:id`; notifications `/api/notifications`; event poll `/api/events?after=<cursor>`. Server and client engineers must agree exact DTOs and append revisions here. Every unimplemented capability is reported unavailable.

## Changelog

- 2026-11-07 v1: full sprint screen/flow inventory, security and synchronization semantics, engineering/presentation ownership, working unstyled generic components. Feature implementation remains pending; this contract is a handoff, not acceptance evidence.
