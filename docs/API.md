# Implemented API contract

All timestamps are epoch milliseconds and JSON fields snake_case. Except health/setup/login/invite acceptance, every route needs `Authorization: Bearer <token>` and `X-Device-Key: <secret>`. Secrets are returned once by authentication; only hashes persist. Errors are `{ "error": "..." }` with 400/401/403/404/409/413/429/500. No cookie authentication. Responses prohibit caching and install security headers. Public auth is globally rate limited; protected requests per session.

- `GET /api/health`: `{ok:true}`
- `POST /api/setup`: `{setup_token, username, password, device_name}` → `{token,device_key,user:{id,username,is_owner},expires_at}`; once only, bootstrap token from env.
- `POST /api/login`: `{username,password,device_name}` → same session result.
- `POST /api/invites`: owner, `{expires_in_seconds}` → `{token,expires_at}`; 60–604800 seconds.
- `POST /api/invites/accept`: `{token,username,password,device_name}` → session. Single use transaction.
- `GET /api/me`: `{user:{id,username,is_owner},session_id,capabilities:{...}}`.
- `GET /api/devices`: `{devices:[{id,device_name,created_at,expires_at,current}]}`. `DELETE /api/devices/:id`: own session only.
- `GET /api/channels`: `{channels:[{id,name,kind}]}`. General is automatically joined.
- `POST /api/channels`: `{name,kind:"channel"|"dm"|"group_dm",member_ids:[]}`. Only owner creates channels. DM includes requester and selected members.
- `GET /api/members`: `{members:[{id,username,is_owner}]}` (private instance membership).
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

Passwords 12–256 bytes; usernames 2–32 ASCII letters/digits/underscore/dash. Message bodies max 16 KiB, reports max 32 KiB. Rich embeds, voice media transport and push delivery are not implemented by this slice and are advertised unavailable. Passkeys and encrypted uploads are enabled only when configured. Activity state sync is implemented; provider playback remains unavailable. Unsend retracts durable in-app notifications and emits tombstones; it does not claim remote APNs/FCM delivery.

## Encrypted resumable uploads

Requires `CHRISCORD_MEDIA_KEY` (64 hex chars) and optional `CHRISCORD_MEDIA_DIR` (default `data/media`). `CHRISCORD_CLAMD_SOCKET` enables a local ClamAV INSTREAM scanner; without it completion fails closed with 423 and media stays quarantined. Scanner size/time limits can reject large files; quarantine is never bypassed.

- `POST /api/uploads`: `{channel_id,filename,length:"decimal u64"}` → `{id,channel_id,filename,length:"...",offset:"...",status:"uploading"|"quarantined"|"ready"}`. Membership required.
- `GET /api/uploads/:id`: owner-only resumable metadata.
- `PATCH /api/uploads/:id`: raw bytes, `Content-Type: application/octet-stream`, `Upload-Offset: <decimal>`, max 4 MiB per chunk, returns metadata. Offset mismatches return 409.
- `POST /api/uploads/:id/complete`: owner only, scans plaintext stream without writing plaintext to disk. Returns ready metadata only after clean result.
- `DELETE /api/uploads/:id`: owner only, deletes encrypted content/metadata.
- `GET /api/media/:id`: channel-membership authorized, authenticated streaming download, supports single byte Range and returns 206/416. Quarantined files return 423. No media secrets are passed in URLs.

## Passkeys

`CHRISCORD_ORIGIN=https://your-host` sets exact WebAuthn origin and hostname RP ID. Only `http://localhost:<port>` is allowed for development. Challenges expire after two minutes, remain server-side, and are consumed once. Registration requires an existing authenticated session from invite/password onboarding.

- `POST /api/passkeys/register/start`: authenticated; no body → `{challenge_id,options}`. Options are WebAuthn `CreationChallengeResponse` with `publicKey`.
- `POST /api/passkeys/register/finish`: authenticated `{challenge_id,credential}` → `{ok,credential_id}`. Credential is standard JSON registration credential (base64url binary fields). Session and account must match start.
- `POST /api/passkeys/login/start`: public `{username}` → `{challenge_id,options}`. Options are `RequestChallengeResponse` with `publicKey`.
- `POST /api/passkeys/login/finish`: public `{challenge_id,credential,device_name}` → normal auth session. Credential is standard JSON assertion; origin, RP ID, challenge, signature and user verification are verified by webauthn-rs.

Message creation also accepts `attachment_ids: [upload UUID]` (max 20). Every attachment must be owned by the author, ready after scanning, and belong to the same conversation. An upload belongs to at most one message. Messages return `attachments:[{id,filename,length:"decimal"}]`. Unsend removes their encrypted files as well as message state. Body may be empty only when attachments exist.

Owner administration: `GET /api/invites` lists `{invites:[{id,expires_at,used_at}]}` without redeemable secrets. Issuance also returns `id`. `DELETE /api/invites/:id` invalidates unused invites; `DELETE /api/users/:id/sessions` revokes every session for that account. Both are owner-only.

Reports may now attach `screenshot_id` for a ready, owned encrypted upload with `screenshot_consent:true`; logs still require separate consent. Owner report listing returns `screenshot_id`. `GET /api/reports/:id/screenshot` is owner-only authenticated streaming, even when the report's original upload belongs to a private conversation. Report diagnostics are never included without explicit per-attachment consent.

Activity state synchronization endpoints are `/api/channels/:id/activity` GET/POST `{kind:"plex"|"dj"|"vm"}`/DELETE; `/activity/commands` POST `{expected_revision,command:{type,...}}`; and `/gimme/requests` POST `{request:{media:"movie"|"tv",query},idempotency_key}`. All require channel membership, state changes use revisions, and host/control permissions are enforced server-side. This is synchronized activity state, not provider streaming or a voice SFU. Gimme endpoint always returns explicitly marked dry-run plans and never requests real media.
