# Review of the Housecall v1 security documents

Reviewed at commit `e8c4042`: `PROTOCOL.md`, `THREAT-MODEL.md`, `SECURITY-LEVELS.md`, `DECISIONS.md`, `CRACK-PLAN.md`, against `.brief/DECISIONS-1111.md`. This is a review on paper only; nothing was implemented or run.

Severity: **break** means a stated property or control fails under an adversary the threat model admits. **Weakness** means the control holds but is weaker than the documents say or than it needs to be. **Unclear** means the documents are ambiguous or contradict each other, so an implementer could build either a safe or an unsafe version.

Section references such as "P 5.4" point into `PROTOCOL.md`. "TM", "SL", "DEC" and "CP" mean the threat model, security levels, decisions and crack plan.

---

## Breaks

### 1. The six-word join code can be ground by a birthday collision, so the server can substitute a key on a tokenless join or a key replacement

**Severity:** break. **Where:** P 5.4 steps 2–3; P 8.3 ("same as in 5.4"); DEC 21. This contradicts TM A2b ("cannot substitute a key at join").

The code is `H("hc/v1/sas", "join", request_id, AccountPub)`. The server chooses `request_id`, and nothing makes the id the requester sees equal the id the admin's client uses.

1. X sends `POST /v2/join-requests` with key `A_X`.
2. The server generates its own key `A_S`. It then searches over pairs `(r_X, r_S)` until `code(r_X, A_X) = code(r_S, A_S)`. Both sides have a free 128-bit input, so this is a birthday collision on 66 bits: about 2^33 SHA-256 calls per side. Distinguished-point collision search needs almost no memory, and the whole search takes seconds on one GPU. The server holds its HTTP reply until the search finishes.
3. The server returns `r_X` to X. X's client shows the six words.
4. The server shows the admin the request with `r_S` and `A_S`. The words X reads out match, so the admin signs `member_add` binding X's username to `A_S`. The server now has a ghost member with whatever history the admin chose.
5. The same steps work on `replace-requests` (P 8.3). The server takes over an existing username, usually with `full` history.

CP C02 step 7 tests only second-preimage grinding (10^9 tries), so it would miss this. Yet C02's own break condition ("computed from anything the server controls") is met by the spec as written.

**Fix:** remove `request_id` from the code. Use `H("hc/v1/sas", "join", server_id, AccountPub)`, and `"replace"` with `new_pub` for P 8.3. The server then needs a 66-bit second preimage.

### 2. An admin can replace any account's key, including the owner's; the new key's role and private-channel membership are unspecified

**Severity:** break. **Where:** P 3.3 kind 14; P 8.3; P 8.4; P 9.6. This contradicts TM A7 ("cannot … replace the owner's key"), the rule on P 3.3 kind 6 that admins cannot add themselves to private channels, and P 3.3 kind 3 ("owner cannot be removed; admins only by the owner").

1. Admin A signs `key_replace {old_id: owner, new: A2, username: <owner's>, history: full}` with no `old_proof`. Here `A2` is a second key A controls. Row 14 checks only that the signer is an admin or owner, so the entry is valid. The owner-protection rules in row 3 do not apply to row 14.
2. If the new account inherits the old role, A2 is now the owner. A can sign `features_set` and so enable host access without the real owner. If the role is not inherited, an admin has still removed the owner, which row 3 forbids. A can do the same to another admin.
3. Against an ordinary member M who is in private channel P: P 8.4 implies that membership carries over, otherwise "Secure my account" would lose private channels. P members' clients then see an outstanding full-history member and send HistoryGrants (P 9.6) for every old P epoch to A's key, and the next P epoch is wrapped to it. A reads P. Nothing shows P's members anything beyond a "key changed" warning, and that warning is specified only for DMs.

**Fix:** in row 14:
- An entry targeting the owner is valid only if the owner signs it with `old_proof`.
- An entry targeting an admin must be signed by the owner.
- The role and private-channel memberships carry over only when `old_proof` is present. Without it the new account is a plain `member` in no private channels, and private-channel creators re-add it with `channel_member_add`.
- Every channel the old account was in shows a notice for a replacement without `old_proof`.

### 3. A removed account keeps its signing authority

**Severity:** break as written. **Where:** P 3.2; P 3.3 (all rows); P 13.4.

The rows check role and creator, never that the signer is still a member. The state keeps `role` and `status` as separate fields, and no rule says that removal clears the role.

1. The owner kicks admin A. A's status becomes removed, but A's role is still `admin`.
2. A signs `member_add` for a new key with `history: full`. Row 1 ("admin or owner") passes, so A adds a ghost member after being removed.
3. The creator C of private channel P is removed. C is still "the creator" and signs `channel_member_add {P, accomplice, history: full}`. Row 6 also does not require the added account to be a current server member.
4. Invites that A issued before removal pass the check "issuer is admin or owner at this seq" in the same way.
5. Group DMs (P 13.4) have the same gap: the spec does not say what happens when the creator leaves the home server or is removed.

CP C01(d) and C19 count these cases as breaks, so the intent is clear. The table does not say it.

**Fix:** add a general rule to P 3.3: the signer of every entry except genesis must be `active` at that seq; removal sets role to none; every account an entry adds must be an active server member. Also pick one rule for a private channel or group DM whose creator is gone: either membership is frozen (self-leave only), or the creator's rights pass to the owner (for a group DM, to the longest-standing member).

