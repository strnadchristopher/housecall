# 1:1 calls on iPhone: CallKit and VoIP push

On iPhone, an incoming Housecall 1:1 call rings through the system call screen, including on the lock screen and while the app is suspended or closed. Answering joins the call, declining declines it, and ending in the system UI leaves it. Outgoing 1:1 calls are reported to CallKit too, so they appear in Recents and audio routes like a phone call.

Desktop, Android and the browser are unchanged: they get the in-app answer/decline toast from the event poll.

## Architecture

```
caller (any client)                 server                          callee iPhone
POST /channels/{id}/ring  ───────►  event call.ring to callee ───►  event poll (app open)
                                    VoIP push (APNs, topic          PushKit (app closed/suspended)
                                    <APNS_TOPIC>.voip, priority 10,
                                    30 s expiry)
                                                                    CXProvider.reportNewIncomingCall
                                                                    user answers ─► "answer" event
                                                                    ─► call.join(channelId)
```

- **Server** (`server/src/ring.rs`, `server/src/push.rs`). `POST /api/channels/{id}/ring` works only in a two-person direct conversation the caller belongs to, once per 10 s per conversation. It writes `call.ring` for the other member only and, when APNs is configured, sends a VoIP push to each of that member's registered iPhones. `POST /api/channels/{id}/ring/decline` writes `call.declined` to the other member; it is the callee declining and also the caller cancelling, and the receiving client tells them apart by its own role. `PUT/DELETE /api/push/voip {token}` store the PushKit token in `voip_devices`, bound to the session, encrypted with the push token key (`PUSH_TOKEN_KEY`), never returned. Deleting a session (sign-out, device revoke) deletes its token. A token registered by a second session (same phone, other account) moves to that session. When APNs is not configured the ring still arrives in-app and nothing is sent or logged.
- **VoIP push payload**: `{"housecall":{"kind":"ring","channel_id":"…","from":"display name"}}`, headers `apns-push-type: voip`, `apns-topic: <APNS_TOPIC>.voip`, `apns-priority: 10`, `apns-expiration: now+30`. It is not retried. Android and web get no push for a ring (the existing message-push helper is a durable, ID-only outbox tied to messages and has no call kind).
- **Plugin** (`client/src-tauri/plugins/tauri-plugin-callkit`). Rust crate with the app commands `callkit(action, payload)` (allowlist: `register`, `report_incoming`, `start_outgoing`, `connected`, `end`, `pending`) and `callkit_listen(event, handler)` (allowlist: `voipToken`, `answer`, `end`, `mute`, `audio`, `reset`). Off iOS they return `{"supported": false}`. On iOS they call `ios/Sources/CallKitPlugin.swift`.
- **Swift**: one `CXProvider` (video, one call per group, shown in Recents, generic handle) and one `CXCallController`. A `PKPushRegistry` for `.voIP` is created when the plugin loads, because a push that launches the app arrives before any web code runs. `didReceiveIncomingPushWith` reports a call to CallKit before it calls the completion handler on every push, even a malformed one; a second ring for a conversation that is already ringing is reported and ended at once. A ring nobody answers is ended after 45 s. The `pending` command returns the ringing or answered call so a webview that starts after an answer from the lock screen can join.
- **Web** (`client/src/transport/callkit.ts`, `client/src/adapters/legacy/call.ts`). `isCallKit()` is true only in the Tauri iOS app. At sign-in the app registers and sends the VoIP token to the server. A foreground `call.ring` calls `report_incoming` instead of showing the toast (and falls back to the toast if the system screen cannot be asked). `answer` joins, `end` leaves (or declines if not joined), `mute` sets the microphone. An outgoing 1:1 call calls `start_outgoing`, then `connected` when the other person joins, and `end` when the call ends however it ends.

