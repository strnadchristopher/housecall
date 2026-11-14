# Paper review of DM-V1 and LINK-V1 (Housecall 0.4.0)

Scope: `DM-V1.md` (end-to-end encrypted 1:1 DMs) and `LINK-V1.md` (QR login and device linking), as written before any code. The reviewer did not write either contract. Method: play each attacker in the two threat models (hostile host, hostile member, QR photographer, thief with a device, malicious app on the phone) and try each attack on paper against the exact byte formats and client rules. PLAN section 0 (S-1 to S-5) is binding; every fix below keeps or strengthens it. Where a fix departs from the literal words of S-1 (R-5), it is stronger than what S-1 asks for, and the reason is given.

Every finding is fixed in the contracts, and each fix is marked `R-n` there. Where a format changed, `client/scripts/security-vectors.mjs` was updated, the vectors regenerated (`client/tests/vectors/dm-v1.json`, `link-v1.json`), and a negative vector added for the attack.

Severity: **Critical** = a hostile party reads or takes over DMs or keys with no mistake by the user. **High** = the same, given a likely user action or one common situation. **Medium** = integrity or confusion that misleads a user, or a defence that relies on wording that was wrong. **Low** = hardening; the attack needs a separate failure.

## Summary

| # | Severity | Contract | Finding | Fixed in |
|---|---|---|---|---|
| R-0 | Critical | LINK | The code-carrying deep link lets the host swap `A` and grind the two-digit number | LINK 3, changes 13 |
| R-1 | High | DM | Host forges a peer's key for an old revision; the client fetched missing revisions from the server | DM 6.3 step 4, 10.1, 10.4 |
| R-2 | High | DM | Host inserts `enc = 0` rows into an encrypted DM; shown under the lock | DM 10.7 |
| R-3 | High | DM | Host re-serves a stolen, superseded key or rolls `key_rev` back; user can acknowledge it | DM 10.2, 15.4 |
| R-4 | High | DM, LINK | A browser that receives the key hands it to a dishonest host, with no warning | DM 13, LINK 9.1, 9.4 |
| R-5 | High | LINK | "Does it show 94? Approve" is habit-tappable; the number is compared, not entered | LINK 5, 9.1, 10, 15 |
| R-6 | High | LINK | A thief with an unlocked phone copies the identity to their own device with no re-authentication | LINK 9.1 |
| R-7 | Medium | DM | "Replace recovery key" implied that leaked words stop working | DM 4.5, 18 item 13 |
| R-8 | Medium | DM | Host moves a reply to a different message (`reply_to` is clear) | DM 6.1, 10.8 |
| R-9 | High | DM | Hostile member sends a sealed file as `text/html` or `image/svg+xml`; a `blob:` URL runs it with the app's origin | DM 7.3 |
| R-10 | Medium | LINK | Another app registered for `housecall://` receives the login code | LINK 3, changes 17 |
| R-11 | High | LINK | `wrapped_keys` carried pins without history, so every linked device was open to R-1 | LINK 7 |
| R-12 | Medium | DM | Envelopes naming made-up peer `key_rev` values raise "key changed" banners until people tap through | DM 10.2 |
| R-13 | Low | DM | Non-canonical X25519 encodings: two byte strings, one key | DM 3.3, 15.4 |
| R-14 | Low | LINK | "Show me your code" support scam | LINK 10 |
| R-15 | Low | LINK | The code stays in the `/link` page's address bar and history | LINK 3 |
| R-16 | Medium | DM | Two-word confirmation passed by copying the two words just shown | DM 4.4 |
| R-17 | Medium | DM | Payload and FileRef fields not fully validated; malformed values confuse or crash readers | DM 6.1, 7.3 |

## Findings

### R-0 (Critical): the deep link lets the host win the number

Attack, hostile host, person logs in to the app by pointing the system camera at the QR:

1. The QR is `https://<host>/link#hcl1.<id>.<secret>.<A>`. The system camera opens the `/link` page, which is JavaScript the host serves.
2. The pre-review page handed the app `housecall://link?c=…<A>`. A hostile page replaces `A` with its own `A₂` (it generated `a₂`).
3. The new device claims with its `B` and a `claim_tag` computed against `A₂`. The host knows `a₂`, so it knows `X25519(a₂, B)` and the number `n` the new device will show.
4. The host also knows the real `A` (from the fragment the page read) and the secret. It makes claiming keys `B₃` offline, computes `X25519(b₃, A)` and the number the showing device would compute, and stops at one equal to `n`: about 100 tries, a few milliseconds.
5. It submits the real claim with `B₃` and a valid tag (it can compute it). Both devices agree on `n`; the person approves; `wrapped_keys` is sealed to `B₃`. The host opens it and has the seed. It forwards a session to the new device, so nothing looks wrong.

