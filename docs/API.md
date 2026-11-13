# Implemented API contract

All timestamps are epoch milliseconds and JSON fields snake_case. Except health/setup/login/invite acceptance, every route needs `Authorization: Bearer <token>` and `X-Device-Key: <secret>`. Secrets are returned once by authentication; only hashes persist. Errors are `{ "error": "..." }` with 400/401/403/404/409/413/429/500. No cookie authentication. Responses prohibit caching and install security headers. Public auth is globally rate limited; protected requests per session.

- `GET /api/health`: `{ok:true}`
- `POST /api/setup`: `{setup_token, username, password, device_name}` → `{token,device_key,user:{id,username,is_owner},expires_at}`; once only, bootstrap token from env.
- `POST /api/login`: `{username,password,device_name}` → same session result.
- `POST /api/invites`: owner, `{expires_in_seconds?, max_uses?, email?, server_id?}` → `{id,token,code,link,expires_at,max_uses,server_id,email,email_sent}`. `expires_in_seconds`: 60–31536000 (365 days), default 604800, `null` = never expires (`expires_at` is then null). `max_uses`: 1–1000, default 1, `null` = unlimited; email invitations are always single use and need an expiry. `code` is `hc1.<base64url(public origin)>.<token>` and carries the server address; it and `token` are null when the email was sent. `email` is optional; mail is sent only when an address is given and mail is configured (`RESEND_API_KEY`, `HOUSECALL_MAIL_FROM`). `link` is always present: the invite link (`<HOUSECALL_PUBLIC_URL>/#invite=<token>`) to share by any means. `token` is null when the email was sent.
- `POST /api/invites/accept`: `{token,username,password,device_name}` → session. Each acceptance spends one use in a transaction.
- `POST /api/invites/redeem`: signed in, `{token}` → `{server_id, joined}`. Joins the invite's server; existing members get `joined:false` and no use is spent.
- `GET /api/instance` (public): `{name, requests_open}`; `name` is the home server name. `PATCH /api/instance` (owner): `{requests_open: bool}` turns request-access on or off (default on).
- `POST /api/access-requests` (public, rate limited): `{username, password, device_name, message?}` (message ≤ 500 characters) → `{id, status:"pending"}`. Creates a disabled account that reserves the username. 409 username taken, 403 requests closed, 429 when 50 requests are already pending. `GET /api/access-requests/{id}/status` (public): `{status}` with `pending|approved|declined`; the id is 256 random bits and reveals nothing else.
- Owner: `GET /api/access-requests` → `{requests:[{id,username,message,status,created_at,decided_at,server_id}]}` (pending first; `username` is empty after a decline). `POST /api/access-requests/{id}/approve {server_id?}` enables the account and joins the server → `{status,server_id}`. `POST /api/access-requests/{id}/decline` deletes the account (the username is free again) → `{status}`. A decided request answers 409.
- `POST /api/login` for an account whose request is still pending answers 403 `access request pending` (only after the password is correct; wrong passwords and unknown names stay 401). A declined account no longer exists, so it answers the normal 401; clients read "declined" from the status endpoint. `GET /api/members` no longer lists disabled accounts.
- `GET /api/me`: `{user:{id,username,is_owner,display_name,avatar_rev,bio},session_id,capabilities:{...}}`. `display_name` and `bio` are `string|null`; `avatar_rev` is an integer.
- `PATCH /api/me`: `{display_name?: string|null, bio?: string|null}` → `{display_name: string|null, bio: string|null}` (the stored values). Only the keys present in the body change, so `{"bio":"hi"}` leaves the name alone. `display_name`: trimmed, 1–32 characters, `null` clears. `bio`: trimmed, at most 190 characters (counted as characters, not bytes), newlines and tabs allowed; an empty string or `null` clears it. Any other control character or invisible/direction-changing character (U+202E, U+200B, U+FEFF and the like) in either field → 400. Emits `member.updated` to every channel the caller is in:

  ```json
  {"kind":"member.updated","channel_id":"<channel id>","payload":{"user_id":"<id>","display_name":"Ali","avatar_rev":0,"bio":"Builds things"}}
  ```
