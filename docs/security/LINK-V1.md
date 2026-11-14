# LINK-V1: QR login and device linking (Housecall 0.4.0)

Status: contract for implementation. Nothing here is built yet. Reviewed on paper by an attacker session (`REVIEW-0.4.0.md`; fixes folded in and marked R-n), attacked live afterwards (PLAN C6).

What it does: a device where you are logged in (the **showing device**) displays a QR code. A second device (the **new device**) scans it and shows a two-digit number. You type that number on the showing device and confirm with the phone's unlock (or your password on a computer). The new device is then logged in, and it receives your identity keys (`DM-V1.md` section 3) sealed so that only it can open them.

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

Changes from the paper review (`REVIEW-0.4.0.md`). These strengthen S-1; none weakens it.

13. **The deep link carries no login code** (R-0, critical). The `/link` page is the host's code. If it hands the app `housecall://link?c=…<A>`, it can put its own key in place of `A`. It then knows both shared secrets and tries claiming keys until both devices show the same number: about 100 offline tries, with a valid `claim_tag`, every time. "Open in Housecall" now opens the app's scanner (`housecall://link-scan`) and the person scans the code again inside the app. The app refuses every `housecall://link?…` URL.
14. **The person types the number; nothing to compare or tap through** (R-5, answers the open question that was section 15). The showing device does not display the number. It asks "Type the number shown on Pixel 9", and one wrong entry denies the link.
15. **Approving needs user verification** (R-6): the phone's own unlock (Face ID, fingerprint or device passcode) on iOS and Android, the account password on desktop. Without it a thief with an unlocked phone could copy the key to their own device with no password, while "View recovery key" needs one.
16. **Pins in `wrapped_keys` carry their full key history** (R-11, DM-V1 R-1). The format changed: each pin has `history`.
17. **No code passes through the OS scheme handler** (R-10, follows from item 0), so another app that registered `housecall://` gets nothing from it.
18. **Browser warnings** (R-4): approving a browser and continuing in a browser both say that the host could keep the key.
19. **The `/link` page removes the code from the address bar and history before anything else** (R-15), and the QR screen warns against showing the code to anyone who asks for it (R-14).

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
  poll GET /api/link/{id} ◄── state claimed, B, claim_tag, device_name           show "Log in as christopher" + number 94
  verify claim_tag; compute number (not shown)
  "Type the number shown on Pixel 9" → person types 94
  typed = number? else deny
  unlock (Face ID / passcode, or password on desktop)
  POST /api/link/{id}/approve {wrapped_keys}                               poll POST /api/link/result
                                                       ──► { token, user, expires_at, wrapped_keys }
                                                                          open wrapped_keys; check key; signed in