### 4. A removed member can keep posting messages that are shown as live, and anywhere as "backfill"

**Severity:** break. **Where:** P 10.4 rules 1 and 6; P 9.3 (lazy rotation). This contradicts TM A3 ("cannot post messages that the group accepts as live"). The break condition in CP C08 only covers readers that have already adopted a newer epoch.

The adversary is A3 colluding with A2b, which the threat model allows.

1. R is removed at seq `r`. Channel C is quiet, so epoch `n` (with `log_seq < r`) is still current: eager rotation only covers channels with a message in the last 30 days, and other channels wait for the next sender.
2. R signs a message in epoch `n` with `log_seq = s < r`, the correct `log_head8` and the next `sender_seq`.
3. The server delivers it live. Rule 1 passes because the sender was a member at `s`. Rule 6 passes because no reader has adopted an epoch above `n`. Every member sees a new message from R after R's removal.
4. After rotation, the server keeps delivering R's messages as "backfill". The server alone decides what is live and what is backfill, and backfill is exempt from rule 6, so these messages sit among genuine history in `server_seq` order.

**Fix:**
- (a) For live messages, rule 1 checks membership at the reader's verified head, not at the `log_seq` the message claims.
- (b) Close each epoch: the epoch `n+1` header carries `closed: {(account_id, device_id) → highest sender_seq the author accepted in epoch n}`. Readers drop any epoch-`n` message above that number, live or backfilled.

### 5. The server can freeze a client's view of the log, so an honest client keeps encrypting to a removed member

**Severity:** break. **Where:** P 3.5 items 3–4; P 9.3 ("mandatory before send"); SL 2 (`log_verified`). This contradicts TM P5 and TM A2b ("cannot make an honest client encrypt under an epoch that still includes a removed member").

The adversary is A2b colluding with the removed member R.

1. The owner removes R at seq `r`. To victim V's devices, the server serves the log only up to `r−1`. It withholds every signed object with `log_seq ≥ r` from V: messages, epoch headers and grants.
2. The freshness rule in P 3.5 item 4 stays satisfied, because V gets a head from the server every few minutes. It is just the old head, and nothing in a head shows its age.
3. V's channels stay `HAVE_EPOCH(n)`. V keeps sending under epoch `n`, and the server hands those messages to R, who holds `EK_n`. V sees level 4 throughout.
4. The only thing that ends this is a cross-referencing object reaching V, and the server decides whether that ever happens. It is not the L7 residual, because V had a valid shared view before the split.

**Fix:**
- Treat a head as fresh only if it contains an entry signed by an account other than the reader with `created_at` within 24 hours of the local clock.
- Add a log entry kind `checkpoint {}` that any active member's client signs when the head has no entry newer than 12 hours.
- With a stale head, show level 0 and pause sending in channels that have other members.

The server cannot forge other members' checkpoints, and real checkpoints chain onto the removal entry, so they cannot be placed on V's frozen branch. This shrinks the window to 24 hours; it does not close it.

### 6. Anyone holding `RS` can register devices and change the password with no password, no approval and no notice

**Severity:** break. **Where:** P 8.2. This contradicts P 2.6 ("an unlocked stolen device cannot silently change it"), TM A4b ("change the password only with the old password"), DEC 31 and CP C17 step 5.

1. The attacker holds `RS`: an unlocked stolen device (A4b), a revoked device (L5), or `RS` copied from an unlocked device.
2. The attacker calls `POST /v2/recover/challenge` and `/recover`, signing with `ak_sign` derived from `RS`. The server registers a new device with no approval. The spec does not say that other devices are notified.
3. The attacker sets a new password through the P 8.2 path ("authorised by a signature from `ak_sign`"), on every server the account has joined. The real user's password then fails everywhere.
4. Revoking the device (P 7.4) does nothing, because the attacker can come back through P 8.2 at any time. Only P 8.4, which needs an admin on every server, stops it.

**Fix:**
- In P 8.2, notify every active device of a recovery.
- If the account has an active device, hold the recovery as a pending request under the same approval and waiting-period rules as P 7.3 (as amended in finding 9). A phrase holder with no active device is unaffected.
- Allow the password set in P 8.2 only after that request completes.

### 7. The https invite link hands the token secret to the host

**Severity:** break. **Where:** P 5.2 (the `https://<origin>/join#…&t=…` form). This contradicts P 5.2 ("the server cannot make its own join for this invite"), DEC 20 and TM A2b.

1. An admin shares the https form of the link. The recipient opens it in a browser, which is what happens to a link in any chat app, even if they will join with the desktop app.
2. The host serves that page. A URL fragment is never sent in an HTTP request, but the page's own script can read `location.hash`. A hostile host serves a page that posts `t` back. This is not covered by L12: the victim may never use the web client.
3. The server derives `token_priv` from `t`. When X submits `POST /v2/join`, the server stalls or answers "username taken", then appends its own `member_join` with its key, X's chosen username and a valid `invite_pop`. Single use now locks X out ("invite no longer valid").
4. The log shows that the expected person joined. History follows the invite, and with `full` the members' clients send grants. The server has a ghost member.