Success probability: about 1 per attempt. The number gives no protection, and the claim tag does not either, because the host knows `A`. Vector `deep_link_mitm` demonstrates the grind.

Fix: the deep link carries no code. "Open in Housecall" opens `housecall://link-scan`, and the app's own scanner reads the QR again. The host never sees `A` on any native path. Parsers reject every `housecall://link?…` form (vectors `deep_link`).

### R-1 (High): forged key for an old revision

Attack, hostile host:

1. alice has pinned bob at `key_rev 2`. Messages from bob under `key_rev 1` predate her pin, or she gets a new device.
2. The pre-review rule fetched the peer's key for an unknown revision from `GET /api/users/{id}/keys` and used it.
3. The host returns its own key for bob at revision 1, and stores envelopes it sealed (as "bob", revision 1) to alice. They decrypt and show as bob's, with the lock.

Fix: the pin keeps `history`. At first contact every listed revision is pinned at once (trust on first use, stated in known limit 3). After that the history is closed: no revision at or below the pinned `key_rev` is ever added, and keys for old messages come only from the pin. Negative vectors: "server inserts a forged older revision that the pin never saw", "server rewrites a pinned historical revision".

### R-2 (High): plaintext under the lock

Attack, hostile host: the server refuses `enc = 0` in an encrypted DM (S-4), but the host does not have to obey its own server. It inserts a row with `enc = 0`, `author_id = bob` and any text. The client showed it as an ordinary message in a conversation labelled "End-to-end encrypted".

Fix: in a DM with a pinned peer, every `enc = 0` message carries "Not encrypted", and the lock is never shown on it.

### R-3 (High): key rollback after a theft

Attack, hostile host or someone who stole a device and colludes with the host:

1. christopher's phone is stolen. He resets: `key_rev 3`.
2. The host serves the stolen key again, as `key_rev 4` or as `key_rev 2`.
3. Pre-review, peers saw an ordinary "key changed", tapped "I understand", and encrypted to the stolen key.

Fix: `key_rev` never goes down, an old revision's key never changes, and a key used at an earlier revision can never be published again (server 409). Any of the three puts the peer in `KEY_ROLLBACK`, which disables the composer and has no "I understand". Vectors: "server rolls the peer back to a lower key_rev", "server reissues a superseded key under a new key_rev".

### R-4 (High): the web client receives the key

Attack, hostile host: serve a modified web client to a user who types the recovery words into a browser, or approves a browser by QR. The modified client sends the seed to the host. From then on the host reads every encrypted DM of that user, on every device and every host, until a reset. Nothing told the user.

What protects against a modified web client: only the "Encrypted in browser" label, the warnings below and TLS to the host. There is no code signing, Subresource Integrity or service-worker pinning, and none would help, because the host serves those too. Native apps are not exposed: they do not load code from the host.

Fix: a notice the person must dismiss before words are typed into a browser and before a browser claims a QR; a line on the approve prompt; `POST /api/me/key-exposure` records the use, and native devices show it under Settings → Security with "reset your security key" advice. Known limit 9 says the same for a peer's browser.

### R-5 (High): habit-approving the number

Attack, photographer or hostile host: S-1 as written shows the number on both devices and asks "Does it show 94?" with Approve and Deny. A person who taps Approve out of habit, or on a phone notification, approves whoever claimed. The comparison only works if the person actually compares.

Fix: the showing device never displays the number. It asks "Type the number shown on Pixel 9"; one wrong entry denies the link. Matching is exact: two ASCII digits after trimming (vectors `typed_code_examples`, including `"٩٤"`, `"940"` and `""`). This is stronger than S-1, not weaker: S-1's purpose (a photo alone is not enough; the user confirms on the old device) holds, and the habit tap is gone. Android uses `filterTouchesWhenObscured`, and there is no Approve button to tapjack.

Two digits, per attempt, after all fixes:

| Attacker | Chance per attempt | What limits attempts |
|---|---|---|
| Hostile host, native app scanning in the app | `2^-128` (it must forge `claim_tag` without `A`) | Not the number |
| Host that learned `A` (relayed screen share) but not the new device's key | 1 in 100: it cannot predict the honest device's number, so it cannot grind | One person-started link per attempt; 5 starts per minute per user; 120 s each; single use; every failure says the server may be interfering |
| Photographer | 1 in 100 only if the person types a guess; a number read off their own device is wrong | Same |
| Hostile host, web client as the new device | No protection: the host runs the new device's code | Only the R-4 warnings |

Three digits would give 1 in 1000. S-1 fixes two; with typing and the visible failure text, a host cannot try silently, so two is kept.

### R-6 (High): thief with an unlocked phone