```

## 2. Threat model

| Adversary | What we stop | What we do not stop | What the user is told |
|---|---|---|---|
| **Someone who photographs the QR** (or reads it over a shoulder or on a screen share) | A photo alone never logs in and never yields keys: the link needs the right number typed on the showing device, and `result` needs the `device_key` of whoever claimed. If they claim before you, your own claim burns the link for both. If you have not scanned yet, the showing device asks you to type a number that no device in your hand shows, so you cannot approve by habit. A guessed number is right 1 time in 100 and one wrong entry denies the link. The QR is blurred until you press "Show my QR code", visible for 60 s, and the link lasts 120 s. | You reading the number off the photographer's screen, or being talked into typing a number someone tells you (section 14 item 1). | Above the QR: "Anyone who sees this code could try to log in as you. Never show it to someone who asks for it: Housecall and your host never will." Approve prompt: "Type the number shown on the device in your hand." |
| **Hostile host** | Reading `wrapped_keys`: it is sealed under a key from `X25519(a, b)`, and the host holds neither private key. Swapping the new device's ephemeral key when the QR is scanned inside the Housecall app, which is the only way a native app logs in by QR: the `claim_tag` fails and the showing device cancels the link (the host would have to guess a 128-bit tag). Getting between the two devices through the `/link` page: the page cannot pass a code to the app (section 3, R-0). Handing the new device keys that do not belong to the account: the new device checks them against the account's published key. | Logging in as you: the host can always make a session for any account on its own server. That gives it nothing in encrypted DMs (DM-V1). **The web client as new device** ("Continue in browser", or the web client's own scanner): the host serves its code, sees `A`, and gets the key if you approve; the number cannot help, because the host controls the page that shows it (DM-V1 section 13). | Section 10 wording for a failed tag and a wrong number. The `/link` page says: "To log in to the Housecall app, open it and scan this code again from there." Approving and continuing in a browser both warn that the host could keep the key. |
| **Hostile member** | Using someone else's link: they need the secret and the showing device's ephemeral key, which only the QR carries. Approving: only the session that started the link can approve or deny (others get 403). | Nothing further. | Nothing. |
| **Network attacker** | Everything, given TLS. The QR fragment is never sent in an HTTP request. | Seeing that a login happened. | Nothing. |
| **Someone who steals an unlocked device** | Approving a link of their own: approve needs the phone's own unlock (Face ID, fingerprint or passcode) at that moment, or the account password on a computer (section 9.1, R-6). | A thief who knows the phone's passcode, or the computer's account password. Revoking the stolen device's session stops it starting links, but a device already linked keeps the keys. | Devices list: "Added by QR code". DM-V1 section 2: reset your security key. |
| **A malicious app on the new phone** (registered for `housecall://`) | Taking the code: no code ever goes through the scheme (section 3, R-10). It can only receive `housecall://link-scan`, which carries nothing. | Pretending to be Housecall when "Open in Housecall" is tapped, showing a fake scanner. It would then have the code from its own camera, like a photographer, and the typed number and approval rules apply. | Nothing new. |
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

A parser (app camera, web client scanner, `/link` page) must accept only:

- At most 512 characters.
- `<origin>/link#` followed by exactly four `.`-separated fields.
- An origin passing the rule above: `new URL(origin).origin === origin`, so no credentials, path, query or trailing slash.
- A first field of exactly `hcl1`, a link id matching `^[0-9a-f]{32}$`, and strict b64u for the secret and `A` decoding to 32 bytes each.

Anything else gets "This isn't a Housecall login code." See the `qr` negative vectors.