**Fix:** never put `t` in a URL whose page the host serves. Share invites only as `housecall://join?…` links, plus text the user can copy. The web client accepts pasted invite text, and P 20.3 states that joining on the web gives the invite to the host (L12).

---

## Weaknesses

### 8. Manual rotation is not in the log, so the server can hide it

**Severity:** weakness. **Where:** P 9.3 (trigger "Manual"); P 9.4 rule 4 and the new-device rule; P 9.7.

1. A member suspects `EK_n` has leaked (for example a bot endpoint, or a stolen device before P 8.4 runs) and rotates manually to `n+1`.
2. A malicious server withholds header `n+1` from some members and accepts their epoch-`n` messages (an honest server would answer 409).
3. Nothing makes those members stop: no log entry exists, so "mandatory before send" never fires, rule 6 needs the reader to already know `n+1`, and the new-device rule checks only log entries. They keep encrypting under the leaked key.

**Fix:** make manual rotation a log entry, `channel_rekey {channel_id}`. The signer is an admin or owner for public channels, or any member of a private channel. That makes a manual rotation a change that affects the channel, so the existing rules cover it.

### 9. The 7-day auto-approval fires even when the user's devices saw the request; one stolen password can block device approval indefinitely

**Severity:** weakness. **Where:** P 7.3 steps 4–6; P 18 ("1 outstanding per account … 24 h cooldown after a deny"); DEC 14; TM A5a.

1. An attacker with the password creates a pending request.
2. The user's devices are notified daily. The user dismisses the notices as spam or is travelling.
3. On day 7 the server releases the blob. The attacker has `RS`, which is the account on every server (L16).
4. Meanwhile the real user cannot add a device, because only one request may be outstanding. An expired request stays pending (step 5). Denying it starts a 24-hour cooldown on the whole account, which blocks the user too, and the attacker files again when it ends.

**Fix:**
- Auto-approve only if no active device of the account opened a session between `created_at` and `auto_at`. That is the stated purpose: a user who lost every device.
- Apply the deny cooldown to the requesting source and `device_pub`, not to the account.

### 10. Offline guessing is costed per CPU core; a score-3 password falls in about one GPU-day

**Severity:** weakness. **Where:** P 0.4; P 2.1; P 2.3; P 2.5; DEC 28; TM L2; CP C09.

1. The attacker is A2b, or A2a with `WK`. "A whole-machine image" (P 2.5) includes a VPS provider's disk snapshot, which is the most common server backup and puts `WK` next to the data in default file mode.
2. Each guess costs one Argon2id evaluation (m = 64 MiB, t = 3) plus a cheap OPRF and AEAD step. One evaluation moves roughly 0.5–0.6 GB through memory. On one current high-end GPU (about 1 TB/s and 24 GB) that bounds throughput near 10^3 guesses per second. This is an estimate; C09 must measure it.
3. zxcvbn score 3 means an estimated 10^8 guesses or more: about 10^5 seconds, roughly one day on one GPU and minutes on a rented rack. zxcvbn also estimates for an untargeted attacker, and a targeted one does better.
4. The result is `RS`, which is the account on every server.

**Fix:** require zxcvbn score 4 at account creation (an estimated 10^10 guesses or more, about 100 times the cost). State the cost per GPU in L2 and DEC 28, and say in P 2.5 that a provider disk snapshot counts as a whole-machine image.

### 11. Level 4 says only the people in the conversation hold the keys while a participant uses the web client

**Severity:** weakness. **Where:** SL 1, SL 3 (the `client == web` factor), the level-4 string in SL 6; DEC 19. This contradicts D1 ("must never overstate").

1. Bob uses the web client.
2. The host serves Bob altered code once (L12) and obtains Bob's `RS`.
3. The host reads every DM, group DM and channel Bob is in.
4. Alice, on a native client, sees level 4 "End-to-end encrypted" for her DM with Bob. The web factor only looks at the viewer's own client.

Web is also ranked 3, above "Server sees files" (2), although a hostile web host can read everything the web user can, not just files.

**Fix:**
- Add a signed `platform: native|web` field to `DeviceCert`.
- Add a channel factor (3, "Someone uses the web app") when any recipient has an active web device in the device list.
- Change the level-4 sheet sentence to end "…as long as everyone in it uses the app", and say that the host can hide a web device from the list.

### 12. `verify-web` cannot detect a swap aimed at one user

**Severity:** weakness. **Where:** P 20.2–20.3; TM A11 ("Cannot: make `verify-web` accept an altered bundle"); DEC 9.

1. The host serves the signed bundle to anything that looks like `verify-web`: its user agent, no cookies, an unfamiliar IP address.
2. It serves altered code to the target's browser, recognised by cookie or IP.
3. `verify-web` reports a clean bundle. The "installed manifest version" on the first screen is drawn by the altered page itself, so it shows whatever the host wants.

**Fix:** state in P 20.3 and TM A11 that this detection only catches a swap served to everyone. Remove detection as a mitigation from the web text in SL 6.

### 13. Server-made file conversions replace the sender's file in the sender's message

**Severity:** weakness. **Where:** P 15.5 (`transcode`, "Clients prefer a derivative when present"). This contradicts TM P2.

1. The owner enables `transcode`, so the host holds `K_file` for public channels.
2. For Alice's image, the host writes a HostRecord pointing at a "derived" blob with any content it likes.
3. Every client shows the host's file inside Alice's message, attributed to Alice. HostRecords are unsigned, which the spec states, but preferring them means they replace signed content. Link previews and scan verdicts get a "by the server" label; derivatives have none.