- `GET /api/devices`: `{devices:[{id,device_name,created_at,expires_at,current}]}`. `DELETE /api/devices/:id`: own session only.
- `GET /api/channels`: `{channels:[{id,name,kind,server_id,peer_id}]}`. `kind` is `"channel"`, `"voice"`, `"dm"` or `"group_dm"`. General is automatically joined, and so is every voice channel of a server you are in.
- `POST /api/channels`: `{name,kind:"channel"|"voice"|"dm"|"group_dm",member_ids:[]}` → `{id,name,kind,server_id}`. Only the owner creates `channel` and `voice` channels. DM includes requester and selected members. See "Voice channels" below for `voice`.
- `GET /api/members`: `{members:[{id,username,is_owner,display_name,avatar_rev,bio}]}` (private instance membership). `GET /api/servers/:id/members` returns the same fields.
- `GET /api/channels/:id/messages?before=<millis>&q=<text>&pinned=true`: `{messages:[{id,channel_id,author_id,body,reply_to,created_at,edited_at,revision,pinned,mention_ids,reactions:[{emoji,user_id}]}]}`. Latest 100, ascending.
- `POST /api/channels/:id/messages`: `{body,reply_to:null,mention_ids:[]}` → message. Mention IDs must be current conversation members. `@everyone` owner only.
- `PATCH /api/messages/:id`: `{body,revision}` → message. Author only, optimistic revision conflict 409.
- `DELETE /api/messages/:id`: author or owner → `{ok:true}`; purge content and notification rows; emits durable `message.deleted` tombstone to every member.
- `POST /api/messages/:id/reactions`: `{emoji}` → `{ok:true}`; toggles own reaction.
- `POST /api/messages/:id/pin`: `{pinned}` → `{ok:true}`; channel members may pin.
- `POST /api/channels/:id/read`: `{message_id}` → `{ok:true}`.
- `POST /api/channels/:id/typing`: `{active}` → `{ok:true}`; event expires after 6 seconds.
- `GET /api/notifications`: `{notifications:[{id,message_id,channel_id,created_at}]}`.
- `GET /api/events?after=<integer>`: `{events:[{id,kind,channel_id,payload,created_at}],cursor}`. Private per-user durable events, up to 500. Events contain IDs (never message bodies); fetch current authorized data after notification.
- `POST /api/reports`: `{kind:"bug"|"feature",body,logs:null,logs_consent:false,screenshot_id:null,screenshot_consent:false}` → `{id}`. Logs and screenshots require separate consent; screenshots reference owned, scanned uploads.
- `GET /api/reports`: owner → `{reports:[...]}`. `PATCH /api/reports/:id`: owner `{status:"open"|"resolved"}` → `{ok:true}`.

Passwords 12–256 bytes; usernames 2–32 ASCII letters/digits/underscore/dash. Message bodies max 16 KiB, reports max 32 KiB. Authenticated text-only link metadata is available through the SSRF-checked embeds endpoint. Voice transport, passkeys, encrypted uploads and media derivatives are enabled only when configured. Activity state sync is implemented; provider playback and remote push delivery remain unavailable. Unsend retracts durable in-app notifications and emits tombstones; it does not claim remote APNs/FCM delivery.

## Encrypted resumable uploads

Requires `HOUSECALL_MEDIA_KEY` (64 hex chars) and optional `HOUSECALL_MEDIA_DIR` (default `data/media`). `HOUSECALL_CLAMD_SOCKET` enables a local ClamAV INSTREAM scanner; without it completion fails closed with 423 and media stays quarantined. Scanner size/time limits can reject large files; quarantine is never bypassed.

- `POST /api/uploads`: `{channel_id,filename,length:"decimal u64"}` → `{id,channel_id,filename,length:"...",offset:"...",status:"uploading"|"quarantined"|"ready"}`. Membership required.
- `GET /api/uploads/:id`: owner-only resumable metadata.
- `PATCH /api/uploads/:id`: raw bytes, `Content-Type: application/octet-stream`, `Upload-Offset: <decimal>`, max 4 MiB per chunk, returns metadata. Offset mismatches return 409.
- `POST /api/uploads/:id/complete`: owner only, scans plaintext stream without writing plaintext to disk. Returns ready metadata only after clean result.
- `DELETE /api/uploads/:id`: owner only, deletes encrypted content/metadata.
- `GET /api/media/:id`: channel-membership authorized, authenticated streaming download, supports single byte Range and returns 206/416. Quarantined files return 423. No media secrets are passed in URLs.

## Passkeys

`HOUSECALL_ORIGIN=https://your-host` sets exact WebAuthn origin and hostname RP ID. Only `http://localhost:<port>` is allowed for development. Challenges expire after two minutes, remain server-side, and are consumed once. Registration requires an existing authenticated session from invite/password onboarding.

