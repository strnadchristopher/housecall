# Native push outbox

The server implements an opt-in, durable APNs/FCM outbox. Payloads contain IDs and operation metadata only. This is the provider/backend slice; native token acquisition, background handlers, OS notification removal and physical iOS/Android delivery need separate device acceptance. Provider acceptance is never reported as notification delivery or successful remote erasure.

## Configuration

Disabled by default (`PUSH_ENABLED=false`). Enabling requires `PUSH_TOKEN_KEY`, exactly 64 hexadecimal characters (32 random bytes), and at least one provider's credentials. Empty provider environment values are ignored, so one provider can be enabled independently.

- APNs: `APNS_PRIVATE_KEY_PEM` (P-256 signing key), `APNS_KEY_ID`, `APNS_TEAM_ID` (both ten characters), `APNS_TOPIC` (application bundle ID); `APNS_SANDBOX=true` selects Apple's sandbox, otherwise production.
- FCM: `FCM_SERVICE_ACCOUNT_JSON` with `private_key`, `private_key_id`, `client_email`, `project_id`. RSA keys must be 2048–4096 bits. The credential's `token_uri` is ignored: OAuth and messaging origins are fixed Google HTTPS origins.

Credentials come only from environment, never files or API bodies. Device tokens are AES-256-GCM encrypted in SQLite with fresh random nonces and device-ID associated data. A SHA-256 digest supports duplicate detection. No token or credential is returned through status routes or logged. Rotating `PUSH_TOKEN_KEY` requires devices to register their current tokens again; unreadable old tokens fail closed. Database backups and the encryption key must be backed up separately. APNs uses HTTP/2 and ES256 JWTs; FCM uses RS256 assertions and bounded OAuth token caching. Redirects and environment HTTP proxies are disabled.

## Authenticated API

All paths below are under `/api` and require the existing bearer session plus `X-Device-Key`.

| Method/path | Contract |
| --- | --- |
| `PUT /push/device` | `{ "provider": "apns" or "fcm", "token": "..." }`; binds one token to the current session. Disabled/unconfigured provider: 503. Token already bound to another active session: 409. Rotation deletes the old registration's intents. |
| `GET /push/device` | `{registered, device: {id,provider,updated_at} or null, delivery_enabled}`; never the token. |
| `DELETE /push/device` | Removes only the current session's registration and queued/history events. |
| `GET /push/events` | `{events:[{id,message_id,channel_id,kind,epoch,state,attempts,error,updated_at,retraction_pending}],reconciliation_required,history_truncated}`. Returns retracts first, at most 100 current-session events; unregistered sessions receive an empty list. |
| `POST /push/events/{id}/ack` | Records that the current device says it applied this event. Other sessions/users receive 404. Idempotent `{ok:true}`. |

Event `kind` is `alert` or `retract`, with numeric epoch 0 or 1 respectively. Provider payloads use string epochs, `event_id` instead of `id`, and `operation` instead of `kind`; the other fields are `message_id` and `channel_id`. APNs adds `aps.content-available=1`, background push type, priority 5, stable `apns-id` and message-ID hash collapse ID. FCM uses data-only Android messages. Neither includes chat text, author names, channel names, media URLs or credentials.

## Transactions, restart and unsend races

Root wiring calls `enqueue_alert` in the same SQLite transaction as the durable mention notification. `enqueue_retract` runs before deleting the message/notification, in that same transaction. It removes every alert intent for the message, including in-flight and accepted records, and creates an idempotent per-device tombstone. Tombstones deliberately have no message foreign key.

The worker claims one job with a 30-second lease. Restart resumes expired in-flight leases and queued jobs using their original event IDs. It checks session expiry, current channel membership and current message/notification existence immediately before provider delivery, including after OAuth. Session deletion cascades registration and jobs. A single worker gate orders operations. If unsend removes an in-flight alert while its HTTP request finishes, the completion cannot resurrect that alert; it requeues the stable tombstone after the late completion.

States are `queued`, `inflight`, `accepted`, `acknowledged`, `failed`. Accepted means only the provider returned success. A retract remains `retraction_pending=true` until client acknowledgment. An acknowledgment is a client claim, not attestation of an OS operation.

Retries are capped at five attempts: transport uncertainty, HTTP 429/500/503 use backoff and jitter, respecting `Retry-After` seconds or HTTP dates without shortening them. Authentication and other permanent rejection errors fail without automatic retry. Alert delivery expires after one hour, retraction after seven days. Invalidated provider registrations are removed. Transport failures can occur after remote acceptance, so duplicate deliveries are possible; stable event IDs and epochs make client operations idempotent.

The worker retains terminal history for up to fourteen days, pruned on enqueue. The outbox is bounded to 16,384 events and registrations to 512. At capacity, terminal history can be evicted, and tombstones can displace alerts. If still full, the new intent is dropped without preventing chat/unsend; `reconciliation_required` is set. More than 100 session events also sets `history_truncated` and `reconciliation_required`. Native clients must reconcile their displayed notification IDs against authenticated current message state, including after reconnect, rather than depend solely on push/history. Payload delivery and retention are finite and cannot guarantee deletion on an offline device.

## Required native client behavior

1. Treat provider messages as hints. Validate against the authenticated current-session `/push/events` response before showing any alert; fetch authoritative message/channel state and suppress alerts if authentication, membership or existence cannot be confirmed.
2. Process retracts before alerts. Persist the highest epoch per message: epoch 1 always wins over a delayed/replayed epoch 0. Remove the matching OS notification by stable message ID, then acknowledge the event. Never interpret APNs collapse IDs as an erase operation.
3. Deduplicate event IDs and reconcile displayed notifications after reconnect, app resume, incomplete history or outbox overflow. Clear account-specific notifications and local state on logout/revocation.
4. If a platform delays/throttles background execution, keep retraction pending until actual application. No honest server implementation can guarantee immediate erasure from offline or suspended devices.

The current native bridge is a separate acceptance gate. APNs background pushes may be throttled; a data-only design intentionally avoids putting private content into OS-provider payloads. FCM high priority can be deprioritized by the provider if application behavior does not meet its delivery expectations.

## Test scope and references

Inline tests in `server/src/push.rs` use ephemeral EC/RSA keys, synthetic tokens, actual loopback HTTP provider/OAuth fixtures, real SQLite transactions and authenticated Axum routes. They exercise signature verification, encryption integrity, session scoping, rollback, unsend before dispatch and during HTTP delivery, acknowledgment, retry/restart, revocation and provider invalidation. Configuration tests inject a map rather than reading host credentials. Loopback fixtures use HTTP/1 and explicitly bypass the production APNs HTTP/2 requirement; they do not prove Apple/Google delivery or native OS behavior. No real APNs/FCM calls are performed.

Provider contracts: [Apple token authentication](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns), [APNs request/response protocol](https://developer.apple.com/library/archive/documentation/NetworkingInternet/Conceptual/RemoteNotificationsPG/CommunicatingwithAPNs.html), [FCM HTTP v1](https://firebase.google.com/docs/cloud-messaging/send/v1-api), [FCM errors](https://firebase.google.com/docs/cloud-messaging/error-codes), [FCM quotas](https://firebase.google.com/docs/cloud-messaging/throttling-and-quotas).

Verified receipt: `evidence/push-focused-tests.log` records nine passing focused tests; `evidence/push-clippy.log` records strict server all-target clippy success. `rustfmt --edition 2021 --check server/src/push.rs` passed. The first compile's test-constructor typo and initial mechanical lint findings are retained in `evidence/push-focused-build-attempt1.log` and `evidence/push-clippy-attempt1.log`; both were corrected before the passing run.