**Fix:** show the sender's original by default. Use a derivative only when this device cannot play the original, and label it "Converted by the server".

### 14. Notification text from `push_text` is unauthenticated and shown as written by a member

**Severity:** weakness. **Where:** P 15.5 (`push_text`); P 17.3. This contradicts TM P2.

1. `push_text` is on. The host seals `{title: "Alice", body: "the new door code is 4411, reply to confirm"}` to Bob's `push_key`.
2. Bob's notification shows this as from Alice. Nothing checks a signature.

**Fix:** put the original signed message in the sealed payload when it fits. The notification extension decrypts and verifies it with keys shared through the app group; anything that does not fit or does not verify is shown content-free. For short messages this also removes the host's need to read text at all.

### 15. Nothing forbids sending call media unencrypted, and the frame-cryptor behaviours the call keys depend on are not pinned down

**Severity:** weakness. **Where:** P 12.1–12.3; P 24 item 6. CP C04 step 4 tests a rule that P 12 never states.

1. The token service mints a room without E2EE, or a webview lacks insertable streams. Unless the app refuses, LiveKit publishes clear frames, and P 12 contains no rule that refuses.
2. As I recall, LiveKit's frame cryptor passes through without decryption any frame that carries its "server-injected frame" (SIF) trailer. If so, the SFU can inject audio or video that plays as a participant's. This needs checking in the spike.
3. LiveKit builds its AES-GCM IV deterministically from SSRC, RTP timestamp and a frame counter, not at random. One `sender_key` covers all of a participant's tracks for a whole generation. Uniqueness across long calls and RTP timestamp wrap-around has not been checked.

**Fix:** add to P 12:
- A client must not join or publish unless frame encryption is active with a key from this protocol.
- A client drops every frame that does not decrypt (SIF pass-through off).
- Spike 6 confirms the IV construction and sets a maximum number of frames per key; the client bumps `g` before reaching it.

### 16. A `call_rekey` can move a call back to an old epoch's key

**Severity:** weakness. **Where:** P 12.3 ("the first rekey message seen for a given generation wins"); CP C03 step 8.

1. Epoch `n+1` exists because R was removed.
2. A message reaches the participants first carrying `call_rekey {epoch: n, generation: g+1}`. It can come from a malicious member, or from R through finding 4.
3. Under the first-seen rule, the call moves to `ck_{n,g+1}`, which R can derive from `EK_n`.

**Fix:** accept a `call_rekey` only if `generation` is the current generation plus one, and its `epoch` equals both the epoch of the message carrying it and the reader's highest adopted epoch.

### 17. The private account state can be rolled back

**Severity:** weakness. **Where:** P 7.5.

1. The server returns an older `State` version. Its AEAD is valid; the AAD binds the version, but nothing requires the latest one.
2. Effects: a blocked contact is unblocked, "Mark as verified" is cleared, an accepted or rejected key change (P 13.5) is forgotten, and read pointers and bot-notice flags reset. A new device cannot tell.

**Fix:** each client keeps the highest `State` version it has seen per server and rejects lower ones. `State` also carries a Lamport counter merged across servers, so a new device takes the highest across all of the account's servers.

### 18. The host passphrase has no strength rule

**Severity:** weakness. **Where:** P 0.4; P 2.5; P 15.4; DEC 18.

1. The attacker has a whole-machine image in passphrase mode, and the operator chose a short passphrase.
2. At Argon2id m = 256 MiB, t = 3, a dictionary passphrase falls quickly on one GPU.
3. That yields `WK`, which unwraps the OPAQUE `ServerSetup` (opening finding 10 for every user) and the host key.

**Fix:** generate the passphrase at install (for example 8 BIP-39 words) instead of accepting one the operator types.

### 19. Bots can be friends and DM partners

**Severity:** weakness. **Where:** P 13.2–13.3 versus P 16.2 ("no `channel_member_add` kind for DMs accepts a bot"); P 23 test 53; CP C14 step 3.

DMs are not created with `channel_member_add`. `DMCreate` and `FriendRequest` accept any two accounts that share a server, and the DM header check accepts any party.

1. Someone steals `RS_bot` (A8).
2. They message members privately as the trusted "Steve" and phish them in a DM that shows level 4.

**Fix:** in P 13.2 to 13.4, reject friend requests, `DMCreate` and group-DM adds where either account has role `bot` in the shared server's log.

### 20. The push relay cannot tell who owns a `server_id`, and `push_key` is shared across servers

**Severity:** weakness. **Where:** P 1.2 (`push_key` is generated once per device); P 17.1–17.2.

`server_id` is a public hash, and the relay key is registered by answering a challenge at an `origin_hint` that the registrant chooses.

1. The operator of S2 registers a relay key that claims S1's `server_id` with S2's own origin, first come first served.
2. S2 pushes to S1's aliases: wake spam, or forged sealed previews. S2 can seal those because the device sent S2 the same `push_key_pub` it sent S1. Alternatively, S2 squats S1's id so that S1 cannot register.

**Fix:**
- When a device registers its alias, bind it to the relay public key of the server it is registering with (fetched from that server after the device has verified its log), not to `server_id`. The relay accepts pushes to the alias only from that key.
- Generate `push_key` per (device, server).