- `POST /api/passkeys/register/start`: authenticated; no body → `{challenge_id,options}`. Options are WebAuthn `CreationChallengeResponse` with `publicKey`.
- `POST /api/passkeys/register/finish`: authenticated `{challenge_id,credential}` → `{ok,credential_id}`. Credential is standard JSON registration credential (base64url binary fields). Session and account must match start.
- `POST /api/passkeys/login/start`: public `{username}` → `{challenge_id,options}`. Options are `RequestChallengeResponse` with `publicKey`.
- `POST /api/passkeys/login/finish`: public `{challenge_id,credential,device_name}` → normal auth session. Credential is standard JSON assertion; origin, RP ID, challenge, signature and user verification are verified by webauthn-rs.

Message creation also accepts `attachment_ids: [upload UUID]` (max 20). Every attachment must be owned by the author, ready after scanning, and belong to the same conversation. An upload belongs to at most one message. Messages return `attachments:[{id,filename,length:"decimal"}]`. Unsend removes their encrypted files as well as message state. Body may be empty only when attachments exist.

Owner administration: `GET /api/invites` lists `{invites:[{id,expires_at,used_at,email,uses,max_uses,server_id}]}` (`expires_at`/`max_uses` null = never/unlimited) without redeemable secrets. Issuance also returns `id`. `DELETE /api/invites/:id` invalidates unused invites; `DELETE /api/users/:id/sessions` revokes every session for that account. Both are owner-only.

Reports may now attach `screenshot_id` for a ready, owned encrypted upload with `screenshot_consent:true`; logs still require separate consent. Owner report listing returns `screenshot_id`. `GET /api/reports/:id/screenshot` is owner-only authenticated streaming, even when the report's original upload belongs to a private conversation. Report diagnostics are never included without explicit per-attachment consent.

Activity state synchronization endpoints are `/api/channels/:id/activity` GET/POST `{kind:"plex"|"dj"|"vm"}`/DELETE; `/activity/commands` POST `{expected_revision,command:{type,...}}`; and `/gimme/requests` POST `{request:{media:"movie"|"tv",query},idempotency_key}`. All require channel membership, state changes use revisions, and host/control permissions are enforced server-side. This is synchronized activity state, not provider streaming or a voice SFU. Gimme endpoint always returns explicitly marked dry-run plans and never requests real media.

## Server namespaces, roles and threads

Default server ID is `home`, retaining channel ID `general`. Channels now expose `server_id` (null for DMs). Owner-created servers each get a general channel. Invitations accept optional `server_id` (default `home`); redemption joins only that server and its general channel. Owner may explicitly add existing accounts to other servers.

- `GET /api/servers` → `{servers:[{id,name,general_channel_id}]}`, current memberships only.
- `POST /api/servers` owner `{name}` → server DTO.
- `GET /api/servers/:id/members` → `{members:[User]}`, server membership required.
- `POST /api/servers/:id/members` owner `{user_id}` → `{ok:true}`; joins general channel and broadcasts `member.joined`.
- `POST /api/channels` accepts optional `server_id`; all selected channel members must belong to that server. DMs remain independent of server namespaces.
- `GET /api/servers/:id/roles` → `{roles:[{id,name,member_ids}]}`, server membership required.
- `POST /api/servers/:id/roles` owner `{name}` → `{id,server_id,name,member_ids:[]}`.
- `POST /api/roles/:id/members` owner `{user_id}` assigns a current server member; `DELETE /api/roles/:id/members/:user_id` unassigns; `DELETE /api/roles/:id` deletes role.
- Message send accepts `role_mention_ids:[]`. Server validates same-server roles and resolves recipients by intersecting role membership with the conversation's current membership. Returned `mention_ids` are effective recipients; `role_mention_ids` preserve intent. A role never grants channel access or sends private-channel notifications to outsiders.
- `GET /api/channels/:id/messages?reply_to=<parent_id>` returns only that parent's replies, still with normal membership/search/pagination constraints. Unsend clears reply parent pointers and removes parent-owned attachments.

Capabilities distinguish `activity_sync:true` from `activity_playback:false`. Passkey origin config rejects credentials, paths, queries and fragments; password hashing/verification uses at most two concurrent Argon2 jobs with 429 overload responses.

## Voice transport

Set both `SFU_BIND=<udp address:port>` and `SFU_PUBLIC_IP=<routable address>` to enable the Rust SFU. Authentication and current channel membership are checked on signaling and rechecked during active media; revoked sessions are disconnected. No TURN service or Internet reachability is inferred from successful LAN signaling.

