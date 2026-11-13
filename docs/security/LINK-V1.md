# LINK-V1: QR login and device linking (Housecall 0.4.0)

Status: contract for implementation. Nothing here is built yet. Reviewed on paper by an attacker session before W5 starts (PLAN S4), attacked live afterwards (PLAN C6).

What it does: a device where you are logged in (the **showing device**) displays a QR code. A second device (the **new device**) scans it. Both show the same two-digit number. You tap Approve on the showing device. The new device is then logged in, and it receives your identity keys (`DM-V1.md` section 3) sealed so that only it can open them.

Test vectors: `client/tests/vectors/link-v1.json`, from `node client/scripts/security-vectors.mjs`, which is the reference implementation. Notation (`‖`, `u32be`, `HKDF`, `AEAD`, `X25519`, `b64u`) is as in `DM-V1.md` section 3.1.

## Changes from the plan

PLAN W5 C1 and decision S-1 were the outline. These are the differences, and why.

1. **The claim carries a `claim_tag` that proves the new device read the QR code.** The plan relied only on the two-digit number to catch a host that swaps the new device's ephemeral key. Two digits can be matched by luck one time in a hundred. The showing device's ephemeral public key is in the QR fragment, which the server never receives. The tag is derived from the X25519 secret between the two ephemeral keys, so a host that has not seen the QR cannot make a valid tag for a key it swapped in. The number still guards against a person who photographed the QR, and against a host that saw the fragment through the browser path (section 2).
2. **The number is derived from the X25519 shared secret and the whole transcript**, not from the keys and secret alone. A party that knows only public values cannot predict it. The reduction to 00 to 99 is pinned (section 5).
3. **`POST /api/link/result` needs the `device_key` sent with the claim.** The plan bound the session token to the device key but still returned the result to anyone holding the QR secret. Now someone who photographed the QR gets nothing from `result`, not even `wrapped_keys`.
4. **Link state lives in server memory, not the database.** A link lasts at most a few minutes; a restart cancels open links.
5. **Three wrong secrets for one link burn it**, in addition to the second-claim rule.
6. **Windows:** claim and approval must both happen within 120 s of start (S-1), and the result must be collected within 60 s of approval.
7. **`wrapped_keys` also carries `recovery_rev` and the showing device's pins** (DM-V1 change 12), so a linked device keeps verifications and cannot be given a swapped peer key on first contact.
8. **A device that is already logged in but has no identity keys uses the same flow** (section 9.3), then replaces its session.
9. **The web client may be the new device but never the showing device** (DM-V1 section 13).
10. **One open link per session.** Starting a new link cancels the session's earlier unclaimed one, so the 60 s QR refresh does not leave old codes alive.
11. **The new device confirms the account after claiming.** The plan showed "Log in as christopher on …?" before anything was sent, but the username is only known from the claim response. The new device now asks "Log in on <host>?" before claiming, then shows the username together with the number.
12. **Every new session on the account raises "New device logged in"** (event `device.added`), not only QR sessions. The Devices list shows `added_via` for each.

## 1. Flow in brief

```
Showing device (logged in)                 Server                         New device
  POST /api/link/start ───────────────────► link_id, secret (120 s)
  make ephemeral a, A
  show QR: https://host/link#hcl1.<link_id>.<secret>.<A>   ──camera──►   parse; "Log in on host?" → Continue
                                                                          make ephemeral b, B; device_key
                                                       ◄── POST /api/link/claim {link_id, secret, device_name,
                                                                                 device_key, B, claim_tag}
                                                       ──► { username, display_name }
  poll GET /api/link/{id} ◄── state claimed, B, claim_tag, device_name           show "Log in as christopher" + number
  verify claim_tag; compute number
  "Pixel 9 wants to log in. Does it show 94?"
  Approve: POST /api/link/{id}/approve {wrapped_keys}                      poll POST /api/link/result
                                                       ──► { token, user, expires_at, wrapped_keys }
                                                                          open wrapped_keys; check key; signed in
```

## 2. Threat model