**Deep link** (from the `/link` page's "Open in Housecall"):

```
housecall://link-scan
```

Exactly that text. It carries **no code** (R-0). The app opens Log in → "Log in with QR code" → the scanner, with the line "Scan the code on your other device again." The person scans the same QR (it is still on the other screen) inside the app.

Why not pass the code along: the `/link` page is the host's code. Given `housecall://link?c=…<A>`, a hostile host replaces `A` with its own key `A₂`. It then knows the shared secret with the new device (`X25519(a₂, B)`), so it knows the number the new device will show. It claims the real link with a key `B₃` and a valid tag (it knows `A`), and tries new `B₃` values offline until the showing device's number is the same. That takes about 100 X25519 operations (vector `deep_link_mitm` finds one in 12) and works every time, so the typed number protects nothing. With an in-app scan, `A` goes from screen to camera and the host never sees it.

Parsers refuse every other `housecall://link…` form, including the pre-review `housecall://link?c=…` (vectors `deep_link`). `link-scan` goes through the same in-memory inbox as `housecall://invite` (`docs/NATIVE-AUTH.md`): extend `src-tauri/src/scheme_invite.rs` on iOS, the Android intent inbox and `client/src/transport/deepLinks.ts`.

**The `/link` page:** a static page shipped in the client build as `link/index.html` with an external `link.js` (the CSP forbids inline script), served by the existing static directory. `link.js` first copies `location.hash` into a variable and calls `history.replaceState(null, "", "/link")`, so the code does not stay in the address bar or the tab's history entry (R-15). Some browsers record the full URL in their global history before any script runs; that copy cannot be removed by the page. It is worth no more than a photo of the QR, which section 2 already covers, and it is dead after 120 s. It then parses the copied value with the rules above and shows two buttons: "Open in Housecall" (`housecall://link-scan`, with the line "Then scan this code again from inside the app.") and "Continue in browser" (`/#link=<fragment>`, which the web client reads and then removes from the address bar with `history.replaceState`). If parsing fails, it shows "This isn't a Housecall login code." There is no "Get the app" button (decision 9). The page sends nothing to the server. Under "Continue in browser" it says: "A browser loads Housecall from this server, so whoever runs it could keep a copy of your security key. The app doesn't have this risk."

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

The bias from `2^32 mod 100 = 96` is below 2^-25. Examples in `code_reduction_examples`: `00000000 → "00"`, `00000063 → "99"`, `00000064 → "00"`, `ffffffff → "95"`, `12345678 → "96"`.

**The person types it; nothing is compared by eye** (R-5). The new device shows the two digits large, with nothing else numeric nearby, as soon as the claim succeeds: "Type this number on your other device: **94**". The showing device never displays the number. Its approve prompt is a two-digit numeric field: "Type the number shown on Pixel 9". Matching is `typed.trim()` is exactly two ASCII digits and equal to `code`, compared with `ctEqual` (vectors `typed_code_examples`). On a match the device asks for user verification (9.1) and approves. On any mismatch it calls `deny` at once, with no second try, and shows the "Numbers didn't match" text (section 10).

Why typing: with "Does it show 94? Approve / Deny", a person who taps Approve out of habit approves a photographer or a swapped key every time. With typing, they cannot approve without reading a number off a device, and a device that is not in their hand shows them nothing.

**What each attacker gets per attempt.**

- **Hostile host, in-app scan** (every native login): the host never sees `A`, so to swap `B` it must guess a 16-byte `claim_tag`: `2^-128`. The number is not what stops it.
- **A host that knows `A` but not the new device's key** (it read the QR somehow, for example a screen share it relays): its claim with its own `B'` carries a valid tag. The person types the honest device's number `n`, from `X25519(b, A)`, and the showing device compares it with `n'`, from `X25519(a, B')`. The host does not know `b`, so it cannot predict `n` or search for a `B'` that matches. The two numbers are independent and nearly uniform, so one attempt succeeds with probability `Σ P(n = k)·P(n' = k) = 1/100 + ε`, with `ε < 2^-50` from the reduction bias. If the host also controlled what the new device thinks `A` is, it would know `n` and win every time (R-0); that is why no path lets the host hand `A` to the app.
- **A photographer**: has their own device's number but you have no device showing it. If you type a number from a device in your hand, it is the wrong one (or the link already burned on double claim). A blind guess by you is right 1 in 100.
- **Web client as new device**: the host serves the new device's code, so it controls both the number shown there and the key it receives. The number gives no protection against the host here; the browser warning is the only protection (DM-V1 section 13).

**What limits attempts:** every attempt needs the person to start a new link and scan again (single use, at most 5 starts per minute per user, 120 s each). A failed attempt ends in the visible "Numbers didn't match" text, which names server interference as a cause. There is no automatic retry and no second try within a link. Three digits would cut the 1/100 to 1/1000. S-1 fixes two digits, and the review keeps two: the host's realistic attack is now stopped by the tag (`2^-128`), and typing removes the habit-approval case, which was the realistic attack on people.

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
  [ { "origin": "https://housecall.example.test", "user_id": "0f1e…", "identity_key": "<b64u, 87 chars>", "key_rev": 2, "verified": true,
      "history": [ { "key_rev": 1, "identity_key": "<b64u>" }, { "key_rev": 2, "identity_key": "<b64u>" } ] } ]
  ```

  `history` is the pin's full history (DM-V1 section 10.1), revisions strictly ascending, no key at two revisions, ending with the pin's own `key_rev` and `identity_key` (R-11). The earlier text left history out and let the new device fetch older keys from the server, which is exactly the forged-old-revision attack of DM-V1 R-1 on every newly linked device.