---

## Unclear

### 21. "Current" versus "at `log_seq`", and an undefined "affecting this channel"

**Severity:** unclear. **Where:** P 9.2 step 1; P 9.3; P 9.4 rules 1, 3 and 4 and the new-device rule; P 9.7; P 15.8 item 3.

- Rule 1 says "current member … at `log_seq`". Read as "at `log_seq`", a removed member can author headers with an old `log_seq`, and rule 4 rejects them only on clients that have already verified the removal.
- Rule 3 says "the log's current host key"; P 15.8 item 3 says "at its `log_seq`".
- "Log entry affecting this channel" appears in rule 4, the new-device rule, P 9.3 and P 9.7, and is never defined. Do a full-history join, `role_set`, `profile_set`, `bot_add` without a channel add, or `features_set` for a private channel count?
- P 9.2's "Never: accounts that joined `from_now` after this header's `log_seq`" cannot exclude anyone, because such accounts are not in the log at that `log_seq`.
- A full-history join is a membership change, so it makes the channel `STALE` (P 9.7) and forces a rotation, but the P 9.3 table lists rotation only for `from_now` joins.
- If a malicious server holds an invalid header at `n+1`, P 9.7 gives no way out of `ALERT`: the server's compare-and-swap blocks a valid `n+1`, and `n+2` needs a `prev_hash`.

**Fix:**
- Define `affects(entry, channel)` as a table.
- Evaluate rules 1–3 against the log at the header's `log_seq`, and rule 4 against the reader's head.
- Say whether a full-history join rotates.
- Have the server validate epoch headers against the log, as it already does for log entries, and give P 9.7 an explicit transition out of `ALERT`.

### 22. The validity rules for `features_set` are missing

**Severity:** unclear. **Where:** P 3.3 kind 9 ("see 15.2 for the transition rules"); P 15.2 gives only an owner-side state machine.

Undefined cases:
- features on with `host_key: null`;
- all features off with a non-null `host_key`;
- a `key_id` reused from an earlier entry, or the same `key_id` with a new `pub`;
- the key changing in the same entry as the feature set.

A verifier that accepts "`push_text` on, `host_key` null" lowers the level, but no client can wrap to the host. One that accepts a reused key may wrap to a key the owner believes was destroyed. `ARMING` has no log representation.

**Fix:** add to row 9:
- any feature is on if and only if `host_key ≠ null`;
- a `key_id` must not appear in any earlier entry;
- the `pub` for a `key_id` never changes.

### 23. A passphrase-locked server and OPAQUE contradict each other

**Severity:** unclear. **Where:** P 2.5 versus the last bullet of P 15.4; CP C20 step 6.

The OPAQUE `ServerSetup` is wrapped under `WK`, and in passphrase mode `WK` exists only after the operator types the passphrase. P 15.4 nevertheless says a locked host runs "everything else" normally. Password login, joins, join requests, setting a password after recovery, replacement requests and the fake record for unknown usernames all need `ServerSetup`.

`HostKeyFile` also has its own `salt`, while P 2.5 derives one `WK` at start. Which salt does `WK`'s Argon2id use, and where is it stored?

**Fix:** state that a locked server refuses password logins and registrations while registered devices keep working. Store one `WK` salt with the wrap-key configuration, and drop `salt` from `HostKeyFile`.

### 24. The version rule contradicts the threat model

**Severity:** unclear. **Where:** P 0.1 rejects only a `v` higher than the client implements; TM A1 says a lower `v` is rejected.

This is harmless while only v1 exists. Once v2 ships, "reject only higher" accepts v1 objects wherever v2 removed a v1 weakness.

**Fix:** a v1 client accepts exactly `v = 1`. Later versions state a minimum `v` per object type.

### 25. The domain-separation rule is not followed

**Severity:** unclear. **Where:** P 0.2 ("never reused for two purposes"); P 0.6.

- `pwchange` is both an OPAQUE context (P 2.6 step 1) and a `Sign` label (P 2.6 step 2).
- The `hc/v1/login` context (P 2.4) is not in the list.
- `log-entry`, `epoch-header`, `replace-proof` and `invite-pop` each label both a `Sign` and an `H`.
- `msg/t`, `msg/f` and `msg/u` label both the class-key KDF (P 9.1) and the AAD hash (P 10.2).
- `"host-at-rest" ‖ <feature>` and `"host-at-rest" ‖ "bot"` (P 15.4, P 16.3) produce labels that are not in the list.
- `H(upload, blob)` (P 2.6), `H(server_id, origin, device_id, nonce)` (P 6.1) and `H(server_id, username, AccountPub)` (P 3.3, P 5.4) have no label, although the definition of `H` requires one.

I cannot build a collision from any of these, because the `H`, `Sign` and `KDF` encodings differ. But reviewers rely on the stated rule.

**Fix:** add `login`, `pwchange-ctx`, `host-at-rest/<feature>`, `host-at-rest/bot` and `classkey/t|f|u` to P 0.6, and give every `H` call a label.

### 26. Password-change and recovery signatures are not bound to a server, a login or a version

**Severity:** unclear. **Where:** P 2.6 step 2; the last paragraph of P 8.2.