| Adversary | What we stop | What we do not stop | What the user is told |
|---|---|---|---|
| **Someone who photographs the QR** (or reads it over a shoulder or on a screen share) | A photo alone never logs in and never yields keys: the link needs Approve on the showing device, and `result` needs the `device_key` of whoever claimed. If they claim before you, your own claim burns the link for both. If you have not scanned yet, the showing device asks about a number that no device in your hand shows. The QR is blurred until you press "Show my QR code", visible for 60 s, and the link lasts 120 s. | You tapping Approve without looking at the new device's number. | Above the QR: "Anyone who sees this code could try to log in as you. You'll still need to approve it." Approve prompt: "Only approve if the device in your hand shows this number." |
| **Hostile host** | Reading `wrapped_keys`: it is sealed under a key from `X25519(a, b)`, and the host holds neither private key. Swapping the new device's ephemeral key, when the QR was scanned inside the Housecall app: the `claim_tag` fails and the showing device cancels the link. Handing the new device keys that do not belong to the account: the new device checks them against the account's published key. | Logging in as you: the host can always make a session for any account on its own server. That gives it nothing in encrypted DMs (DM-V1). **Browser path:** if the QR was opened with the phone's system camera, the host's `/link` page reads the fragment and learns `A`. A hostile host can then swap `B` with a valid tag, and only the number catches it: 99 in 100 attempts show different numbers. The web client as new device: the host serves its code. | The approve prompt shows the number. Section 10 wording for a failed tag. The `/link` page recommends the app: "For the safest login, scan this code from inside the Housecall app." |
| **Hostile member** | Using someone else's link: they need the secret and the showing device's ephemeral key, which only the QR carries. Approving: only the session that started the link can approve or deny (others get 403). | Nothing further. | Nothing. |
| **Network attacker** | Everything, given TLS. The QR fragment is never sent in an HTTP request. | Seeing that a login happened. | Nothing. |
| **Someone who steals an unlocked device** | Nothing: they can show a QR and approve their own device, copying your keys to it. | That. Revoking the stolen device's session stops it starting links, but a device already linked keeps the keys. | Devices list: "Added by QR from <device name>". DM-V1 section 2: reset your security key. |
| **A lost password** | QR login needs no password, so a device you are still logged in on gets you back in. A password thief cannot use QR login without one of your logged-in devices. | | Log-in screen: "Log in with QR code" next to the password field. |

## 3. QR payload

```
https://<host>/link#hcl1.<link_id>.<secret>.<A>
```

- `<host>`: the showing device's server origin, exactly as the app stores it: scheme, host and optional port, no path or trailing slash. `https`, or `http` only for `localhost`, `127.0.0.1` or `[::1]`.
- `hcl1`: the format version.
- `link_id`: 16 bytes as 32 lowercase hex characters (server-generated).
- `secret`: 32 bytes as b64u, 43 characters (server-generated).
- `A`: the showing device's ephemeral X25519 public key, 32 bytes as b64u, 43 characters. It is generated per link and never sent to the server.

The vector's QR text is 161 characters, which fits QR version 8 at error correction level M. Render with `qrcode-generator`, level M, at least a 4-module quiet zone.

A parser (app camera, deep link handler, `/link` page) must accept only:

- At most 512 characters.
- `<origin>/link#` followed by exactly four `.`-separated fields.
- An origin passing the rule above: `new URL(origin).origin === origin`, so no credentials, path, query or trailing slash.
- A first field of exactly `hcl1`, a link id matching `^[0-9a-f]{32}$`, and strict b64u for the secret and `A` decoding to 32 bytes each.

Anything else gets "This isn't a Housecall login code." See the `qr` negative vectors.