Attack: take an unlocked phone, open Settings → Link a device, scan with your own phone, read your own number, type it. The identity is now on your device. Pre-review, approval needed no re-authentication, while "View recovery key" needed the password, so the cheaper path to the same secret was open.

Fix: approve needs the phone's own unlock (Face ID, fingerprint or passcode, via `tauri-plugin-biometric` with device-credential fallback) at that moment, or the account password on a computer. A cancelled or failed check sends nothing. Residual, stated in LINK known limit 4: a thief who knows the passcode.

### R-7 (Medium): Replace did not undo leaked words

Attack: someone photographs the 24 words. The owner taps "Replace recovery key", believing that ends it. But the seed is unchanged, and every old `key_backup` sealed with the old words still exists (on the host, in its backups). Words plus any old backup give the seed, with no account access.

Fix: Replace's wording says it does not protect against words that have already leaked; leaked words need a reset. Known limit 13 says so.

### R-8 (Medium): moving a reply

Attack, hostile host: `reply_to` is a clear field. Move christopher's genuine "Yes, go ahead" from "Shall I cancel the trip?" to "Shall I send the money?".

Fix: the sealed payload carries `re`, the nonce of the quoted message's current envelope. A reader shows the quote only if the server's `reply_to` target matches; otherwise "The message this replies to couldn't be checked."

### R-9 (High): script in a sealed file

Attack, hostile member (or the host, which sets nothing here but can collude): send a sealed attachment whose FileRef says `mime: "text/html"` (or `image/svg+xml`) with a script inside. The recipient's client decrypts it into a `blob:` URL. A `blob:` URL has the app's origin, so opening it in a tab or frame runs the sender's script with the recipient's session and keys in reach.

Fix: `mime` and `name` are untrusted. Only a fixed list of raster image, audio and video types is shown inline; everything else is offered as a download, with the blob typed `application/octet-stream`. SVG and HTML are never rendered.

### R-10 (Medium): another app owns `housecall://`

Attack: a malicious app on the new phone registers `housecall://`. With a code-carrying deep link, tapping "Open in Housecall" delivered the secret and `A` to it. It could claim first.

Fix: follows from R-0. `housecall://link-scan` carries nothing. A fake app can at most show a fake scanner, which leaves it where a photographer is.

### R-11 (High): linked devices lost pin history

Attack, hostile host: `wrapped_keys` carried each pin's current key only, and the new device fetched older keys from the server. R-1 then works against every newly linked device.

Fix: each pin in `wrapped_keys` carries its full `history`, validated by the same rules as first contact; if any pin fails, the whole blob is refused. Format change; negative vectors "pin without history", "pin history does not end at the current key", "pin history not ascending", "pin history uses one key at two revisions".

### R-12 (Medium): banner fatigue

Attack, hostile host: inject envelopes naming peer `key_rev 999`, again and again. Pre-review each raised a "key changed" state, training people to tap "I understand" without checking.

Fix: an envelope naming a higher revision changes nothing by itself. It triggers one key fetch, and only the server's answer, by the pin rules, moves the state. An unlisted revision shows "This message couldn't be decrypted." and nothing else. Vector "envelope names a peer revision above the pin that the server does not list".

### R-13 (Low): non-canonical agreement keys

Attack, hostile host: X25519 ignores bit 255 and reduces modulo `p`, so `agree_pub` and `agree_pub | 0x80…` (or `u + p`) are the same key with different bytes. Two different `identity_key` values then give one shared secret but different safety numbers and different `info`, which breaks "same key means same bytes" in pins and the server's "key already used" check (R-3).

Fix: reject bit 255 set and `u ≥ p`, on the client and on the server (byte comparisons). Vectors "agreement key bit 255 set", "u >= p".

### R-14 (Low): "show me your code"

Attack: someone posing as support asks the user to show the QR on a video call. With R-5 they still need the user to type their number, which a scammer on the call can also ask for.

Fix: the QR screen says "Never show it to someone who asks for it: Housecall and your host never will." It is blurred until tapped and blurs again after 60 s. LINK known limit 1 states the residual.

### R-15 (Low): the code in the address bar

Attack: the system camera opens `/link#hcl1…`. The code stays in the address bar, the tab's history and synced browser history, readable by a shoulder-surfer or a synced device.

Fix: `link.js` copies the fragment and calls `history.replaceState` before anything else; the web client does the same for `/#link=`. The code is single use and lives 120 s, so what a browser may still have recorded expires quickly.

### R-16 (Medium): two-word confirmation bypass

Attack: the person (or a hurried tester) taps "Show the words again", sees words 7 and 19, and copies them in without writing anything down. The confirmation proves nothing.

Fix: returning from the list picks two new positions; the words are never on screen with the fields. Vectors `confirm_two_example`, `confirm_two_wrong`.

### R-17 (Medium): malformed payloads