- The new device validates every pin (origin as in section 3, `user_id` 1 to 128 bytes, `key_rev ≥ 1`, `verified` boolean, every key valid per DM-V1 section 3.3, the history rules above). If any pin fails, it refuses the whole blob, stores nothing, and shows "The key from your other device couldn't be read. Make a new code and try again." (vectors "wrapped_keys: pin …"). The blob is authenticated, so a bad pin means a bug on the showing device, not an attack; refusing it keeps the bug visible.
- Minimum length 79 bytes (empty list `[]`), maximum 65536 bytes. If the pins would exceed it, the showing device drops unverified pins first, then the oldest. A dropped pin is a first contact on the new device.
- `wrapped_keys` is `null` only when the showing device has no identity (an account still without keys). Then the new device follows DM-V1 section 11.2.

The new device, after opening it:

1. `GET /api/users/{own id}/keys`. If the host has a key, the derived `identity_key` must equal it, else discard everything and show "The key from your other device doesn't match your account on this server." and stay logged out.
2. If this install already has a different identity: DM-V1 section 11.4.
3. Store `{seed, recovery_rev}` in secure storage (memory on web), merge pins (existing local pins win; a conflicting incoming pin is dropped and the peer is fetched normally), and run DM-V1 section 11.3 for this host.
4. On the web client only, call `POST /api/me/key-exposure` `{ "kind": "browser" }` (DM-V1 section 13).

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
- The QR screen sets the OS no-screenshot flag where it exists (Android `FLAG_SECURE`; on iOS hide the QR when a screen recording or mirroring starts). This lowers the chance of the code ending up in a screen share or screenshot; it is not relied on.
- Poll `GET /api/link/{id}` every 2 s while the screen is open. On CLAIMED: check the tag (section 6) and compute the number, but **do not show it**. Show the approve prompt (section 10): "<device_name> wants to log in" with a two-digit numeric field "Type the number shown on <device_name>", a "Deny" button, and the browser line. `device_name` is shown as text, at most 80 characters, after the server's filter; it is chosen by the claimer and proves nothing.
- Typed number (section 5): a mismatch calls `deny` at once and shows "Numbers didn't match". A match goes on to user verification.
- **User verification before approve** (R-6). iOS and Android: the OS device-owner check with passcode fallback (`tauri-plugin-biometric` `authenticate` with `allowDeviceCredential: true`), reason text "Approve logging in on Pixel 9". Desktop: the account password, checked with `POST /api/me/password-check` (DM-V1 16.4). If the check is cancelled or fails, nothing is sent and the prompt stays until expiry or Deny. If the phone has no passcode set at all, the password is asked instead.
- Approve: build `wrapped_keys` with a fresh random nonce and `POST …/approve`. Then discard `a`, `wrap_key` and the plaintext. The screen shows "Pixel 9 is now logged in."
- `a` lives in memory only and is discarded on approve, deny, expiry or leaving the screen.
- Android: the numeric field and the Deny button use `filterTouchesWhenObscured`, so an overlay app cannot tap through them (tapjacking). With typing plus OS verification, an overlay could not complete an approval anyway; this removes the remaining nuisance.

### 9.2 New device