`aps-environment` in `client/src-tauri/gen/apple/housecall-client_iOS/housecall-client_iOS.entitlements` is `development`. Release builds switch it to `production` (and `APNS_SANDBOX` must be unset on the server for them). `Info.ios.plist` declares the `voip` and `audio` background modes.

## Build on the iOS build machine

`client/src-tauri/gen/apple` is tracked, so `ios init` is not needed again (running it would regenerate the project; re-apply the entitlement and `UIBackgroundModes` if you do). The Swift package is built and linked into the Rust library by the plugin's `build.rs`, so there is nothing to add in Xcode.

```sh
cd client
npm ci
rustup target add aarch64-apple-ios aarch64-apple-ios-sim
npm run tauri -- ios build --debug --open
```

Then in Xcode: select your development team, make sure the **Push Notifications** and **Background Modes** capabilities are on for the `com.mapleavenuelabs.housecall` target, and run on a real iPhone. The simulator cannot receive VoIP pushes (PushKit issues no token), so it only proves compilation. The Swift in this change was written without a Swift compiler; the first thing to do is build it and fix any compile error.

## Apple and server setup (once, by the Apple developer account owner)

1. In the Apple developer portal, open the App ID `com.mapleavenuelabs.housecall` and enable **Push Notifications**.
2. Create an **APNs authentication key** (`.p8`). One key serves ordinary pushes and VoIP pushes. Note the Key ID and the Team ID.
3. On the server set:
   - `PUSH_ENABLED=true` and `PUSH_TOKEN_KEY` (64 hex characters; see `docs/PUSH.md`)
   - `APNS_KEY_ID` (10 characters), `APNS_TEAM_ID` (10 characters)
   - `APNS_TOPIC=com.mapleavenuelabs.housecall` (the server adds `.voip` for VoIP pushes)
   - `APNS_PRIVATE_KEY_PEM` (contents of the `.p8`)
   - `APNS_SANDBOX=true` for development builds installed from Xcode, unset for TestFlight and App Store builds
4. Restart the server. Sign in on the iPhone once; `voip_devices` then holds one row for it.

## Device test checklist (real iPhone, a second device as the caller)

- [ ] Foreground ring: app open, caller rings; the system call screen shows the caller's name, no in-app toast.
- [ ] Background ring: app in the background; the system call screen appears.
- [ ] Lock-screen ring: phone locked; the call rings on the lock screen with the caller's name.
- [ ] Closed-app ring: app force-quit; ring still arrives (VoIP push launches the app).
- [ ] Answer from the lock screen: the app opens (or stays in the background), the call joins, both sides see two tiles and hear each other.
- [ ] Decline: the caller sees "Declined" and leaves a few seconds later.
- [ ] End from the system UI during a call: the call leaves on the iPhone and the other side sees one tile.
- [ ] Caller cancels before answer: the iPhone stops ringing.
- [ ] Nobody answers: the caller leaves after 45 s; the iPhone stops ringing.
- [ ] Mute from the system call screen: the Housecall microphone mutes.
- [ ] Outgoing from the iPhone: the call appears in the Phone app's Recents and the call screen shows "connected" once the other side joins; audio routing (speaker, Bluetooth) follows the system.
- [ ] A second ring for the same conversation within the 10 s limit is refused (HTTP 429) and does not ring twice.
- [ ] Sign out and sign in as someone else on the same phone: the new account rings, the old one does not.
- [ ] Server without APNs configured: the ring still arrives while the app is open.

## Not covered by this change

- Muting from the Housecall UI does not update the system call screen (the system-to-app direction works). There is no `mute` command in the plugin's allowlist.
- Whether WKWebView's microphone capture keeps running under CallKit's audio session activation is device behaviour that could not be tested here. The plugin forwards `didActivate` and `didDeactivate` as `audio` events and sets a play-and-record voice-chat category before it reports a call; nothing in the web code uses them yet.
- No ring push for Android or the web.
- Direct (peer-to-peer) calls are a separate, design-gated phase.
