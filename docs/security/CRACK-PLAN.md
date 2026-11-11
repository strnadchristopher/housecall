# Crack plan

The attack tests an independent tester runs against the implemented Housecall system (decision D3). Results, fixes and retests go in `docs/security/CRACK-REPORT.md`. The README states what was tested and that no human audit has happened.

Each test gives the **setup**, the **steps**, and the **break**: the observable result that counts as the attack succeeding. A test passes (the system held) when no break condition is observed after every step has been tried, including the variants. Where a result is a documented limit (`THREAT-MODEL.md` L-ids), the test says "expected" and the tester records it without counting it as a break.

## 1. Rules

1. **Independence.** The tester is not the model or person who wrote the implementation, and starts from this plan, `PROTOCOL.md`, `THREAT-MODEL.md`, `SECURITY-LEVELS.md` and the source tree at a recorded commit. The tester may read anything. Tests that need code run against that commit's build.
2. **No hooks in the product.** The tester plays the attacker by sitting between components (a proxy that edits responses, a modified server binary, a modified client, direct database edits), not by flags built into the product. The only allowed test aid is a separate **oracle build** of the server and client that prints secrets to a file the tester reads (used to check "was this key recoverable" questions in C20); the oracle build is never the build under attack in other tests.
3. **Real system.** Tests run against the running system: one or two servers from the compose file, real clients (native headless harness and the web client in a browser), LiveKit, and the push relay in test mode. Stubs, fixtures and unit tests do not count.
4. **Record everything.** Every step is a command or script saved with its output. A break needs a reproduction a third party can run.
5. **Retest.** After a fix, the whole test is rerun, not just the failing step, on the new commit.
6. **Severity.** *Critical:* someone outside the intended readers reads content, or forges content or membership accepted as genuine. *High:* an attacker takes over an account, silently gains host access, or defeats a stated control. *Medium:* a level or label overstates, a detection is missing, or a limit is wider than documented. *Low:* hardening.

## 2. Test environment

| Item | Value |
|---|---|
| Servers | S1 (main) and S2 (second server, for cross-server tests), fresh data directories, TLS from a test CA trusted by the clients |
| Accounts on S1 | O (owner), A (admin), M1, M2, M3 (members), R (member to be removed), X (an outsider with only an address), Steve (bot, enrolled) |
| Channels on S1 | `#general` (public), `#side` (public), `#priv` (private: O, M1), `#bots` (public, Steve added), one DM (M1–M2), one group DM (M1, M2, M3) |
| Devices | each account has one device; O and M1 also have a second device for approval tests |
| Passwords | each fixture account has a password that meets the policy; two extra accounts for C09: `weakish` (zxcvbn score 3, made with a client that skips the check) and `strong4` (score 4, the weakest the policy allows) |
| Canaries | each test plants unique strings in message text, file names, channel names, passwords and URLs, and searches for them after the test |
| Tester tools | a mitmproxy-style HTTP/WebSocket editor, a modified server (a patched copy of `housecall-server`), a modified client harness (can sign arbitrary objects and build arbitrary headers), a CBOR editor, a packet capturer, a disk-image exporter, a browser with devtools |

## 3. Tests

### C01. Ghost member

Property: P3. Adversary: A2b, A6.

Setup: S1 with the fixtures. Tester controls the server process and database, and holds a key pair `G` that is not in the log.

Steps:
1. Insert `G` into the server's member tables and into the member list API response for `#general`.
2. Append a `member_add` for `G` signed by (a) `G` itself, (b) M1, (c) a bot, (d) an admin that was removed earlier, (e) A but with a broken `prev`, (f) A with a valid signature but a `pop` made by another key.
3. Make A remove M2 (forces a rotation of `#general`). Let honest clients pick the winner header; also serve a header authored by M1 (modified client) with `G` among the recipients, and one authored by the server using a member's stolen session.
4. Serve honest members a log copy that omits A's removal of M2 but contains the ghost.
5. Ask honest M1 to add a bot or member so that a header is created while `G` is listed in the server's own view.

Break: any honest client (a) lists `G` as a member, (b) produces an HPKE wrap addressed to `G`, (c) adopts a header that lists `G`, or (d) shows level 4 while `G` is in the current epoch's recipients. Observable: `G` decrypts any message sent after step 1 using only what the server delivered to it.

### C02. Key substitution on join

Property: P3. Adversary: A2b.

Setup: S1. O creates invite I1 (history `from_now`). X holds the link. Separately, X asks to join without a link as user `dana`.

Steps (invite):
1. Server captures X's join submission and replaces X's `AccountPub` with the tester's own key `K`, keeping X's `invite_pop`.
2. Server builds its own `member_join` with `K` using the public `InviteCert` and a made-up `invite_pop`.
3. After X's genuine join lands, server (or tester with the link) tries to use I1 a second time for a different key.
4. Server replays X's join entry onto S2 (cross-server replay) and replays a `member_join` from another invite.
5. Take a leaked link (tester has `token_seed`) and join before X: record the result (expected: tester gets in, a leaked link is a bearer secret; the log must still show single use).

Steps (tokenless):
6. Server swaps `account_pub` in the pending request shown to A with `K`. A's client computes the six-word code from the key it was shown and compares with the words X reads out.
7. Server swaps the key and also grinds a second key to match the first words of the code: measure how many words match after 10^9 attempts (expected: not all six). Then run the **birthday variant**: the server serves X one `request_id` and the admin another, and searches pairs of values until the two codes agree. In the spec as it stands there is no server-chosen value in the code, so the search has nothing to vary except the server's own key (a 66-bit preimage). Break: any value the server chooses is an input to the code.
8. Server relays X's `pop` for another username.
9. Share an invite as text and open it in the web client: record that the host's page sees the token (expected, L12). Check that no screen of the app produces an `https://` invite link.