`Sign(DK, "hc/v1/pwchange", H(upload, blob))` leaves out `server_id`, the step-1 login and the version. P 8.2's "signature from `ak_sign` over the registration upload and a new blob" has no label, no server and no version.

If the P 8.2 password endpoint accepts a signature alone, the operator of server A (which shares the user) can replay the user's signed upload and blob to server B. B's record is then tied to A's OPRF key and A's `server_id`, so the user's password login on B fails.

**Fix:** sign `H(label, server_id, login_id or recovery nonce, u32be(version), upload, blob)`, and require a session of the same device on the same server.

### 27. Where a new device's pin comes from

**Severity:** unclear. **Where:** P 3.5 item 1 ("from the blob for new devices") versus P 2.3 (the blob plaintext has no `server_id`) and P 7.3 step 3 ("from State").

The binding that actually exists is the OPAQUE server identity plus the blob's AAD, which both contain `server_id`.

**Fix:** reword P 3.5 item 1 to name those two as the source.

### 28. DMs reuse one `dm_id` across home servers and have no log for `log_seq`

**Severity:** unclear. **Where:** P 0.5; P 13.3; P 9.4 rule 4; P 10.1 fields 8–9; P 3.5 item 3.

`dm_id = H(a, b)` is the same on every home server, yet P 13.3 calls a moved conversation "a new thread". A client that stored epochs for that `dm_id` rejects epoch 0 on the new server under rule 4; if it accepts it, it has dropped its rollback guard for DMs. DM headers and messages also carry `log_seq` and `log_head8`, with no log to check them against.

**Fix:** use `dm_id = H("hc/v1/dm", home_server, min, max)[0..16]`. For DMs, define `log_seq = 0` and `log_head8` as zero bytes, and keep epoch state per `(home_server, dm_id)`.

### 29. The safety number is not fully defined

**Severity:** unclear. **Where:** P 13.5; P 0.5.

Fifteen bytes (120 bits) cannot be written in 30 decimal digits (about 99.7 bits), and the spec does not give the mapping. P 0.5 says the fingerprint is the safety number's input, while P 13.5 hashes the public keys.

**Fix:** define the mapping, for example six 5-byte chunks, each `mod 100000`. Fix the reference in P 0.5.

### 30. Two signed fields are undefined

**Severity:** unclear. **Where:** P 3.3 kind 10 (`bot_add.pop`); P 16.1.

`bot_add` carries `pop: bstr64`, but neither section says what is signed or under which label. P 16.1 never produces it.

**Fix:** make it the same as `member_add.pop`, signed by the bot's `ak_sign` under `hc/v1/join-pop`.

### 31. Deleting attachments has no defined authority

**Severity:** unclear. **Where:** P 11.7.

The section says deletion is "authorised by the delete message's outer `target`", but the server has no mapping from `msg_id` to `blob_id`: blob ids sit inside `ct_f`, and an upload names only `channel_id`. Either the server cannot delete blobs, or something names blob ids in the clear, and then it is undefined who may delete a given blob.

**Fix:** at send time, the client lists the message's `blob_id`s in a clear field of the POST. The server stores them, and only the original sender or an admin who is a member of the channel may delete them.

---

## Resolution

Each finding was checked against the documents as they stood at the review commit. All 31 describe a real gap or contradiction. None was rejected outright. Four were accepted with a different or weaker fix than proposed, and the reasons are given. All changes are to documents only; nothing was implemented or run. Section references are to the revised documents. Where a finding's fix is the reviewer's, it is applied as written unless the table says otherwise.