- `POST /api/channels/:id/voice/join`: raw SDP offer JSON `{type:"offer",sdp}` → `{peer_id,answer:{type:"answer",sdp}}`.
- `GET /api/channels/:id/voice/stats`: `{peers:[...]}`, authorized room stats.
- `DELETE /api/channels/:id/voice/:peer_id`: leaves only the caller's own session/peer.

### Voice channels (0.4.0)

A voice channel is a channel with a call attached. `POST /api/channels {"name":"Game night","kind":"voice"}` (owner only, others get 403; optional `server_id`, default `home`) → `{"id":"<id>","name":"Game night","kind":"voice","server_id":"home"}`. It always includes every member of the server, and anyone who joins the server later is added to it. Every server has at least one: the server creates a voice channel named `Lounge` for any server that has none, at startup and when a server is created, so there is never a second one. Messages, replies, reactions, uploads, search, unread counts and read marks work in a voice channel exactly as in a text channel; it has a text chat. The server still accepts `voice/join` on any conversation (0.3.0 clients rely on it); only the UI decides where to offer calls.

### Live voice state and events (0.4.0)

State lives in server memory and is cleared on leave, when the SFU stops listing the peer (checked every 3 seconds, and on each `GET /api/voice/rooms`) and on restart. A person with several devices in a call has one state and is announced once.

State record (used in `states` and in events):

```json
{"user_id":"<id>","muted":false,"deafened":false,"camera":false,"sharing":false,"joined_at":1731500000000}
```

- `PUT /api/channels/:id/voice/state` with `{"muted":true,"deafened":false,"camera":false,"sharing":true}` → `200` and the record plus the channel:

  ```json
  {"channel_id":"<id>","user_id":"<id>","muted":true,"deafened":false,"camera":false,"sharing":true,"joined_at":1731500000000}
  ```

  Every flag is optional; a flag left out keeps its value. The caller must be a member of the channel (403 otherwise) and currently in its call (409 `not in this call` otherwise). Setting `sharing:false` deletes the stream preview.
- `GET /api/voice/rooms` → `{"rooms":{"<channel_id>":["<user_id>"]},"states":{"<channel_id>":[<state record>]}}`. `rooms` is unchanged from 0.3.0: user ids only, one per person, only channels the caller belongs to. `states` has the same channels' records, oldest `joined_at` first. Without the SFU: `{"rooms":{},"states":{}}`. 0.3.0 clients read only `rooms` and are unaffected.
- Events, delivered through `GET /api/events` to the members of the channel and nobody else (the person who changed state gets them too):

  ```json
  {"kind":"voice.joined","channel_id":"<id>","payload":{"channel_id":"<id>","user_id":"<id>","muted":false,"deafened":false,"camera":false,"sharing":false,"joined_at":1731500000000}}
  {"kind":"voice.state","channel_id":"<id>","payload":{"channel_id":"<id>","user_id":"<id>","muted":true,"deafened":false,"camera":false,"sharing":true,"joined_at":1731500000000}}
  {"kind":"voice.left","channel_id":"<id>","payload":{"channel_id":"<id>","user_id":"<id>"}}
  ```

  `voice.joined` fires when someone's first device joins (all four flags `false`); `voice.left` fires on leave and on peer timeout. `voice.state` fires on every `PUT`, even if nothing changed.

### Stream previews (0.4.0)

A small picture of someone's screen share, for the channel's call card. Memory only; never written to disk or the database.