Break: any log entry binds a username to a key other than the one X generated, without X's `token_priv` (steps 1, 2, 4); the entry is accepted as valid by clients; A's client allows approval when the words do not match (step 6) or has an approve-without-check path; the six-word check is computed from anything the server controls; step 3 produces a second valid join for one invite. Step 5 success is expected and not a break.

### C03. Replay and reordering

Property: P2. Adversary: A1, A2b.

Setup: `#general` and `#side` with M1, M2, M3. Tester captures traffic and can inject on the server side and client side.

Steps:
1. M1 sends messages 1 to 5. Redeliver 3 twice.
2. Deliver message 3 into `#side`; relabel its `channel_id`, `epoch`, `sender` and `msg_id` fields one at a time.
3. Deliver 2 and 4 in swapped order; drop 3 entirely.
4. M1 edits message 2 twice (edit A then edit B). Replay edit A after edit B.
5. M1 deletes message 5. Replay message 5 afterwards.
6. Replay an old epoch header and its wraps as if they were new; replay an old `features_set`, `member_remove` and `member_add` log entry at the head.
7. Replay a captured session signature, a device `approve`, a friend request and a `join` submission.
8. Replay a call `call_rekey` message from an old generation. Also send, as a current member, a `call_rekey` in epoch `n+1` that names epoch `n`, and one whose generation is not the current one plus one.

Break: a message shown twice; a message accepted in another channel, epoch or under another sender; a swap or drop that raises no gap indicator for the sender's sequence (observe the UI and the client's event log); the older edit overriding the newer; the deleted message reappearing; a replayed header, log entry, session signature, approval, friend request or join accepted; an old `call_rekey` lowering the call generation.

### C04. Downgrade

Property: P1, P2, P4. Adversary: A1, A2b.

Setup: S1 and clients.

Steps:
1. Alter `v` on envelopes, headers, log entries and blobs to lower and unknown values; strip `host`, `checks`, and AEAD fields; swap the AEAD or KDF label.
2. Serve the legacy routes (`/api/login`, `/api/setup`, passkeys, email invites, plaintext message POST) and see whether any client or server path still accepts a password or plaintext.
3. Make the server refuse every new epoch, offer a "send unencrypted" path, or claim E2EE is unsupported for a channel.
4. In a call, make the SFU or token service report that frame encryption is off, or provide a room where the client is asked to publish without a key (PROTOCOL 12.1 rule 1: the client must refuse). Inject frames that carry the SDK's server-injected-frame marker, and frames that do not decrypt (rule 2: the client must drop them).
5. Strip TLS on first contact (plain `http`), downgrade to an old TLS version, serve a certificate for another name.
6. Return a feature status that says everything is off while the log shows features on, and the reverse.
7. Offer a lower `min_version` to a client through the update manifest or web manifest.

Break: any path in which a client sends a password, plaintext content, or unencrypted call media; accepts an object it should have rejected; connects over plain http to a non-loopback host; or displays the server-reported feature state instead of the log's.

### C05. Epoch rollback

Property: P3, P5. Adversary: A2b.

Setup: `#general` has epochs 0, 1, 2. R was a member through epoch 1 and was removed (epoch 2 excludes R). M1 has stored epoch 2. M3 is a new device with no stored state.

Steps:
1. Serve M1 the epoch 1 header and wraps as current.
2. Serve M3 (fresh device, valid password and approval) epoch 1 as the latest.
3. Serve M3 a header for epoch 2 with an older `log_seq` than the removal.
4. Serve two different valid epoch 2 headers to M1 and M2 (equivocation).
5. Refuse to store epoch 3 so that clients need it.
6. Make a client send under the rolled-back epoch and then read what R sees.

Break: any honest client encrypts under an epoch older than its stored one or an epoch that still lists a removed member; M3 sends under epoch 1; the UI shows level 4 in any of these states instead of 0; equivocation raises no alert. Sending that fails with an error is a pass.

### C06. Log rollback, fork, withholding

Property: P3, P6. Adversary: A2b.

Setup: S1. M1 and M2 have verified the log up to seq N. Tester controls what each sees.

Steps:
1. Serve M1 the log truncated to N-3.
2. Serve M1 and M2 different logs from seq N+1 (fork: one has a ban of M3, the other not). Then have M1 send a message to `#general` that M2 receives.
3. Serve M2 messages whose `log_seq` is above M2's head, and withhold the log entries for 60 seconds.
4. Serve a log head that is 25 hours stale to a client that is online.
5. Replace entry 0 (genesis) with another valid genesis (different owner).
6. Serve a log in which entry N is changed but re-signed by an old admin key.
7. **Frozen view.** Owner removes R at seq `r`. Serve M1 the log only up to `r-1`, with heads that keep arriving, and withhold every object with `log_seq >= r`. (a) No one signs on the frozen branch: wait 25 hours. (b) R, still listed on the frozen branch, signs `checkpoint` entries on it (expected to keep M1 fresh: a split view sustained by a listed accomplice, L7; record it). (c) A plain member other than R tries to keep it fresh with entries from before `r`. Check that M1 sends nothing under epoch `n` after the head stops being fresh in (a) and (c).