Attack, hostile member: a correctly sealed envelope whose payload has `files: "x"`, `size: -1`, `w: 1e9`, a 10 MB `name`, `id: "../../"` or a `key` of the wrong length. Readers that trust the shape crash, render huge elements, or build bad URLs.

Fix: every payload and FileRef field has a type and range; any failure rejects the whole message as "couldn't be decrypted", and nothing partial is shown. Vectors "malformed payload: …" and FileRef negatives.

## Tried, did not work

Hostile host:
- Read a DM: `K` comes from X25519 between the two private keys; the host has neither.
- Forge or alter a message: XChaCha20-Poly1305 tag over the padded payload and `ad`; any change fails.
- Show alice's message as bob's: the sender id is in `ad`, built from the client's own knowledge of the DM.
- Reorder or drop messages: not prevented; stated in DM known limit 8 (no sequence numbers in v1).
- Replay an envelope as a second message: the per-DM nonce set hides duplicates within loaded history (6.4); the residual is known limit 8.
- Replay into another DM between the same pair: channel id is the HKDF salt and is in `ad`; fails.
- Replay across two hosts it controls by copying ids: works; stated in known limit 11.
- Swap a peer key at first contact: works (trust on first use); detected only by safety numbers; known limit 3.
- Swap a peer key later: CHANGED_UNACKNOWLEDGED holds incoming messages and blocks sending until the person acknowledges it.
- Downgrade an established DM to plaintext: server refuses `enc = 0` (S-4) and the client marks it (R-2). Before first contact, "no keys" works; known limit 14, labelled "Not encrypted yet".
- Swap `recovery_rev` in a `key_backup` header: the first 5 bytes are `ad`; fails.
- Serve a `key_backup` of the host's own seed: it does not know `R`, so cannot seal one that opens with the user's words; and the derived key must equal the published one.
- Brute-force the 24 words: 256 bits of entropy; infeasible.
- Brute-force a password-derived key: none exists (S-2). `password-check` is Argon2 behind `auth_slots`, 5 per minute.
- Swap `B` during an in-app QR scan: `claim_tag` fails (`2^-128` to forge).
- Swap `A` on the in-app path: `A` never reaches the server.
- Hand the new device the host's seed in `wrapped_keys`: sealed under `X25519(a, b)`; and the opened seed must match the account's published key.
- Reset a user's key: possible for the host; every peer sees "key changed" and every old device alarms; known limit 7.

Hostile member:
- Impersonate another member: `author_id` is set by the server from the session, and `ad` binds the sender; a member cannot set someone else's `author_id`.
- Reflect alice's message back to her: the reflected copy has `author_id` = the reflector, so `ad` differs and the tag fails. A peer who colludes with the host can do it; known limit 10.
- Use someone else's link: needs the secret and `A` from the QR.
- Approve or deny a link from another session: 403; only the session that started it.

QR:
- Photograph the code: no keys and no session without the number typed on the showing device, and `result` needs the claimer's `device_key`.
- Race the legitimate claim: the second claim burns the link for both; the person sees a failure.
- Claim twice: burns (409).
- Replay after expiry: EXPIRED is terminal; 404 after 10 minutes.
- Tapjacking: no Approve button; numeric field plus OS verification; `filterTouchesWhenObscured`.
- A remote "new device" that tricks the user: its number is not on any device in the user's hand; social engineering residual stated (LINK known limit 1, R-14).

Recovery:
- Thief with an unlocked device viewing the words: needs the password (DM 4.4).
- Thief replacing the keys: `PUT /api/me/keys` with a different key needs the password.

Format:
- Nonce reuse: 24-byte random nonces per envelope and per edit, collision about `2^-96` at `2^48` messages. File chunks use a random 19-byte prefix, a counter and a last flag, so truncation, extension and reordering fail.
- Domain separation: every HKDF use has its own (salt, info) pair; no two derivations share one.
- Ambiguous concatenation: user and channel ids are length-prefixed (`lp`) in `info` and `ad`; every other field is fixed length (keys 65 or 32 bytes, revisions u32, link fields 16/32/32/32).
- Version confusion: version bytes are inside `ad` (envelope, `key_backup`, file header) and checked before use; `v` in the payload, `hcl1` in the QR.
- Low-order X25519 points: all-zero shared secret rejected; noble's X25519 throws on small-order input (vector "small-order peer agreement key").
- Ed25519 malleability: the key signs nothing in v1; `sign_pub` is checked for a valid, non-small-order encoding.
- Base64 variants: strict b64u, rejecting padding, `+`, `/`, whitespace and non-canonical tails (decode, re-encode, compare).
- Padding oracle: AEAD opens before unpad, so unpad errors are never reachable with forged ciphertext.
- Envelope length tricks: lengths must be `33 + 256·n + 16`, checked by server and client before decryption.