- `PUT /api/channels/:id/voice/preview`, `Content-Type: image/jpeg`, raw JPEG bytes → `200 {"ok":true,"stored_at":1731500000000}`. Members only (403), only while the caller's state has `sharing:true` (409), body must start with the JPEG signature and be sent as `image/jpeg` (415), at most 65536 bytes (413), at most one accepted per 10 seconds per person (429; the stored image stays as it was). A new image replaces the old one.
- `GET /api/channels/:id/voice/preview/:user_id` → the JPEG, with `Content-Type: image/jpeg`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`. Channel members only (403); 404 when there is none. Poll no faster than every 10 seconds, and send the usual auth headers (an `<img>` tag cannot, so fetch it and use an object URL).
- The preview is deleted when the person stops sharing (`PUT .../voice/state` with `sharing:false`), leaves, times out, or the server restarts.

When SFU is configured, activity launch/read/control/stop requires a connected voice session and the synchronized roster contains only connected peers. Without configured SFU, `activity_sync` remains a domain synchronization prototype and `activity_playback` remains false. Live camera/Opus decode, bitrate, browser compatibility, screen share and latency need their own measurements; synthetic encrypted RTP forwarding is not glass-to-glass evidence.

## Asynchronous CPU video derivatives

With encrypted media configured and `HOUSECALL_FFMPEG` (default `/usr/bin/ffmpeg`) present, `capabilities.transcode` is true. `HOUSECALL_TRANSCODE_TIMEOUT_SECONDS` defaults to 21600 (maximum86400). Jobs are persisted in SQLite, processed one at a time, with at most32 queued/running jobs. Restart marks interrupted jobs failed and retryable; re-POST the source to retry.

- `POST /api/uploads/:id/derive` requires a ready scanned upload owned by the caller plus current channel membership. Returns **202** `{id,status:"queued"}`. An active job for that source returns409; a full queue returns429.
- `GET /api/media-jobs/:id` requires job ownership and channel membership. Returns `{id,source_id,owner_id,channel_id,status:"queued"|"running"|"ready"|"failed",error:null|string,retryable,created_at,updated_at}`. Ready jobs add `video_path` and `thumbnail_path`.
- `GET /api/media-jobs/:id/video` and `/thumbnail` require current channel membership and a ready job. They support authenticated byte ranges, with `video/mp4` and `image/jpeg` respectively. Other states return409.
- Message attachment DTOs now include nullable `video_path` and `thumbnail_path`. A durable `media.ready` event `{upload_id,job_id}` tells members to refresh attachments. Original deletion or message unsend marks jobs `source_deleted`, disables reads and deletes every generated encrypted object.

FFmpeg receives decrypted bytes only through stdin and writes output only through stdout. Bounded buffers feed encrypted chunks; plaintext never spills to disk. Video is CPU H.264/AAC fragmented MP4, at most1920×1080 without upscaling, one encoder/filter thread; thumbnail is JPEG320 pixels wide. FFmpeg has fixed arguments, empty inherited environment, pipe-only protocol access, bounded allocation/probe options, and kill-on-drop timeout. Source deletion and owner membership are checked every 250 milliseconds to cancel active processing independently of pipe progress. Both generated outputs must pass the normal scanner before the job becomes ready. Scanner rejection, missing binary, malformed input, storage failures and timeouts stay explicit failed states with no published derivative.

**Format limitation:** input must be demuxable from a non-seekable pipe. Fragmented/streamable MP4 is verified with an actual generated audiovisual fixture and decoded resulting MP4. A conventional MP4 with metadata at its end may require backward seeks and fail with `input_not_streamable` or `input_unsupported_or_ffmpeg_failed`; no plaintext spool or misleading successful status is used. The original encrypted upload remains available, and failure never imposes a product-wide upload-size cap.

## Text-only link metadata

`GET /api/embeds?url=<encoded-https-url>` requires an authenticated device session and returns `{url,hostname,title,description}`. Only public HTTPS port 443 is permitted; every DNS result is checked before the selected address is pinned. Redirects, proxy inheritance, userinfo, private IPs and active HTML are rejected. HTML is bounded to 512 KiB and at most two previews run concurrently. The client renders the returned strings as text; this endpoint does not proxy images or third-party scripts.

## Plex watch-party gateway

Set both `PLEX_URL` and `PLEX_TOKEN` to enable the provider; `capabilities.plex` also requires configured voice transport. Every Plex route requires current channel membership, a connected caller device in voice, and an active Plex activity. Credentials stay in server-side provider headers.

- `GET /api/channels/:id/plex/sections` → `{libraries:[{id,title,kind}]}`.
- `GET /api/channels/:id/plex/items?section=:id&start=0` → `{items:[{id,title,kind,duration_ms,subtitles:[{id,language,codec,embedded}]}]}`.
- `GET /api/channels/:id/plex/metadata/:rating_key` → one item with subtitle choices.
- `POST /api/channels/:id/plex/playback` with `{rating_key,subtitle_id?:string}` → `{playback_id,rating_key,manifest_url}`. The host first selects the same media ID in the synchronized activity; only the host may select subtitles. Peers reuse the shared playback.
- `GET /api/channels/:id/plex/playback` returns the current descriptor. Host-only `DELETE` stops it; stopping the activity also closes its gateway session.
- `GET /api/channels/:id/plex/resources/:opaque_id` streams authorized HLS manifests/segments and subtitle resources. Every rewritten URI stays on the authenticated Housecall origin; HLS requests must include the bearer and device-key headers. Segment streaming rechecks the device session and voice/activity access every second. Provider URLs/tokens never appear in client manifests.

Play/pause/seek remain revision-checked activity commands. Playback descriptors emit `plex.playback`; clients use the activity clock for synchronization. The gateway does not by itself establish playback quality or synchronization measurements; those require the three-client fixture/live-provider evidence.