| # | Finding | Verdict | Change made, or reason |
|---|---|---|---|
| 1 | Join code grindable by a birthday collision | **Right** | Code is now `H("hc/v1/sas","join",server_id,AccountPub)`; the replace code is `H(…,"replace",server_id,new_pub)`. No server-chosen value remains. P 5.4, P 8.3, TV-13, DEC 21, CP C02 steps 7 and 9 (birthday variant added). |
| 2 | Admin can replace the owner's or an admin's key; carry-over unspecified | **Right** | P 3.3 kind 14 rewritten: owner target needs the owner's signature and `old_proof`; admin target needs the owner or an admin with `old_proof`; role and private-channel memberships carry over only with `old_proof`; notice in each channel without it (SL 8). P 8.3, 8.4, test 64, CP C13. |
| 3 | Removed account keeps its authority | **Right** | General rules R1 (signer active, removal clears role), R2 (added accounts active), R3 (a private channel or group DM whose creator is gone is frozen) added to P 3.3 and 13.4. I chose freezing rather than passing the creator's rights to the owner, because inheritance would let an admin or owner read a private channel. Test 65, CP C13. |
| 4 | Removed member's messages shown live, or as backfill | **Right** | Both parts applied. P 10.4 rule 1 checks live senders against the reader's head; rule 6 and a new `closed` field (header field 13, P 9.1) drop a departed account's messages above the number the author accepted, live or backfilled. The `closed` list is limited to departed accounts to keep headers small. Residual stated: a backdated message that reuses a skipped `sender_seq` (L4, L8). Test 66, CP C07 step 4 and C08. |
| 5 | Server can freeze a client's view of the log | **Right; fix incomplete, so applied with a stated residual** | Applied as proposed: P 3.5 item 4 requires another member's entry within 24 hours, `checkpoint` entries (kind 17) keep heads fresh, and a stale head means "Not verified" and no sending in shared channels. But the fix does not close the case the finding describes: a removed member R is still a listed member on the frozen branch and can sign the fresh entries there. The documents now say so (P 3.5 item 4, TM L7 and A2b, DEC E.10) instead of claiming the window is closed. A server acting alone is stopped; a server with a listed accomplice is not. The new rule also spends the wall clock, so P 0.1 lists it as an exception. Test 67, CP C06 step 7. |
| 6 | `RS` alone can recover, add devices and reset the password silently | **Right; fix partly limited** | P 8.2: recovery on an account with an active device is held under the P 7.3 approval and waiting rules, every active device is told, and the password is set only inside that recovery session. A phrase holder with no active device is unaffected. Limit stated (P 8.2, TM A4b, L17): a thief who controls an active device approves its own recovery, so "Secure my account" stays the remedy. Cost flagged for the product owner: the phrase is no longer immediate while a device, even a lost one, is still registered (DEC E.8). TM A4b's claim about the password was wrong as written and is corrected. Test 68, CP C26. |
| 7 | https invite link leaks the token to the host | **Right** | Invites are shared only as `housecall://` links or copyable text; the `https://` form is removed and forbidden. Joining with pasted text in the web client is stated to give the invite to the host (P 5.2, P 20.3, TM A2b and L12, DEC 20). CP C02 step 9. |
| 8 | Manual rotation not in the log | **Right** | New log entry `channel_rekey` (kind 18; public: admin or owner; private: any member); P 9.1 reason 4, 9.3 trigger, and the `affects` table. |
| 9 | Auto-approval fires although devices were in use; one request blocks the account | **Right** | P 7.3 step 6: auto-approval only if no active device opened a session in the window, otherwise the request is discarded. Deny cooldown applies to the source and `device_pub`, not the account; at most 3 outstanding per account, 1 per `device_pub` (P 7.3 step 4, P 18). TM A5a, DEC 14, CP C15 step 7. |
| 10 | Offline guessing costed per CPU core; score 3 falls in about a GPU-day | **Right** | Policy raised to zxcvbn score 4 (P 0.4, 2.1, test 28). The GPU figure (about 10^3 guesses per second) is the reviewer's estimate and is labelled as one; C09 must measure it. P 2.3 and TM L2 state it, P 2.5 says a provider disk snapshot is a whole-machine image, DEC 28 rewritten, CP C09 (`weakish` is now made with a client that skips the check). This changes sign-up for users and is flagged as a decision for the product owner (DEC E.5). |
| 11 | Level 4 shown while a participant uses the web client | **Right** | `platform` added to the signed `DeviceCert` (P 1.2) and a device-list route (P 21). New channel factor "Member on web app" (level 3), a new fixture, and a level-4 sheet sentence ending "as long as everyone in it uses the app" (SL 1, 2, 3, 6, 10, 11, 12). A host can withhold a certificate, so the factor can miss a web user; SL 12 and the web-member sheet text say so. I did not change the rank of the web factor (3): levels order what the host reads by design, and the factor never claims end-to-end encryption. |
| 12 | `verify-web` cannot detect a swap aimed at one user | **Right** (sub-point moot) | P 20.2, 20.3, TM A11 and L12, DEC item 9 and CP C16 now say it catches only a swap served to everyone. The finding also asks to remove detection from the web text in SL 6; that text never mentioned detection (it says "use the desktop or phone app"), so nothing was removed there. |
| 13 | Server file conversions replace the sender's file | **Right** | P 15.5: the sender's original is shown by default; a derivative only when the original cannot be played, labelled "Converted by the server". DEC E.12. |
| 14 | `push_text` notification text is unauthenticated | **Right; implemented slightly differently** | P 15.5 and 17.3: the sealed payload carries the original signed `Message`; the device verifies and decrypts it and shows only that, otherwise content-free. The host writes no title or body. Consequence stated: for a message that fits, the host no longer needs to read it, yet the feature keeps class T and its level in v1. Whether to drop the T wrap is flagged (DEC E.9). This needs the iOS extension to read keys and the member list from the app group (spike 7 updated). Test 72, CP C23. |
| 15 | Clear call media not forbidden; frame-cryptor behaviours unpinned | **Right** | P 12.1 gains three client rules (refuse clear media, drop frames that do not decrypt and any pass-through for injected frames, bump `g` before the per-key frame limit). The reviewer's statements about LiveKit's injected-frame marker and IV construction are from memory and are not asserted as fact: they are open questions in spike 6 (P 24). Test 71, CP C04 step 4 and C12 step 4. |
| 16 | `call_rekey` can move a call to an old epoch's key | **Right** | P 12.3: generation must be current plus one and `epoch` must equal the carrying message's epoch and the reader's highest adopted epoch. CP C03 step 8, test 71. |
| 17 | Private account state can be rolled back | **Right** | P 7.5: clients keep the highest version seen and reject lower ones; a Lamport counter is merged across servers and a new device takes the highest. Test 74. |
| 18 | Host passphrase has no strength rule | **Right** | P 2.5, 15.4, 0.4: the passphrase is generated at install (8 BIP-39 words, 88 bits) and never chosen by the operator. DEC 18, CP C20 step 6. |
| 19 | Bots can be friends and DM partners | **Right** | P 13.2, 13.3, 13.4 reject any request, DM or group-DM add involving an account with role `bot`; P 16.2 reworded to match. Test 70, CP C14 and C28. |
| 20 | Relay cannot tell who owns a `server_id`; `push_key` shared across servers | **Right** | The relay no longer has a registry of server ids. An alias is bound to the `relay_pub` the server publishes, and pushes must be signed by that key (P 17.1, 17.2, 21). `push_key` is per (device, server) (P 1.2). TM A10, test 72, CP C23 step 3. |
| 21 | "Current" vs "at `log_seq`"; "affecting this channel" undefined; ALERT has no exit | **Right** | P 9.3 gains the `affects` table; a full-history join does not rotate (grants cover every epoch, the current one included); P 9.4 evaluates rules 1 to 3 at the header's `log_seq` and rule 4 at the reader's head; the redundant `from_now` bullet in P 9.2 is removed; the server validates headers (P 9.2 step 5); P 9.7 gets an exit from ALERT; P 9.6 names every entry kind that can carry `full`. |
| 22 | `features_set` validity rules missing | **Right** | P 3.3 kind 9: features on iff `host_key` not null; a new `key_id` must not have appeared before; a `pub` never changes for a `key_id`; the entry must change something. `ARMING` has no log form (P 15.2). Test 69, CP C13. |
| 23 | Passphrase-locked server contradicts OPAQUE; two salts | **Right** | P 2.5 and 15.4: a locked server refuses password sign-in, registration, joining, join and replacement requests, while registered devices keep working; one `wrap_salt` is kept in the server config and `salt` is dropped from `HostKeyFile`. Test 60, CP C20 step 6. |
| 24 | Version rule contradicts the threat model | **Right** | P 0.1: a v1 client accepts exactly `v = 1`; later versions state a minimum per object type. |
| 25 | Domain-separation rule not followed | **Right** | P 0.2 now states the rule that is actually followed (one label per object; a signature and the hash of the same object may share it; no label for two objects). `login`, `pwchange-ctx`, `bot-pop`, `classkey/t|f|u`, `host-at-rest/key`, `host-at-rest/opaque`, `host-at-rest/<feature>` and `host-at-rest/bot` added to P 0.6; the password-change OPAQUE context and the class-key KDF labels renamed so they no longer share a label with a signature or an AAD; every `H` call in the document now has a label. The reviewer found no constructible collision, and this change does not claim one. |
| 26 | Password-change and recovery signatures not bound to a server, login or version | **Right** | P 2.6 step 2 signs `H("hc/v1/pwchange", server_id, login_id, u32be(version+1), upload, blob)` and requires a session of the same device on the same server; P 8.2 uses the same signature with the recovery session as `login_id`. CP C26 step 4. |
| 27 | Source of a new device's pin | **Right** | P 3.5 item 1 now names the invite link, the account's `State`, and first-contact trust, and notes the OPAQUE identity and the blob AAD as the bindings that exist. |
| 28 | `dm_id` identical across home servers; DMs have no log | **Right** | `dm_id` includes the home server (P 0.5); DMs use `log_seq = 0` and zero `log_head8` and skip the log checks; epoch state is kept per `(home_server, dm_id)` (P 13.3). Test 75, CP C28. |
| 29 | Safety number not fully defined | **Right** | P 13.5 defines it as six 5-byte chunks of the first 30 bytes, each mod 100000 (the reviewer's "six 5-byte chunks" needs 30 bytes, not the 15 the text said). P 0.5 reference fixed. |
| 30 | `bot_add.pop` undefined | **Right; label changed** | P 3.3 kind 10 and P 16.1 define it. The reviewer proposed reusing `hc/v1/join-pop`; I used a new label `hc/v1/bot-pop` and `name` in place of `username`, so a bot pop can never be replayed as a member pop (P 0.6). |
| 31 | Attachment deletion has no authority | **Right** | P 10.3 and 11.7: the POST carries a clear `blobs` list, the server stores `msg_id → blob_id` after checking the sender uploaded each, and only the sender or an admin who is a member of the channel may delete. P 19.1 lists the new metadata. Test 73, CP C27. |

### Where the fixes are weaker than the findings suggest

- **Finding 5** is not closed. The server alone can no longer freeze a client, but a server plus a still-listed accomplice can. Closing it needs something outside the log, such as owner-only checkpoints, which would make small servers unusable while the owner is away.
- **Finding 6** does not protect a user whose stolen device is still active, because that device approves its own recovery.
- **Finding 4** leaves one case: a removed member's backdated message that reuses a sequence number it skipped.
- **Finding 11** relies on device certificates the host supplies, so a hostile host can hide a web user.
- **Finding 15** rests on LiveKit behaviour that is unverified; spike 6 must check it before the rules in P 12.1 are relied on.

### New questions for the product owner

Listed in `DECISIONS.md` section E, items 5 and 8 to 12: score-4 passwords, the recovery phrase no longer immediate while a device is registered, whether `push_text` should keep the host reading text, the fresh-head rule's cost to quiet servers, frozen private channels, and file conversions shown only as a fallback.

### Not re-reviewed

This pass fixed the documents against the review. It did not look for new problems introduced by the changes, apart from checking that references and constants agree across the five documents. A second adversarial pass over the revised text has not happened.