Break: any client keeps level 4 after step 1, 3, 4, 5 or 6; M1 keeps sending in a channel with other members after 24 hours without a fresh entry from another member in step 7(a) or (c); M2 shows no alarm after step 2's cross-message; a client accepts a genesis other than its pin; a client accepts an entry signed by a signer that was not allowed at that seq.

### C07. Removed member reads new messages

Property: P5. Adversary: A3 with a colluding server (A2b).

Setup: `#general`, `#priv` (R is in `#priv`), R is a member of both with `full` history. O (or A) removes R. R runs a modified client. The server cooperates fully: it gives R every ciphertext, every wrap ever created, and refuses to drop R from any list.

Steps:
1. After the removal entry is verified, A and M1 send ten messages in each channel. One of them is sent while the rotating device is offline (lazy-rotation path).
2. R tries to decrypt every new message with every epoch key R holds, with every wrap the server has for R, and by asking the server to wrap new epochs to R.
3. R tries to get an honest sender to encrypt under the old epoch: server delays or refuses the new epoch; server serves the pre-removal log to A's device after the removal was verified.
4. R forges a post-removal message with the old key into the old epoch, signed with `log_seq` from before the removal and the correct `log_head8`, in a channel that is still on epoch `n` (the rotation has not happened yet), and has the server deliver it live to M1. Repeat after rotation, with the server calling it backfill and placing it among genuine history in `server_seq` order, with a `sender_seq` above and below the `closed` number in the epoch `n+1` header.
5. R tries to rejoin with the same key; with a new key and the same username; with an old invite.

Break: R decrypts any message that was sent after the sender verified the removal; any honest sender uses the old epoch after verifying the removal; R's live message is displayed as a new message; the rejoin succeeds. R reading messages sent before the removal is expected (L4).

### C08. Removed member plus server injection into old history

Property: P2, P5. Adversary: A3 with A2b.

Setup: As C07, R's key still valid for signing.

Steps:
1. Server inserts messages signed by R into epoch 1 at positions earlier than the removal, with plausible `sent_at` and `sender_seq`.
2. A fresh device (backfilling) and an online client (live) both receive them.

Break: an online client displays one of R's messages as new, live traffic after it has adopted a newer epoch, or after it has verified the removal; any message from R above R's `closed` number (or from a device not listed) is displayed, live or backfilled. Backfilled display of R's backdated messages in old epochs is the documented residual (L4, L8): record it, check that its `log_head8` and `sender_seq` are shown as unusual if they conflict with R's real sequence, and do not count it as a break unless the UI also marks it live.

### C09. Offline password guessing cost

Property: P4. Adversary: A2a, A2b (L2).

Stated parameters: OPAQUE with ristretto255 and 3DH, key-stretching function Argon2id with **m = 64 MiB (65536 KiB), t = 3, p = 1**; password policy **12 bytes minimum, zxcvbn score ≥ 4**; blob key = HKDF of the OPAQUE export key; server OPAQUE secret wrapped under `WK` outside the data volume.

Setup: S1 with the fixture accounts plus `weakish` (password with zxcvbn score exactly 3, which the policy rejects: create it with a modified client that skips the client-side check, since the server only enforces the 12-byte minimum; it stands in for the weakest password a user could ever get past a score check) and `strong4` (score exactly 4). Three adversary positions: **(a)** data volume and backups only; **(b)** data volume plus `WK` (whole machine); **(c)** the account's own blob and OPAQUE record from a malicious server's view.