- Log in → "Log in with QR code" → short explainer ("On a device where you're already logged in, open Settings → Log in with QR code") → "Scan QR code". This opens the camera preview from `SnapCamera` with `jsqr`. If camera permission is refused: "Housecall needs the camera to scan the code. You can also log in with your password."
- `housecall://link-scan` opens this scanner directly (section 3). It never carries a code.
- After a valid scan: "Log in on housecall.littleobelisk.com?" with "Continue" and "Cancel".
- Continue: generate `b`, `B`, and `device_key` (32 random bytes as 64 lowercase hex, the same format as today's server-made device keys). Compute `claim_tag` and claim.
- On 200: "Log in as christopher?" with the number large, "Type this number on your other device: **94**", and "Cancel". Poll `POST /api/link/result` every 2 s.
- On 200 from `result`: store the session `{token, device_key, username, expires_at}` exactly as a password login does (`secureSession` on native, memory on web). Then handle `wrapped_keys` (section 7).
- Cancel at any point: forget `b`, `device_key` and the secret, and stop polling. The link then expires or is denied. Without the `device_key`, nobody can collect the result.
- Error mapping: 404 or 400 on claim: "This code didn't work. Make a new one on your other device." 410: "This code expired. Make a new one on your other device." 409: "This code was used by another device too, so it was cancelled for safety. Make a new one." 403 from result: "Your other device said no."

### 9.3 Already logged in, no keys (DM-V1 section 11.2)

The "Scan a QR code from a device where you're logged in" option runs 9.2 against the same host. On success the client stores the new session, revokes its old one (`DELETE /api/devices/{old session id}` using the new session), and continues with the keys.

### 9.4 Web client

It may act as the new device (webcam scan, or "Continue in browser" from `/link`). The session and keys live in memory only. It never shows the "Log in with QR code" settings screen and never approves.

Before claiming, the web client shows the browser notice (R-4): "This browser loads Housecall from <host>. If you log in here with a QR code, your security key comes to this browser, and whoever runs <host> could keep a copy and read your encrypted DMs from now on. Only continue if you trust them." Buttons "Continue" and "Cancel". After it opens `wrapped_keys`, it reports the exposure (section 7 step 4). A hostile host's modified client would skip both; they protect people from an honest host's mistakes and give honest records, nothing more.

## 10. Wording

| Moment | Text |
|---|---|
| Above the blurred QR | "Anyone who sees this code could try to log in as you. Never show it to someone who asks for it: Housecall and your host never will." Button: "Show my QR code" |
| Approve prompt (showing device) | Title "Pixel 9 wants to log in". Field label "Type the number shown on Pixel 9". Button "Deny". Small print: "Approving gives that device your security key. If it's a web browser, whoever runs the server could keep a copy." The number itself is never shown here. |
| User verification reason (OS prompt) | "Approve logging in on Pixel 9" |
| Numbers didn't match (showing device) | "The numbers didn't match, so the login was cancelled. If you typed the number correctly, someone else may have used this code or your server may be interfering with logins." Button "Make a new code" |
| New device, after claim | "Log in as christopher?" "Type this number on your other device: **94**" Button "Cancel" |
| `/link` page | "Open in Housecall" with "Then scan this code again from inside the app." and "Continue in browser" with the browser sentence (section 3) |
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
- `parseQr(text) → { origin, linkId, secret, showingPub }`, which throws on anything section 3 rejects
- `parseDeepLink(text) → { action: "scan" }`, which accepts only `housecall://link-scan` and throws on everything else, including any `housecall://link?…`
- `newEphemeral() → { priv, pub }`
- `linkKeys({ linkId, secret, showingPub, claimingPub, sharedSecret }) → { wrapKey, claimTag, code }`
- `typedCodeMatches(typed, code) → boolean` (section 5, `typed_code_examples`)
- `sealWrappedKeys(wrapKey, linkId, seed, recoveryRev, pins)` and `openWrappedKeys(wrapKey, linkId, blob) → { seed, recoveryRev, pins }`, which runs `validatePins`
- `validatePins(pins)` (section 7)
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

E2E: two browser contexts complete the flow by passing the QR text directly (no camera), with the number read from the new device's page and typed into the showing device's field. The E2E harness stubs user verification; that stub must exist only in the test build.

## 14. Known limits

1. A person who is talked into typing a number someone else reads out, or who reads it off a stranger's screen, lets that person in (and gives them the keys). Typing makes that a deliberate act, not a habit tap, and the phone's unlock is asked as well.
2. Logging in to the **web client** by QR gives the key to whatever code the host served. Against a dishonest host the number does not help (section 5). The warnings and the exposure record (DM-V1 section 13) are the only measures.
3. The host can always create sessions for accounts on its own server. QR login protects your keys, not the host's control over its own accounts.
4. A thief who has your unlocked phone **and** its passcode, or your computer and your password, can link a new device and copy your keys.
5. Link state is lost on server restart (open links fail; users make a new code).
6. Logging in to the app from the system camera takes two scans: the `/link` page sends you to the app's scanner rather than passing the code (R-0).
7. A dishonest host can fake "New device logged in" notices or hide them. They are for honest hosts.

## 15. Open question for the security owner (resolved)

The earlier text asked whether to replace "Does it show 94? Approve / Deny" with picking the number among three. The review chose typing the number instead (section 5, R-5). Typing is strictly stronger than both: a habit tapper cannot approve without reading a number off a device, and a blind attempt succeeds 1 time in 100 rather than 1 in 3. It changes only the UI; the server and the byte formats stay the same.

## 16. Implementer traps

The mistakes most likely to be made building this, each with the test that catches it. Vectors are in `client/tests/vectors/link-v1.json`.

| # | Trap | Test that catches it |
|---|---|---|
| 1 | Bringing back a deep link that carries the code ("it saves a scan"). | Vectors `deep_link` and `deep_link_mitm`: `parseDeepLink` throws on every `housecall://link?…`. A unit test on `deepLinks.ts` asserts no route for `link?c=`. |
| 2 | Showing the number on the showing device "to help", or an Approve button next to the field. | Component test of the approve prompt: the rendered text does not contain the code, and the only enabled actions are the numeric field and Deny. |
| 3 | Allowing a second typed attempt, or comparing with `==` after `parseInt` (so `"094"`, `"9 4"` or `" 94"` with odd spaces pass, or Arabic-Indic digits do). | `typed_code_examples`: `"940"`, `"9"`, `"٩٤"` and `""` deny; a flow test asserts `deny` is called after one mismatch. |
| 4 | Skipping the `claim_tag` check, or checking it after the prompt is shown. | Vector "claim tag from a server that swapped the claiming key": the flow test feeds that claim and asserts `deny` is called and no prompt is rendered. |
| 5 | Sending `wrapped_keys` before user verification resolves, or treating a cancelled OS prompt as success. | Flow test with the verification stub returning cancelled: no `approve` request is made. |
| 6 | Opening `wrapped_keys` and storing the seed before checking it against the account's published key, or merging pins before validating all of them. | Vectors "wrapped_keys: pin …" reject the whole blob; a flow test with a seed whose key differs from `GET /api/users/{own id}/keys` stores nothing. |
| 7 | Dropping pin `history` when building `wrapped_keys` (the old format), so the linked device fetches old keys from the server. | `validatePins` rejects a pin without `history` (vector "pin without history"); a round-trip test seals the showing device's real pin store and compares histories. |
| 8 | Server: comparing the secret or device key with `==` on strings, or looking up by secret. | `server/tests/link.rs`: wrong secret and unknown id both 404 through the same function (assert by a counter on the dummy compare); code review for `ct_eq`. |
| 9 | Server: storing the raw secret, device key or `wrapped_keys` longer than needed, or logging any of them. | `server/tests/link.rs` "no secret appears in the captured logs", extended to `device_key`, `claim_tag` and `wrapped_keys`; `wrapped_keys` is cleared from the entry when `result` succeeds. |
| 10 | Server: `public_limit` still mapping `/api/link/claim` and `/result` to the shared `public` bucket. | `server/tests/link.rs`: 600 result polls do not make `POST /api/login` return 429. |
| 11 | Leaving the QR code in the address bar of `/link` or the web client (`/#link=…`). | E2E (UI lane): after load, `location.href` has no `#hcl1` and no `#link=`. |
| 12 | Not blurring the QR again after 60 s, so the code stays on screen while nobody is looking. | Component test with fake timers: at 60 s the QR is blurred and the link id changes on the next "Show my QR code". |
| 13 | Letting the web client reach the showing-device screen through a direct route. | Route test in the web build: the settings entry is absent and the route renders the "Use the Housecall app" text. |