**Deep link** (from the `/link` page's "Open in Housecall"):

```
housecall://link?c=hcl1.<b64u(UTF-8 origin)>.<link_id>.<secret>.<A>
```

Exactly that shape: no other parameter, host, path or fragment, and at most 600 characters. It goes through the same 120 s in-memory inbox as `housecall://invite` (`docs/NATIVE-AUTH.md`): extend `src-tauri/src/scheme_invite.rs` on iOS, the Android intent inbox and `client/src/transport/deepLinks.ts`. Nothing is claimed automatically. The app opens the "Log in on <host>?" screen.

**The `/link` page:** a static page shipped in the client build as `link/index.html` with an external `link.js` (the CSP forbids inline script), served by the existing static directory. `link.js` parses `location.hash` with the rules above and shows two buttons: "Open in Housecall" (the deep link) and "Continue in browser" (`/#link=<fragment>`, which the web client reads and then removes from the address bar with `history.replaceState`). If parsing fails, it shows "This isn't a Housecall login code." There is no "Get the app" button (decision 9). The page sends nothing to the server.

## 4. Key schedule

```
a, A = X25519 ephemeral pair of the showing device      (per link, memory only)
b, B = X25519 ephemeral pair of the new device          (per claim, memory only)
ss   = X25519(b, A) = X25519(a, B)                       must not be all zero (refuse small-order keys)
salt = SHA-256("housecall link v1" ‖ link_id (16 raw bytes) ‖ secret (32) ‖ A (32) ‖ B (32))
wrap_key   = HKDF(ss, salt, info = "housecall link v1 wrap",  32)
claim_tag  = HKDF(ss, salt, info = "housecall link v1 claim", 16)
code_bytes = HKDF(ss, salt, info = "housecall link v1 code",  4)
```

Vector values: `salt`, `wrap_key`, `claim_tag`, `code_bytes`, `code = "94"`.

## 5. Confirmation number

```
code = (u32be(code_bytes) mod 100), written as two decimal digits with a leading zero ("00" to "99")
```

The bias from `2^32 mod 100 = 96` is below 2^-25. Examples in `code_reduction_examples`: `00000000 → "00"`, `00000063 → "99"`, `00000064 → "00"`, `ffffffff → "95"`, `12345678 → "96"`. Both devices show the two digits large, side by side with nothing else numeric nearby. The new device shows it as soon as the claim succeeds. The showing device shows it in the approve prompt.

## 6. Claim tag

The new device sends `claim_tag` with the claim. The showing device recomputes it from `a`, the `B` and `claim_tag` the server returned, `link_id`, `secret` and `A`, and compares in constant time. On a mismatch it does not show the approve prompt. It calls `deny`, discards `a`, and shows section 10's "tag failed" text. Vector "claim tag from a server that swapped the claiming key": `presented_tag` ≠ `recomputed_tag`.

## 7. `wrapped_keys`

```
plaintext    = seed (32) ‖ u32be(recovery_rev) ‖ UTF-8 JSON array of pins
wrapped_keys = 0x01 ‖ nonce (24) ‖ AEAD(wrap_key, nonce, plaintext, ad = 0x01 ‖ link_id (16 raw bytes))
```

- `seed` and `recovery_rev` are the showing device's identity (`DM-V1.md` sections 3 and 4). `recovery_rev ≥ 1`.
- Pins: every peer the showing device has in state PINNED (not CHANGED_UNACKNOWLEDGED), across all hosts, as

  ```json
  [ { "origin": "https://housecall.example.test", "user_id": "0f1e…", "identity_key": "<b64u, 87 chars>", "key_rev": 1, "verified": true } ]
  ```

  Pin history is not included. Older peer keys come from the server on the new device (DM-V1 section 10.4).
- Minimum length 79 bytes (empty list `[]`), maximum 65536 bytes. If the pins would exceed it, the showing device drops unverified pins first, then the oldest.
- `wrapped_keys` is `null` only when the showing device has no identity (an account still without keys). Then the new device follows DM-V1 section 11.2.

The new device, after opening it:

1. `GET /api/users/{own id}/keys`. If the host has a key, the derived `identity_key` must equal it, else discard everything and show "The key from your other device doesn't match your account on this server." and stay logged out.
2. If this install already has a different identity: DM-V1 section 11.4.
3. Store `{seed, recovery_rev}` in secure storage (memory on web), merge pins (existing local pins win; a conflicting incoming pin is dropped and the peer is fetched normally), and run DM-V1 section 11.3 for this host.

## 8. Link state machine (server)

```
            claim ok                approve               result ok
STARTED ───────────────► CLAIMED ──────────────► APPROVED ─────────────► BURNT (used)
   │  ▲                     │  │                    │
   │  └ wrong secret (<3)   │  └ deny ──► DENIED     ├ claim again ──► BURNT (double_claim)
   │                        └ claim again ──► BURNT (double_claim)
   ├ deny (cancel) ──► DENIED                        └ 60 s after approval ──► EXPIRED
   ├ 3rd wrong secret ──► BURNT (wrong_secret)
   └ now ≥ expires_at (start + 120 s), from STARTED or CLAIMED ──► EXPIRED
```

- DENIED, EXPIRED and BURNT are terminal. The entry stays in memory for 10 minutes after it ends, so `GET` can report the outcome, and is then removed (requests for it then get 404).
- "claim again" means any claim with a correct secret while CLAIMED or APPROVED. It burns the link, and that claim and every later request get 409. A `result` call by the first claimer also gets 409 from then on.
- Wrong secrets count in any non-terminal state. They never reveal state: 404, same code path.
- Starting a new link from a session moves that session's STARTED link (if any) to DENIED.

## 9. Client rules

### 9.1 Showing device

- Native app only, signed in, and holding the identity (or the account has no keys anywhere).
- Settings → "Log in with QR code". The QR is rendered blurred with "Show my QR code". After it is pressed, the QR is sharp for 60 s, then blurred again, and the next press starts a new link. Leaving the screen calls `deny` on an unclaimed link.
- Poll `GET /api/link/{id}` every 2 s while the screen is open. On CLAIMED: check the tag (section 6), compute the number, show "<device_name> wants to log in. Does it show **94**?" with "Approve" and "Deny". `device_name` is shown as text, at most 80 characters, after the server's filter.
- Approve: build `wrapped_keys` with a fresh random nonce and `POST …/approve`. Then discard `a`, `wrap_key` and the plaintext. The screen shows "Pixel 9 is now logged in."
- `a` lives in memory only and is discarded on approve, deny, expiry or leaving the screen.

### 9.2 New device

- Log in → "Log in with QR code" → short explainer ("On a device where you're already logged in, open Settings → Log in with QR code") → "Scan QR code". This opens the camera preview from `SnapCamera` with `jsqr`. If camera permission is refused: "Housecall needs the camera to scan the code. You can also log in with your password."
- After a valid scan or deep link: "Log in on housecall.littleobelisk.com?" with "Continue" and "Cancel".
- Continue: generate `b`, `B`, and `device_key` (32 random bytes as 64 lowercase hex, the same format as today's server-made device keys). Compute `claim_tag` and claim.
- On 200: "Log in as christopher?" with the number, "Check that your other device shows 94, then tap Approve there", and "Cancel". Poll `POST /api/link/result` every 2 s.
- On 200 from `result`: store the session `{token, device_key, username, expires_at}` exactly as a password login does (`secureSession` on native, memory on web). Then handle `wrapped_keys` (section 7).
- Cancel at any point: forget `b`, `device_key` and the secret, and stop polling. The link then expires or is denied. Without the `device_key`, nobody can collect the result.
- Error mapping: 404 or 400 on claim: "This code didn't work. Make a new one on your other device." 410: "This code expired. Make a new one on your other device." 409: "This code was used by another device too, so it was cancelled for safety. Make a new one." 403 from result: "Your other device said no."

### 9.3 Already logged in, no keys (DM-V1 section 11.2)

The "Scan a QR code from a device where you're logged in" option runs 9.2 against the same host. On success the client stores the new session, revokes its old one (`DELETE /api/devices/{old session id}` using the new session), and continues with the keys.

### 9.4 Web client

It may act as the new device (webcam scan, or "Continue in browser" from `/link`). The session and keys live in memory only. It never shows the "Log in with QR code" settings screen and never approves.

## 10. Wording

| Moment | Text |
|---|---|
| Above the blurred QR | "Anyone who sees this code could try to log in as you. You'll still need to approve it." Button: "Show my QR code" |
| Approve prompt (showing device) | "Pixel 9 wants to log in. Does it show **94**?" Buttons "Approve", "Deny". Small print: "Only approve if the device in your hand shows this number." |
| Tag failed (showing device) | "A device tried to use this code without scanning it, so it was cancelled. If this keeps happening, your server may be interfering with logins." |
| Link burnt (showing device) | "This code was used by two devices, so it was cancelled. Make a new one." |
| Expired (showing device) | "This code expired." Button "Make a new code" |
| Every other device of the account, on `device.added` | "New device logged in: Pixel 9. If this wasn't you, log it out in Settings → Devices." |
| Devices list, per session (`added_via`) | "Added with your password", "Added by QR code", "Added with an invite", "Added with a passkey", "Added when the server was set up", or nothing for older sessions |

## 11. Server rules

### 11.1 Storage

`AppState.links: Arc<Mutex<HashMap<String, Link>>>`, keyed by `link_id` hex. Each entry holds:

- `user_id` and `session_id` (the starter)
- `secret_hash` (SHA-256 of the 32 raw secret bytes)
- `state`, `burn_reason`, `created_at`, `expires_at`
- the claim: `device_name`, `device_key_hash` (the existing `hash()` of the 64-hex string), `ephemeral_pub`, `claim_tag`, `claimed_at`
- `wrapped_keys`, `approved_at`, `wrong_secrets`

There is no database table. At most 1000 entries: sweep ended ones first, then answer `start` with 503 `try again later`. Raw secrets and raw device keys are never stored.

### 11.2 Validation

- `link_id`: `^[0-9a-f]{32}$`.
- `secret`: strict b64u decoding to 32 bytes.
- `device_key`: `^[0-9a-f]{64}$`.
- `device_name`: 1 to 80 bytes after trimming, rejected if it contains control or bidirectional-override characters (reuse the `invisible` filter in `server/src/profile.rs`).
- `ephemeral_pub`: strict b64u, 32 bytes, not all zero.
- `claim_tag`: strict b64u, 16 bytes.
- `wrapped_keys`: `null`, or strict b64u decoding to 79 to 65536 bytes with byte 0 `0x01`.

Any failure gives 400 `invalid link request`.

### 11.3 Constant-time comparisons

Look up by `link_id` only. Compute SHA-256 of the presented secret, and compare the 32-byte digests with a branch-free XOR fold (`fn ct_eq(a: &[u8; 32], b: &[u8; 32]) -> bool`). No new crate is needed. When `link_id` is unknown, compare against a fixed dummy digest and return the same 404 through the same path. `device_key` hashes are compared the same way. Hash-then-compare plus the fold means response time does not depend on how many bytes match.

### 11.4 Sessions

`result` creates a session like `session()` in `server/src/lib.rs`, except:

- `device_hash` is the stored claim hash, not a fresh key.
- The response has no `device_key`.
- `added_via = 'qr'`.
- `device_name` comes from the claim.

The same 30-day lifetime applies. Emit `device.added` `{ "session_id", "device_name", "added_via" }` to the account's user events on **every** session creation (setup, login, invite accept, passkey, QR). `GET /api/devices` entries gain `"added_via"`.

### 11.5 Rate limits

| Route | Limit |
|---|---|
| `POST /api/link/start` | 5 per minute per user (`limited("link-start:<user>", 5)`) |
| `POST /api/link/claim` | `public_limit` bucket `link-claim` (the existing default, 40 per minute server-wide); 3 wrong secrets burn the link |
| `POST /api/link/result` | `public_limit` bucket `link-result`, 600 per minute server-wide, and 60 per minute per `link_id` (then 429) |
| `GET /api/link/{id}`, approve, deny | the session's general 600 per minute |

`public_limit` currently maps unknown path endings to one shared `public` bucket. It must map `claim` and `result` under `/api/link/` to their own buckets, so that polling cannot starve sign-in or access requests.

### 11.6 Logging

Info lines:

- `link started user=<id> link=<first 8 hex>`
- `link claimed link=<8>`
- `link approved link=<8>`
- `link denied link=<8>`
- `link expired link=<8>`
- `link burnt link=<8> reason=<double_claim|wrong_secret|used>`
- `qr session created user=<id> session=<id>`

Never log the secret, `device_key`, token, ephemeral keys, `claim_tag`, `wrapped_keys`, device names or IP addresses for these routes, and never log request bodies.

### 11.7 Route inventory

`POST /api/link/claim` and `POST /api/link/result` are added to the `public` set in `server/tests/route_inventory.rs` on purpose. The rest are private.

## 12. API

### `POST /api/link/start` (private)

Request `{}` → 200:

```json
{ "link_id": "8225e96943baf1a9fa848d610f40fac5", "secret": "Md1wbrNp3R2nuCeW2AKVb9CvszgTqK50gmnqdJ86Eg0", "expires_at": 1763049720000 }
```

Errors: 429 `try again later`, 503 `try again later`.

### `POST /api/link/claim` (public)

```json
{ "link_id": "8225e96943baf1a9fa848d610f40fac5", "secret": "Md1wbrNp3R2nuCeW2AKVb9CvszgTqK50gmnqdJ86Eg0",
  "device_name": "Pixel 9", "device_key": "<64 lowercase hex>",
  "ephemeral_pub": "<b64u, 43 chars>", "claim_tag": "<b64u, 22 chars>" }
```

→ 200 `{ "username": "christopher", "display_name": "Christopher" }` (`display_name` may be null). The claim moves the link to CLAIMED.

| Status | Body `error` | When |
|---|---|---|
| 400 | `invalid link request` | validation (11.2) |
| 404 | `not found` | unknown `link_id`, wrong secret, or ended more than 10 minutes ago |
| 410 | `link expired` | EXPIRED, or `expires_at` passed |
| 409 | `link already used` | CLAIMED or APPROVED (and it burns the link), BURNT, DENIED |
| 429 | `try again later` | rate limit |

A disabled account gets 404 `not found`.

### `GET /api/link/{id}` (private; the starting session only)

```json
{ "state": "claimed", "expires_at": 1763049720000, "burn_reason": null,
  "claim": { "device_name": "Pixel 9", "ephemeral_pub": "<b64u>", "claim_tag": "<b64u>", "claimed_at": 1763049650000 } }
```

`claim` is null in STARTED. `state` is one of `started`, `claimed`, `approved`, `denied`, `expired`, `burnt`. `burn_reason` is `double_claim`, `wrong_secret` or `used` when burnt. Another session, even of the same user: 403 `forbidden`. Unknown: 404.

### `POST /api/link/{id}/approve` (private; the starting session only)

`{ "wrapped_keys": "<b64u>" }` or `{ "wrapped_keys": null }` → 200 `{ "state": "approved" }`.

Errors:

- 400 `invalid link request`
- 403 `forbidden` (another session)
- 404
- 409 `link is not waiting for approval` (not CLAIMED)
- 410 `link expired`

### `POST /api/link/{id}/deny` (private; the starting session only)

`{}` → 200 `{ "state": "denied" }`. Allowed from STARTED (cancel) and CLAIMED. Otherwise 409 `link is not waiting for approval`.

### `POST /api/link/result` (public)

`{ "link_id": "…", "secret": "…", "device_key": "<the claim's device_key>" }` → 200:

```json
{ "token": "<64 lowercase hex>", "user": { "id": "…", "username": "christopher", "is_owner": false },
  "expires_at": 1765641720000, "wrapped_keys": "<b64u or null>" }
```

The link becomes BURNT (`used`) in the same step: a second `result` gets 409.

| Status | `error` | When |
|---|---|---|
| 404 | `not found` | unknown, wrong secret, wrong `device_key`, no claim yet by this key |
| 409 | `waiting for approval` | CLAIMED (keep polling) |
| 409 | `link already used` | BURNT |
| 403 | `link denied` | DENIED |
| 410 | `link expired` | EXPIRED |
| 429 | `try again later` | rate limit |

## 13. Client module map

`client/src/crypto/link.ts` holds pure functions over `Uint8Array`, with no network or DOM access:

- `formatQr(origin, linkId, secret, showingPub) → string`
- `formatDeepLink(...) → string`
- `parseQr(text)` and `parseDeepLink(text) → { origin, linkId, secret, showingPub }`, which throw on anything section 3 rejects
- `newEphemeral() → { priv, pub }`
- `linkKeys({ linkId, secret, showingPub, claimingPub, sharedSecret }) → { wrapKey, claimTag, code }`
- `sealWrappedKeys(wrapKey, linkId, seed, recoveryRev, pins)` and `openWrappedKeys(wrapKey, linkId, blob) → { seed, recoveryRev, pins }`
- `ctEqual(a, b)`

`client/tests/link.test.ts` runs every positive and negative vector in `link-v1.json`.

The flow itself (polling, screens, session storage) lives in `client/src/core/` (interface), `client/src/adapters/legacy/` (REST calls for the routes above) and `client/src/transport/deepLinks.ts` (scheme). Copy goes in `client/src/ui/copy.ts`.

Server tests (`server/tests/link.rs`, PLAN C1):

- expired → 410
- wrong secret → 404, same path as an unknown id
- double claim → 409 and burnt, and the first claimer's `result` → 409
- three wrong secrets → burnt
- approve or `GET` from another session → 403
- result before approval → 409 `waiting for approval`
- result with the wrong `device_key` → 404
- the token works only with the claimed device key
- start limit → 429
- `device.added` is emitted
- the starting session's second `start` cancels the first link
- no secret appears in the captured logs

E2E: two browser contexts complete the flow by passing the QR text directly (no camera).

## 14. Known limits

1. A person who taps Approve without comparing the number lets a QR photographer in (and gives them the keys). The number makes that a deliberate mistake, not an accident.
2. The browser path (system camera → `/link` page) lets a hostile host see `A`; against such a host, only the number protects, with a 1 in 100 chance of a lucky match per attempt and a visible mismatch otherwise.
3. The host can always create sessions for accounts on its own server. QR login protects your keys, not the host's control over its own accounts.
4. A stolen unlocked device can link a new device and copy your keys.
5. Link state is lost on server restart (open links fail; users make a new code).