Steps:
1. From the code and from running the client with timing and memory probes, confirm the actual Argon2id parameters used by registration, login, and blob key derivation on native and WASM. Capture peak memory and number of passes.
2. Position (a): with only the data volume, try to test any password guess against any account (extract the OPAQUE record, the blob, anything else). Try to find `ServerSetup` or `WK` anywhere on the volume, in backups, in the DB, in logs, in environment dumps.
3. Position (b): extract record, blob and `ServerSetup`. Write a guessing harness that, for each candidate password, performs the real key stretching and tries to open the blob. Measure guesses per second for one core and for the best GPU or many-core machine available (the spec's estimate is about 10^3 per second for one high-end GPU; record the real figure and the memory use per guess). Run it against `weakish` and `strong4` with dictionaries that contain their passwords at known ranks, and extrapolate the time for 10^8 and 10^10 guesses.
4. Try shortcuts: skip OPAQUE and attack the blob directly; skip the full stretch by using partial computation; check whether the blob key depends on anything cheaper than the full KSF output; check whether the client can be made to use lower parameters (server-supplied parameters, a downgrade, an old record).
5. Try the policy: register with passwords of 11 bytes, 12 bytes with score 2, 12 bytes with score 3, and with a Unicode-equivalent form (NFKC composed vs decomposed) and confirm the same password works on both.
6. Record the cost model: seconds per guess on the reference machine, memory per guess, and the arithmetic for 10^8 guesses (the least a score-3 password is estimated to need), 10^10 (score 4), and 10^12.

Break: (i) position (a) can test any password guess; (ii) in any position a guess costs less than one full Argon2id evaluation at the stated parameters, or the measured parameters are lower than stated; (iii) a client accepts parameters from a server; (iv) the blob can be opened without the export key; (v) the policy admits a password it should reject; (vi) different NFKC forms of one password give different keys. Position (b) cracking `weakish` is expected (L2): record the time it took and the guess rate, and check it agrees with the cost model in step 6. For reference, at 0.1 s per guess per core, 10^8 guesses is about 10^7 core-seconds (about 116 core-days); at 10^10 it is about 10^9 core-seconds (about 32 core-years). The tester records the real number.

### C10. Malicious member

Property: P2, P3, P6. Adversary: A6.

Setup: M1 runs a modified client. All other accounts are honest.

Steps:
1. Author a header for `#general` listing an extra recipient (a second key of M1, a bot, the host key id), missing a member, or with a wrong `prev_hash`, `epoch`, `log_seq`.
2. Wrap a wrong key to M2 (valid header, key check mismatch) to cause M2 to lose the channel.
3. Send messages as M2 (forge sender), with M2's `sender_seq`, with another `device_id`.
4. Edit or delete M2's message; pin; react as M2.
5. Sign log entries of each kind (`member_add`, `role_set`, `features_set`, `bot_add`, `channel_member_add` for `#priv`).
6. Send a `call_rekey` with a bogus generation, and a `call_start` for a call that does not exist.
7. Send huge messages, 21 attachments, malformed CBOR, deep nesting, a long username, display names with bidirectional controls.
8. Send friend requests with M2's name; spoof mail `from`.
9. Hand a copy of M1's keys to the server (modified server) and see whether the server gets anything beyond what M1 could read (expected: exactly what M1 could read, L15).

Break: any honest client accepts steps 1 to 6, 8, or crashes or hangs on step 7; M2 loses access permanently from step 2 (a temporary denial that clears when the next valid header arrives is a pass); M1's leaked keys reveal anything outside M1's own access.

### C11. Silent enabling of host access

Property: P6. Adversary: A2b (no owner key), then A9.

Setup: S1 with all features off and no host key file. O's key is not available to the tester in steps 1 to 8.

Steps:
1. Set every environment variable, config key and CLI flag the code reads that looks like a feature switch (`HOUSECALL_*`, push, scan, search, link-preview). Edit the database rows for features, if any. Restart.
2. Request `POST /v2/host/key` without an owner session; with an admin session; with a member session.
3. Forge a `features_set` entry: signed by A, by a bot, by M1, by the host key, by an expired owner key, with a bad `prev`, as a replay of an older valid entry (build one first: O enables then disables `scan`; replay the "on" entry).
4. Serve `GET /v2/host/status` saying features are on (and, separately, off while the log says on).
5. Serve honest clients a log that omits a real `features_set` entry.
6. Cause rotations (remove a member with A) and inspect whether new headers carry any `host` field.
7. Run the server process with a debugger: check whether any code path unwraps a class key without a corresponding wrap authorised in the log.
8. Have a modified member client wrap the epoch key to a host key (L15).
9. Now O genuinely enables `push_text` and `scan` through the owner's client. Check: the notice appears in every member's `#general` and `#side` in the right place; the levels change as in `SECURITY-LEVELS.md` section 11; the host can decrypt message text and file bytes in **new** epochs of **public** channels; it cannot decrypt **old** epochs, `#priv`, the DM, the group DM, call media, or file bytes with `push_text` only.
10. O disables both. Check the notice, the new epochs, the destruction of the host key file and artifacts, and that new messages are unreadable to the server.

Break: in steps 1 to 8, any honest client produces a host wrap, any header with a host entry is accepted, the server decrypts any message text or file, any feature runs, or a client's UI shows level 4 while host wraps exist. In step 9, a member's client fails to show the notice or the lower level; the host reads anything outside the stated scope. In step 10, the host key file or a derived artifact (index, thumbnail, derivative, preview cache) is still present, or new epochs still carry host wraps. Step 8's leak is expected (L15).

### C12. Call keys, removal and the SFU

Property: P1, P5. Adversary: A3, A2b (SFU).

Setup: `#general` call with M1, M2, M3, R and Steve (DJ) publishing audio and video. LiveKit logs and packet capture enabled.

Steps:
1. Capture the media at the SFU and try to decrypt it with everything the server and SFU know (room name, identities, tokens, DB).
2. A removes R during the call. Measure when R's decoder stops producing output. Keep R connected to the room (server refuses to kick).
3. Make the SFU relabel a participant's identity; add a participant with a server-minted token for a ghost identity that is not a member.
4. Make the server mint a token for a room without frame encryption; try to publish an unencrypted track. Inject frames with the SDK's server-injected-frame marker through the SFU. Measure the frame count per key in a long call (spike 6) and check that `g` is bumped before it.
5. Two members remove at the same moment (concurrent rotation). Check that the call re-keys once and all participants agree.
6. A new member joins mid-call with `from_now` history; check that they cannot decode media from before they joined.
7. Join with a modified client that derives sender keys from the wrong epoch.

Break: the server or SFU decrypts any frame; R decodes frames sent more than 10 seconds after the re-key; a relabelled identity is accepted and decoded; the ghost's presence is shown as a verified member; the client publishes unencrypted media; participants disagree on the key after step 5 for more than 15 seconds; the new member decodes earlier media.

### C13. Malicious admin

Property: P3, P6. Adversary: A7.

Setup: A is an admin and uses a modified client.

Steps: sign (and submit, and also serve directly to clients) each of: `features_set`, `role_set` (make A owner, make M1 admin), `member_remove` of O, `member_remove` of another admin, `channel_member_add` to `#priv`, `server_meta` changes, `member_add` for a username that is banned, `member_add` with a bad `pop`, `bot_add` with a mismatched key, an invite after A was demoted. Also: try to read `#priv`, the DM and the group DM through any API (history, wraps, search, reports, bot); try to add Steve to `#priv`; try to approve a join request without the words, and with the wrong words; use an admin to issue `full` history to X for `#priv`.

Also: A signs `key_replace` for the owner (with and without `old_proof`), for another admin, and for a member who is in `#priv` (check that the new key gets no `#priv` membership without `old_proof`); after O removes A, A submits `member_add`, `channel_member_add`, `bot_channel_add` and an invite issued before the removal; after the creator of a private channel is removed, the creator and the owner try to add members (the channel must be frozen); a `features_set` with a feature on and no host key, with a key but all features off, and with a reused `key_id`.

Break: any accepted entry that the table and rules R1 to R3 in PROTOCOL 3.3 forbid; any content readable for A from `#priv` or DMs; approval with the wrong words.

### C14. Bot key theft

Property: scope of A8. Adversary: A8.

Setup: Steve is added to `#bots` only (history `from_now`). `#general`, `#priv`, the DM and group DM contain canary messages. Tester has (a) a disk image of the bot host's data directory only, (b) the same plus `BWK`, (c) the running process memory.

Steps:
1. (a): try to read `RS_bot` and any epoch key.
2. (b): use Steve's keys against the server with a modified client: ask for wraps for every channel; try to decrypt canaries in each; try to read `#bots` history before it was added.
3. Sign every kind of log entry with Steve's key; try to add itself to `#priv`; try to approve devices, join requests, invites; try to join the DM or group DM.
4. Try to extend the bot's reach: request wraps for `#general` using Steve's session, or have a member client (modified) wrap for Steve.
5. A removes Steve from `#bots`. Check rotation. Use the stolen keys against new messages in `#bots`.
6. Check which endpoints Steve's chat and speech endpoints received (canary visible there is expected, L13).
7. Check how the bot host's logs and config store the endpoints' credentials and the wrap key.

Break: (a) yields any key; Steve's keys decrypt a canary outside `#bots` or `#bots` content before the add; any accepted forbidden entry; the removal does not stop reads of new messages; `BWK` is stored beside the data it protects (document the actual location and record whether the default install keeps them apart; together on one disk is a break of the default only if the docs say they are separated). Reading `#bots` content from the time added through removal is expected (L13).

### C15. Device approval bypass

Property: P4 (and L3). Adversary: A5a.

Setup: account U has one active device D1. Tester has U's password and a new device identity D2. The server is honest unless the step says otherwise.

Steps:
1. D2 does OPAQUE login. Record `status`. With the `pending` token call every endpoint (messages, wraps, log, devices, state, blobs, `GET /v2/devices/pending/<id>` for other ids).
2. Fetch the blob in every way: the pending poll before approval, the login response, the recovery endpoint with the wrong signature, `POST /v2/devices` with a self-made certificate (D2 does not have `RS`, so it cannot make a valid one; try a certificate made with another account's key).
3. Forge approvals: signature by D2's own key, by a revoked device of U, by a device of another account, by D1 for a different `pending_id`, for a different `device_pub`, expired (after 10 min), replayed from an earlier approval.
4. Type the wrong 6-digit code on D1 (client check), then try to get the server to accept an approval that skips the code (modified client for D1 is not an attack here, the approval is the real D1 signing; instead tamper with `device_pub` between request and the approver's screen: the code must not match).
5. Brute-force the code: send 100 approval requests with distinct codes; check the 5-wrong-codes cancel.
6. Race: approve and deny at once; two pending requests at once; deny and immediately request again (cooldown).
7. Wait for the 7-day auto-approval with the clock moved forward in the test (server clock, then client clock, then a forged `created_at`): it must happen only after 7 server days, with notifications, and be marked "approved by waiting period". Then repeat with D1 opening a session on day 3: the request must be discarded at day 7, not approved. Also have the attacker file a request, then check that U can still file a legitimate request from a new device (slots, and no cooldown on the account), and that denying the attacker's request does not block U.
8. Malicious-server variant (not counted as a break): modify the server to release the blob without approval. Record that it works (L3) and what the attacker then needs (the password, so C09 applies).
9. Sign out the only device and sign in again with the password: it must work without approval (by design).

Break (honest-server variants, steps 1 to 7): the blob, `RS`, a session beyond `pending`, or an active device is obtained without a valid approval or the 7-day wait; an approval is accepted when signed by anything other than an active device of the same account, for the pending request, before expiry; the code check can be skipped; wrong-code attempts are not limited; the cooldown is bypassed. Step 8 and step 9 are expected.

### C16. Web bundle swap

Property: P1 on web, L12. Adversary: A11.

Setup: web client served from S1, service worker installed, release key public in the repository, a signed manifest.

Steps:
1. Change one byte in a JS file; serve it with the old manifest.
2. Change the file and recompute the hashes in the manifest, but without a valid signature; and with a signature from another key.
3. Serve an older signed manifest (lower `version`).
4. Swap the WASM; swap the service worker file for one with no verification (after the first install).
5. Add an inline script, an external script, an external image, a form action to another origin, a frame: check the CSP and Trusted Types.
6. **First load:** serve a malicious bundle to a browser that never visited. Record that it runs (expected, L12) and check that the first screen shows the installed manifest version and the verification link, and that `housecall verify-web <url>` run from a separate machine reports the swap **when it is served to everyone**. Then serve the malicious bundle only to a target (by cookie or address) and a clean one to `verify-web` (by user agent): record that `verify-web` reports clean (expected, L12; PROTOCOL 20.3) and that the first screen's manifest version, drawn by the page, shows what the host chose.
7. From a script injected into the main thread (simulating XSS), try to read `RS` or any epoch key (from memory, IndexedDB, the Worker).
8. Check the security label while on web, and the label a native member sees in a DM and a channel with this web user in it ("Member on web app", never level 4).

Break: steps 1 to 3 accepted by the service worker; step 5 lets script or data execute or leave the origin; `verify-web` accepts a swapped bundle that was served to everyone, or a rolled-back manifest; the target-only swap going undetected is expected; step 7 extracts `RS`, an epoch key or the session signing capability as raw bytes (using the Worker as an oracle for decrypt/sign calls is expected: note it); the web UI shows "End-to-end encrypted" at any point. Steps 4 (service worker replacement) and 6 are expected (L12): record what the user sees.

### C17. Stolen device

Property: A4. Adversary: A4a, A4b.

Setup: desktop (Linux, macOS, Windows as available), Android and web, each signed in as M1 with some history and a search index.

Steps:
1. **Closed device.** With the app not running, copy the data directory (or Android app data and backup), the browser profile for web, and the OS user directory. Search for `RS`, `DK`, epoch keys, plaintext message and file canaries, search-index tokens, thumbnails. Start the app on another machine with the copied data and try to sign in.
2. **Open device.** With the app running and the screen unlocked, from another device of M1 revoke this one. Time to the session ending, including WebSocket.
3. "Secure my account" from the other device. Admin approves. Check rotation of every channel M1 was in; check the stolen device's old key against new messages; check that history the user chose to regrant arrives only on the new key.
4. On the web, sign in without "remember", close the tab, open IndexedDB and local storage.
5. Check that changing the password on the stolen open device requires the old password.

Break: any of `RS`, `DK`, epoch keys, or message plaintext readable from the copied data without the OS secure store; the copied data signs in elsewhere; a revoked device keeps a session for more than 30 seconds or on a socket; the old key reads messages sent after the replacement's rotation; web storage contains `RS` without "remember"; step 5 succeeds without the old password. The stolen open device reading its own history until revoked is expected (L1, L5).

### C18. Online guessing, lockout, enumeration

Property: P4. Adversary: A5d, A1.

Setup: S1 with M1 (and a second device) and a username `ghostuser` that does not exist.

Steps:
1. Send 200 login attempts for M1 with wrong passwords from one source, then from rotating sources (IPv4 and IPv6 /64 changes, spoofed `X-Forwarded-For` from an untrusted peer).
2. Count the guesses that reach the password check per 10 minutes and per day.
3. During the lockout, sign in with M1's registered device (signed session).
4. Compare responses for `ghostuser` and M1 (body, status, headers, timing with 10^4 samples, response to malformed input).
5. Flood the login endpoint from one source until it is limited; from another source, sign in normally.
6. Restart the server during lockout; check the lockout persists.
7. Try the join, join-request, recover, replace-request, friend-request and claim endpoints with floods.

Break: more than 5 password checks per 10 minutes at first, or more than 5 per 24 hours after repeated lockouts, for one username by any combination of sources; the lock stops a registered device from signing in; known and unknown usernames can be distinguished by content or by timing with statistical significance (report the effect size); one source's flood limits another source; a restart clears counters; a spoofed forwarding header changes the bucket.

### C19. Ban evasion and stale rights

Property: P3, P5. Adversary: A3, A7.

Setup: R banned; A demoted by O after creating an invite; M1 leaves `#priv`.

Steps: R tries to join with the old key, with a new key and the same username, with an unexpired invite A created before the demotion, with a join request; A's demoted invite is used; M1 (left) tries to read `#priv` messages sent after leaving; a removed admin submits entries.

Break: any join succeeds; any entry from a demoted admin or demoted-admin invite is accepted; M1 reads new `#priv` content.

### C20. Host key extraction from a stolen disk image

Property: P6, L11. Adversary: A2a, A9.

Setup: S1 with `push_text`, `search` and `scan` on for one day, with real traffic in `#general`. The wrap key `WK` is in its default location (a separate directory on the same machine, not in the data volume). A second run uses passphrase mode. An **oracle build** writes the host private key, the unwrapped class keys and a few message plaintexts to a sealed file the tester uses only for comparison.

Steps:
1. Image **the data volume only** (and a backup of it). Look for: the host key file; the host private key in any form; class keys; epoch keys; plaintext of any message; the search index in plaintext; thumbnails, transcodes and preview caches in plaintext; WAL and free pages; logs; temp files; the OPAQUE `ServerSetup`. Try to decrypt the host key file without `WK`.
2. Image **the whole machine** (default `file` mode). Recover `WK`, then the host key. Record this result (expected, L11).
3. Image the whole machine in **passphrase mode**, server stopped. Measure the cost per passphrase guess (Argon2id with m = 256 MiB, t = 3). Check whether the passphrase appears in the environment, process arguments, shell history, unit files, logs, or swap.
4. Take a memory dump or core dump of the running server (kill -SEGV; `gcore`; hibernation image; swap) and look for the host key and class keys. The server must have core dumps off and the key pages locked.
5. Disable every feature through the owner client; image again (data volume and machine). Look for any remaining host key file, wraps addressed to the old host key id, derived artifacts, index remnants.
6. Check that a **locked** host (passphrase mode, restarted, not unlocked) serves chat and calls to already-registered devices, sends content-free pushes and reports host features as unavailable, and that password sign-in, joining and registration are refused (PROTOCOL 2.5). Check that the passphrase was generated at install (8 words) and that the installer offers no way to choose one.
7. Look at the backup procedure documented for operators: confirm that following it does not put `WK` in the same backup as the data.

Break: step 1 yields the host key, a class key, an epoch key, a message plaintext or `ServerSetup`; step 3 yields the key at a cost below one Argon2id at the stated parameters per guess, or finds the passphrase anywhere on disk; step 4 yields any key (outside a debugger attached by root, which is expected); step 5 finds a host key file, a wrap addressed to the old key that still decrypts, or a derived artifact in plaintext; step 6 shows chat or calls failing for registered devices, a password sign-in or join succeeding while locked, or any plaintext push; step 7's documented backup keeps `WK` with the data. Step 2 yielding the key in default mode is expected (L11).

### C21. Username and name impersonation

Property: L21 handling. Adversary: A12, A6.

Setup: M1 has a friend `bob` (account Bob on S1). The tester runs S2, where the tester's own account is also `bob` (different key), and shares S2 with M1 (M1 is a member of S2). On S1, a member sets the display name "Bob" with the username `b0b`.

Steps:
1. From S2, the tester's `bob` sends M1 a friend request and a DM.
2. From S1, `b0b` (display "Bob") sends M1 a friend request.
3. Tester's S2 server serves M1 a member list in which the real Bob's `account_id` has a different key.
4. The tester tries to appear as Bob in a group DM.
5. Accept the friend request, then rotate the tester's key and see whether M1's client merges the new key into the existing contact.

Break: the client shows the impersonator as the existing friend, with the friend's petname, verified mark, or history; auto-accepts; merges contacts by username or display name; fails to flag a changed key behind a known contact; shows a safety number for the old key under the new key.

### C22. Network attacker: TLS, sessions, WebSocket

Property: A1.

Setup: tester is a man-in-the-middle between clients and S1.

Steps:
1. Present a certificate from an untrusted CA, from a trusted CA for another name, a self-signed one.
2. Relay OPAQUE messages between a real client and the real server with the device key swapped; and relay a login for server A to server B.
3. Capture a bearer token and replay it from another host (expected to work for up to 15 minutes, the TTL); try to renew it without the device key; replay it after the device is revoked.
4. Capture a session challenge signature and replay it to S2.
5. Cross-site WebSocket hijack: open the WebSocket from a page on another origin.
6. Cross-origin requests with and without credentials to every route.
7. Compare what is on the wire to the list in PROTOCOL 19.1 (everything else must be ciphertext).

Break: any client accepts steps 1; step 2 yields a session or a blob; a token can be renewed or used after revocation or after 15 minutes; step 4 works on S2; step 5 or 6 lets another origin read or write; step 7 finds plaintext content, key material or passwords. Replay of a stolen bearer within its TTL is expected.

### C23. Push relay and push services

Property: A10, D2.

Setup: relay in test mode with capture of every payload; two servers S1 and S2 with the same device registered on both; one device on each platform available.

Steps:
1. Default mode: capture every payload to the relay and from the relay to the push service. Search for canaries (message text, channel name, sender name, username, mention flag, file names).
2. With `push_text` on: payloads must be ciphertext only. Try to decrypt at the relay with all the relay's keys. Check a device that did not register `push_decrypt`.
3. Check that the aliases for the same device on S1 and S2 differ, that the `push_key` the device gave S1 and S2 differs, and that S2 cannot push to S1's alias (the relay refuses: the alias is bound to S1's `relay_pub`). As S2, try to register a relay key that claims S1's `server_id` before S1 does; there must be nothing to claim. With `push_text` on, have the host seal a forged `{title: "Alice", body: …}` and a message whose signature is wrong: the device must show a content-free notification.
4. Spam: S1 sends 10,000 pushes to one alias.
5. Private channels and DMs with `push_text` on: payloads must stay content-free.
6. Mention-only user: record what an observer of the relay can infer (expected: that a mention happened, L20).

Break: any plaintext content, sender, channel or mention flag in a payload in default mode; plaintext of any kind in sealed mode; cross-server alias use; the same alias on two servers; step 5 sends text; no spam limit.

### C24. Attachment tampering

Property: P2. Adversary: A2b, A1.

Setup: M1 sends images and a 25 MiB video with seeking.

Steps: flip a bit in a random chunk; swap two chunks; remove the last chunk; append a chunk; swap the blob between two messages; serve another message's blob under this blob id; change the header chunk size or nonce prefix; serve a Range request into a tampered chunk; delete a blob (availability); change the descriptor's size or name (needs message forgery: expected fail); download with a key from another file.

Break: any altered plaintext (even one byte), a truncated file, an appended file or a swapped file displayed as valid; a tamper that raises no error.

### C25. Resource limits and denial of service

Property: L8, availability. Adversary: A6, A1.

Setup: S1.

Steps: fill the pending join-request queue from one source and from many; fill the device-request queue for a victim; upload past the quota; open many WebSockets; send messages at the rate limit from many devices; submit large CBOR; slowloris; exhaust the Argon2id concurrency (many logins) and check that normal requests continue.

Break: a single source blocks others; the server crashes or uses unbounded memory; legitimate registered devices cannot use chat while the password path is under load; limits reset on restart. Filling the join-request queue from many sources is expected (record how an admin clears it).

### C26. Recovery phrase, lost password, replacement

Property: P4, P5. Adversary: A5c, A5a, A7.

Setup: U has a recovery phrase and two devices.

Steps:
1. Recovery path: wrong phrase, wrong checksum, valid phrase on a new device; then set a new password; check the old password fails on that server at once and still works on S2 until updated.
2. Tester files a replace request for U's username on S1 (no old proof) and a second, valid one with `old_proof`. Check how A's client shows them, and that approving one removes the other.
3. After approval, check old key vs new epochs, history for `from_now` and `full`, DMs (the new identity must not read old DMs).
4. Change password with a stolen session only (no old password). Then, holding only `RS` copied from an unlocked or revoked device, call `/v2/recover` on an account with an active device: the recovery must be held as a pending request, every active device must be told at once, and no password may be set before it completes. Replay a captured password-change signature to a second server and a captured one with an old version.
5. Password-change retry on an unreachable server: check the UI and that the stale server accepts only the old password.

Break: an account is replaced or a device registered without the phrase, the password with approval, or an admin's explicit signature; a recovery with `RS` alone registers a device or sets a password on an account with an active device without approval or the waiting period, or without telling the other devices; the new key reads history beyond what the admin chose; the new identity reads old DMs; the old key reads post-replacement content; password change succeeds without the old password; an admin client approves a replacement with no confirmation step.

### C27. Reports and moderation

Property: P2. Adversary: A6, A7.

Setup: M1 posts in `#general`; M2 reports it; A moderates.

Steps: M2 modifies the plaintext in the report; discloses `mk` for another message; includes a message from another channel; A tries to read context beyond the disclosed messages; A tries to read a report from `#priv` they are not in; A deletes a message in a channel they are not in. Delete the blobs of another member's message as a member who is neither the sender nor an admin; delete them as the sender and as an admin in the channel.

Break: a blob deleted by someone other than the sender or an admin of the channel; A accepts a report whose plaintext does not match the signed ciphertext; an `mk` reveals anything besides its own message; A reads anything not disclosed; A deletes in a channel they are not a member of.

### C28. DMs, friends and group DMs

Property: P1, P3. Adversary: A2b, A6.

Setup: M1–M2 DM, M1–M2–M3 group DM, M1 and Y share only S2.

Steps: server serves a different `AccountPub` for M2 when M1 starts a DM; adds a third recipient to a DM header; serves a host entry in a DM header; M3 (non-creator) adds M4 to the group DM; the creator adds a non-friend, a non-member of the home server, an eleventh member; M2's key is replaced; the home server moves (check that the same pair gets a different `dm_id` and fresh epoch state on the new server, and that epoch 0 there is accepted without disturbing the old thread's rollback guard); a blocked sender sends mail; mail is replayed; friend request from an account that shares no server with the target; a friend request, DM or group-DM add that involves Steve's key (must be refused by server and client); the creator of a group DM leaves the server (the group must be frozen).

Break: a bot accepted as a friend or DM partner; a DM or group DM key is wrapped to anyone but the listed members; non-creator add accepted; blocking bypassed; mail with a wrong `from`, or to a non-shared account, delivered; any DM state shown as level 4 after a key change.

### C29. Plaintext leak sweep

Property: P1. Adversary: A2a.

Setup: a full run of the other tests with canaries in message text, channel names, file names, URLs, search terms, passwords, usernames, push text, and bot prompts.

Steps: after the run, grep the SQLite files, WAL, SHM, blob store, LiveKit data and logs, Caddy logs, server stdout and stderr, crash dumps, temp directories, the bot host's logs and config, the push relay's logs, and any metrics endpoint for each canary.

Break: any canary found in plaintext anywhere other than where PROTOCOL 19.1 allows it (usernames, display names and similar listed metadata), including URLs with secrets in query strings and error messages that echo content.

### C30. Server identity and pinning

Property: P3, A1. Adversary: A2b, A1.

Setup: S1 joined by M1 (pin recorded). A second server S1′ is built with a different genesis and placed at S1's address.

Steps: M1 connects to S1′; a new device of M1 signs in at S1′ with the correct password (OPAQUE: S1′ has no record); an invite link with a wrong `s`; the owner changes the origin through `server_meta` and then a hostile party serves a different `origin_hint` without an entry; S1 moves hosts legitimately and M1 follows; M1 adds S1 again from a new invite link (should merge).

Break: M1 treats S1′ as S1; the new device joins S1′ as the real server; an unsigned origin change is followed; the legitimate move is not followed, or the re-add creates a duplicate that confuses the pin.

## 4. Expected results that are not breaks

These are documented limits. The tester confirms each behaves exactly as stated and no wider.

| Result | Limit |
|---|---|
| A removed member reads everything they already held keys for | L4 |
| A stolen unlocked device reads its history until the account key is replaced | L1, L5 |
| A malicious or breached server with the password skips approval and releases the blob | L3 |
| A server with its OPAQUE secret cracks a weak-but-allowed password offline | L2 |
| First load of the web client by a hostile host runs hostile code; a replaced service worker stops verifying | L12 |
| A leaked invite link joins once | invite is a bearer secret |
| A stolen bearer token works for up to 15 minutes | session TTL |
| A malicious member who leaks keys to the server reveals only what they could read | L15 |
| A whole-machine image in default `file` mode yields the host key | L11 |
| The bot host reads everything in its channels | L13 |
| Backfilled messages by a removed member in old epochs from a colluding server | L4, L8 |
| Servers see the metadata in PROTOCOL 19.1 | L6 |
| A filled join-request queue from many sources | availability |

## 5. Report format

`CRACK-REPORT.md` has one section per test: commit tested, result (**held**, **broke**, **expected limit confirmed**, **not run**), each step's reproduction, captured evidence (paths or hashes), severity, the fix commit, and the retest result. The report ends with a list of anything the tester tried that is not in this plan. The README summary says which tests were run, how many broke before fixes, how many after, and that no human audit has taken place.
