# Housecall threat model

Status: draft for the v1 protocol in `PROTOCOL.md`. It replaces the trusted-server assumptions in `docs/THREAT-MODEL.md` (plaintext chat, server-side scanning, passkeys); that older file needs a pass to remove the rows this one supersedes. Nothing here has had an independent audit. `CRACK-PLAN.md` describes how the implemented system will be attacked; its results go in `CRACK-REPORT.md`.

Section numbers like "PROTOCOL 9.4" point into `PROTOCOL.md`. Limit ids `L1` to `L23` are defined in section 2 and are the ids the other documents cite.

## 1. What Housecall promises

Housecall is a self-hosted chat and voice app. One deployment is one server run by a host. By default:

- **P1. Content confidentiality from the host.** The server stores ciphertext and cannot read channel messages, DMs, files or call media.
- **P2. Content integrity.** A message shown as from a member was signed by that member's account key. The server cannot forge, alter or attribute messages.
- **P3. Membership integrity.** Who is a member, and who is an admin, is decided by signatures of admins, not by the server. A server cannot add a member that the admins did not sign, and honest clients will not give channel keys to one.
- **P4. Password secrecy.** The password never reaches any server, and the server cannot test password guesses without its own secret (L2).
- **P5. Removal.** After a member is removed, content encrypted after the key rotation is unreadable to them.
- **P6. No silent host access.** The host cannot be made a key holder without an owner-signed entry that every member's client shows.
- **P7. Honest labels.** The level the app shows never claims more than the cryptography gives (`SECURITY-LEVELS.md`).

## 2. Properties that are NOT provided

Stated first because they are the ones most likely to be assumed.

| Id | Not provided |
|---|---|
| L1 | **Forward secrecy for stored history.** Members and bots keep epoch keys so they can read history on any device. Anyone who gets a member's account secret `RS`, or a stored epoch key, can read all history that member was given, including old messages the server stored. There is no ratchet. |
| L2 | **Resistance to offline password guessing after a server breach.** A party who has the server's database and its OPAQUE secret can test guesses at one Argon2id (64 MiB, 3 passes) per guess, and a cracked password yields the account root secret, which is the account on every server. |
| L3 | **Cryptographic enforcement of device approval.** Approval is a server rule. A malicious server, or a breached one plus the password, skips it. |
| L4 | **Post-compromise security inside an epoch,** and protection of old content from a removed member. A removed member keeps everything they could already read. |
| L5 | **Cryptographic device revocation.** Every device holds `RS`. Revoking a device ends its sessions, not its knowledge. Theft of an unlocked device means the account key must be replaced (PROTOCOL 8.4). |
| L6 | **Metadata privacy from the host.** The host sees who talks to whom, when, how much, from where, who is in which call, who was @mentioned, and file sizes (PROTOCOL 19.1). |
| L7 | **Detection of a split view that predates any cross-reference.** A host that shows two groups different member lists from the beginning is caught only when something signed crosses between the groups. First contact with a server without an invite link trusts TLS and OPAQUE only. |
| L8 | **Availability and ordering.** The host can drop, delay, reorder, withhold, or refuse service. Clients detect gaps per sender but cannot establish a global order or exact times. |
| L9 | **Deniability.** Messages are signed with the sender's account key. A recipient can prove to a third party who wrote a message. |
| L10 | **Erasure.** Deleting a message deletes the server's copy where the server cooperates. It does not erase copies a recipient saved, backups, SQLite free pages, or SSD remnants, and a hostile server can keep ciphertext. |
| L11 | **Confidentiality from the host for anything a host-assisted feature covers,** and any guarantee that the host deleted keys or artifacts after a feature is turned off. The host key at rest is protected against a stolen data volume, not against a stolen whole machine in default mode or a root user on the running machine. |
| L12 | **Protection of the web client against a hostile host.** The host serves the code. Detection after first load exists; prevention does not (PROTOCOL 20.3). |
| L13 | **Confidentiality from a bot, its host, and the services it forwards to,** in every channel the bot is added to. |
| L14 | **Authenticated sender inside a call,** forward secrecy inside a call, and hiding speaking activity, bitrate and participants from the SFU. Any channel member can derive any participant's media key. |
| L15 | **Protection from a member who leaks.** Members can copy, screenshot, forward, or hand their keys to anyone. A malicious member can give a server the keys they hold. |
| L16 | **Isolation between servers.** One account root secret serves every server, so a weak password or one breach of one server's password data endangers the account everywhere. |
| L17 | **Recovery phrase safety.** Anyone with the phrase is the account, with no rate limit and no approval. |
| L18 | **Protection from a malicious admin who lies about a member's key.** Admins vouch for usernames and keys. Join requests without an invite link are protected by a spoken six-word check; a dishonest admin who does not do the check, or lies about it, can bind a username to a key of their choice. |
| L19 | **Protection from a compromised device OS, malware on a device, hardware attacks, side channels, or coercion of a user.** |
| L20 | **Push-metadata privacy.** The push relay and the OS push services learn when a given device is woken, and for mentions-only users, which wake-ups are mentions. |
| L21 | **Identity beyond keys.** Nothing proves that "Alice" on two servers, or any username, is a particular human. Safety numbers compared out of band are the only proof. |
| L22 | **Cryptographic enforcement of timeouts and mutes.** These are server policy. |
| L23 | **Protection against supply-chain compromise of the project, its release key, GitHub, or the crates we depend on.** |

## 3. Assumptions

- **Client code is the code the project released.** Desktop and mobile apps come from signed GitHub releases and verified auto-updates. If the release key or the repository is compromised, everything fails (L23).
- **The device is not compromised** at the OS level while the user is using it, and the OS secure store protects the stored key from other apps.
- **The CSPRNG works** (`getrandom`).
- **TLS** (WebPKI) protects metadata and first contact in transit. It is not what protects message confidentiality.
- **The Rust crates implement their standards correctly** (`PROTOCOL.md` 0.3 lists them, and which are audited).
- **The owner holds their account key.** The owner is trusted with features, roles and admins. A malicious owner is covered in A9.
- **Members choose passwords that pass the strength check and do not reuse them in other places.** Otherwise L2 and A5 get easier.

## 4. Adversaries

For each adversary: what they can do, what they cannot, and the controls that stand behind the "cannot". "Test" points at the attack in `CRACK-PLAN.md`.

### A1. Network attacker (passive and active, between a client and the server, or the server and its services)

Can: see IP addresses, timing and sizes of everything; block, delay, replay or reorder traffic; present a forged TLS certificate if they control a trusted CA (then they are the server for metadata purposes).

Cannot:
- read or alter message content, files, call media, key wraps (all are end-to-end ciphertext; PROTOCOL 9, 10, 11, 12);
- learn the password or `RS` (OPAQUE; the blob is AEAD-encrypted under a key derived from the OPAQUE export key; PROTOCOL 2);
- log in as a user by replaying a challenge (signature covers `server_id`, origin and a fresh nonce; PROTOCOL 6.1);
- impersonate a server a client has joined (the pin is the genesis hash; OPAQUE needs the record; PROTOCOL 3.5, 2.4);
- downgrade: there are no negotiated algorithms in v1. An object with a lower or unknown `v` is rejected (PROTOCOL 0.1).

With a TLS-breaking capability they are in position of A2b for metadata and for a first-contact web page (A11). Over plain `http` clients refuse to connect, except to loopback.

Tests: C03, C04, C22.

### A2. Malicious or breached server (the host, or someone who got into the host)

Two cases. **A2a: data-at-rest theft** (a stolen database, volume, backup or snapshot; no live control). **A2b: live control** (the operator is malicious, or an attacker runs code on the server and can alter it).

A2a can:
- read all metadata (PROTOCOL 19.1) and all ciphertext;
- read the users' OPAQUE records and blobs; **without the server's OPAQUE secret** they cannot test passwords. In default mode the secret is wrapped by `WK`, which is not on the data volume (PROTOCOL 2.5). If the attacker also has `WK` (whole-machine image, or the file in the same backup), then see L2;
- find the host key file if any host feature was ever enabled; it is encrypted under `WK` (PROTOCOL 15.4).

A2a cannot: read content, forge messages or membership, learn any password or key without a successful offline attack (L2), or read the host key without `WK`.

A2b can (all of A2a, plus):
- drop, delay, reorder or withhold messages, wraps and log entries (L8); refuse to accept a new epoch so that senders cannot send (clients fail closed rather than reuse old keys; PROTOCOL 9.3);
- show different members different data. This is detected when signed objects cross between them (PROTOCOL 3.5), and not otherwise (L7);
- serve a malicious web client (A11);
- skip device approval, release a blob to anyone who passes OPAQUE, and with enough effort attack passwords offline (L2, L3);
- observe who joins calls and when, the SFU metadata (L6, L14);
- insert or inject ciphertext into old epochs *for a removed member who colludes with them*: the injected messages carry that member's valid signature, and readers who backfill see them at an old position (L4, L8; PROTOCOL 10.4 rule 6 limits this to backfill);
- forge host-feature records (HostRecords are unsigned; they are shown with "by the server" labels);
- run host-assisted features on any content that the owner has authorised through the log (A9).

A2b cannot:
- **read channel text, DMs, files, call media, reactions, pins, channel names, or friend requests** without a member's key; **add a ghost member** that honest clients will wrap keys to: every epoch header is checked against the signed membership list and exact recipient set (PROTOCOL 9.4 rules 1, 2);
- **substitute a key at join**: invite joins are signed with a secret the server never sees, and tokenless joins need the six-word check (PROTOCOL 5.2, 5.4);
- **forge or alter a message** (signature over the whole envelope, AEAD with identity in the AAD; PROTOCOL 10);
- **enable host access silently**: it would need an owner signature on a log entry, or a member to wrap keys to it (A6, A9; PROTOCOL 15.8);
- **roll back or fork the log undetected by clients that remember their head** or by clients that read any later signed object (PROTOCOL 3.5), or **replay an older epoch as the latest** (PROTOCOL 9.4 rule 4);
- **make an honest client encrypt under an epoch that still includes a removed member** (PROTOCOL 9.3, "mandatory before send");
- **read call media** (key derived from the epoch key; the SFU only forwards; PROTOCOL 12);
- **read the password, `RS`, or any member's private key** except through an offline attack on a password record it holds the secret for (L2), or by using the blob release it controls itself (L3).

Tests: C01, C02, C05, C06, C08, C11, C15, C16, C24.

### A3. Removed member (kicked, banned, left, or replaced; may collude with A2b)

Can: read everything encrypted under epochs they held keys for, including messages that arrive later but were encrypted under those epochs; keep and share what they read; try to rejoin under a new key and username (blocked by bans only for the old key and name; invite-only joining is the control).

Cannot: read content encrypted after the next epoch (honest clients refuse to send under the old epoch after the removal entry is verified; PROTOCOL 9.3), decrypt call media sent after the re-key (PROTOCOL 12.3), read other channels they were never in, post messages that the group accepts as live (live messages to a stale epoch are dropped; PROTOCOL 10.4 rule 6), or forge membership.

Limits: L4 (they keep what they had), L8 (a colluding server can show them ciphertext that exists, but there is none newer than the rotation unless a client violated the rules).

Residual: if the only person online when the removal happens is offline for days, the channel stays on the old epoch until the first member sends (lazy rotation) — but no *new* messages exist in that window; the first sender rotates before sending.

Tests: C07, C08, C12, C19.

### A4. Stolen device

**A4a: locked or powered-off, attacker has the disk.** Can: copy encrypted files. Cannot: read `RS`, epoch keys or history without the platform store (Keychain, Android Keystore, DPAPI, Secret Service) and, where the user turned it on, the app lock. Strength depends on the OS: a Linux desktop without disk encryption and without a running keyring is weaker (PROTOCOL 24 item 8). Cannot sign in elsewhere: needs `DK` (also in the store).

**A4b: unlocked, or the attacker can unlock it (A4a succeeded).** Can: read all history the device holds, read new messages until the account key is replaced, send messages as the user, open sessions, approve new devices (so approval is not a barrier, because the device is the approver), and change the password only with the old password (PROTOCOL 2.6). Cannot: make admin entries unless the user is an admin; read channels the account was never in.

Control: the user (or an admin) revokes the device (ends sessions: L5 limits the benefit) and runs "Secure my account" (PROTOCOL 8.4), which replaces the account key with admin approval and rotates every channel the old key could read. Content the thief already read stays read (L1, L4). On web, `RS` is not in persistent storage unless the user chose "remember".

Tests: C17.

### A5. Stolen password

**A5a: attacker has the password only, server honest.** Can: pass OPAQUE, create a pending device request, spam it within rate limits, and trigger a notification on every device the account has. Cannot: get the blob or `RS` (approval is required while the account has another active device; the approver must type a code shown only on the attacker's screen), approve themselves, join as a different user, or read history. After seven days without a deny, the request auto-approves (PROTOCOL 7.3 step 6): the user has been told on every device daily; if they never look, the attacker gets in. If the account has no active device (the user signed out everywhere), the password alone is enough by design.

**A5b: attacker has the password and the server (a malicious host or a breach plus password).** Can: obtain the blob without approval (L3), decrypt it, get `RS`, and be the account on every server it joined (L16). Then they need a device registered on each other server; those servers demand approval too (A5a). They can read history for which the account has wraps on any server whose data they can obtain.

**A5c: attacker has the recovery phrase.** Is the account: registers a device without a password or approval, sets a new password (L17). The control is account key replacement from a good device if there is one (PROTOCOL 8.4), or admin approval of a replacement if there is not (PROTOCOL 8.3).

**A5d: a password guessed online.** Limited to 5 guesses per 10 minutes at first, then 5 per day after repeated lockouts, per username (PROTOCOL 18). Registered devices are not locked out.

Cannot (all of A5): read content without the blob or a device.

Tests: C09, C15, C18, C26.

### A6. Malicious member (an ordinary member, human or running a modified client)

Can: read everything they are given; leak it; post spam within rate limits; send malformed objects; wrap keys to a key of their choosing for epochs they author (honest readers reject such headers; PROTOCOL 9.4); hand the host or anyone else the keys they hold (L15); attempt to impersonate another member by display name (flagged, PROTOCOL 13.6); join calls and derive any participant's media key (L14); report messages they received and omit context.

Cannot: sign as another member, read channels they are not in, force others to use a bad epoch, change membership, features, roles or bots (needs admin or owner signature, PROTOCOL 3.3), insert a ghost recipient (rule 2), enable host access (rule 3 and 15.8), edit or delete others' messages (author check, PROTOCOL 10.4), or forge a report (the per-message key discloses signed content only; PROTOCOL 10.8).

Tests: C01, C10, C27.

### A7. Malicious admin (not the owner)

Can: approve anyone into the server (and choose full history for them), add bots to public channels, remove and ban members, delete messages in channels they are in, create public channels, and bind a username to a key of their choosing in a tokenless join if they skip the six-word check (L18); read every public channel they are a member of, which includes channels added to the server later.

Cannot: change the feature set, roles or remove the owner (owner-only entries; PROTOCOL 3.3), add themselves to private channels they did not create (rule on kind 6), read DMs, read private channels, sign entries as the owner, replace the owner's key, or hide an entry from other admins (the log is shared and chained).

Control: a member whose admin entries look wrong sees them in the log (client-side member and admin list is derived from it); the owner removes the admin (`role_set`, then rotation).

Tests: C13.

### A8. Malicious bot host (the machine that runs Steve, or whoever compromises it)

Can: read all content (and call media) of channels the bot was added to, from the epoch that listed the bot (all history if the admin chose `full`), plus everything the bot's configured chat and speech endpoints receive; post as the bot; keep the keys forever (L1, L13). Steve's DJ can join calls of the channels it is in.

Cannot: read channels it was not added to, DMs or group DMs (no wrap, and no entry adds a bot there), sign admin or owner entries, approve devices, join requests, invites, or add other bots, change features, or silently stay after removal (removal rotates the channel's epoch, PROTOCOL 16.4).

Control: the admin removes the bot (`member_remove` rotates all its channels) and re-enrols with a new key. Content the bot already read stays read.

Tests: C14.

### A9. Malicious owner who turns host features on, or an honest owner whose host is breached

Can, once the owner signs `features_set`: read, on the server, the content classes the features need, for **public channels only**, **for epochs created after the entry**: message text (push_text, search), file bytes and names (scan, transcode), links the sender's client sent for previews (link_preview). Wraps are given to the host key only for those classes (PROTOCOL 15.2). The owner can then do anything with what the host process can read. A bot, if one is also present, adds more (A8).

Cannot (even with full control of the server and the owner's key):
- read private channels, DMs or group DMs: headers with a host entry for those are rejected by every client (PROTOCOL 9.4 rule 3);
- read content from before the entry (the host never gets the earlier epoch keys, and class keys never include `K_call` or `EK`);
- read call media (needs `EK`; the host only ever holds class keys);
- read a class the enabled features do not need (e.g., files with only `push_text`);
- hide the change from members: clients render it from the log, change the level and show a notice in affected channels (PROTOCOL 15.7);
- erase the change: the log is append-only and clients keep their head.

Also, an owner can sign in as a member who has no devices, add admins, ban people, and read history for any account they approve with `full` (the usual admin powers, A7).

What is not provided: confidentiality for covered content (L11), and a way to check that the server deleted keys or artifacts after a feature is turned off. Honest owner, breached host: the attacker obtains whatever the running host process could read, plus the host key if `WK` is on the same machine (L11).

Tests: C11, C20.

### A10. Push relay operator, APNs and FCM

Can: see device tokens, which server pushes to which alias, timing and size of every push; with sealed push text on, only ciphertext; with content-free push, a fixed generic string. Mentions-only users' pushes reveal that a mention happened (L20). The relay can link a device across servers (it holds the alias-to-token map), a promise not to is not a mechanism.

Cannot: read message text (content-free; or sealed to the device key), learn usernames, channel names or senders, read any chat content, or push to an alias belonging to another server.

Tests: C23.

### A11. Malicious web host (the server's operator, or anyone who can change the files the server serves, when the user uses the web client)

Can: on first load, serve code that steals the password and `RS` (L12). After first load, ship a replacement service worker that stops verifying (PROTOCOL 20.3). Serve different code to different people.

Cannot: make `housecall verify-web` accept an altered bundle (it checks the manifest against the project's release key, outside any browser state); or, while an honest verified service worker is installed, change the bundle that browser runs without the release key, until the browser replaces the service worker itself.

Control: use the desktop or mobile app; run `verify-web`; the web UI caps its security label (SECURITY-LEVELS 3).

Tests: C16.

### A12. Operator of another server (a server a user also belongs to)

Can: create an account with the same username or display name as someone the victim knows, request friendship, and try to DM them; see their own server's metadata about the victim. Cannot: be mistaken for the real friend without a visible warning (friend identity is `account_id`; same name with a different id is flagged; PROTOCOL 13.6), read DMs routed on a different server, or learn anything about the victim from a server they do not share.

Tests: C21, C28.

### Out of scope

A compromised OS or device, hardware attacks, side channels, supply-chain compromise of the project or its crates, coercion, and denial of service beyond the rate limits (L19, L23). Metadata minimisation beyond what is stated (L6).

## 5. Trust summary

| Party | Trusted for | Not trusted for |
|---|---|---|
| Member | Their own messages | Not leaking what they read |
| Admin | Who is a member, history choice, bots, bans | Nothing cryptographic beyond membership; cannot read private chats |
| Owner | Features, roles, admins | Cannot read private channels or DMs even with features on |
| Host (server operator) | Availability, storing ciphertext, running Chords as configured | Reading content (unless owner enabled a feature, then only that class, public channels, going forward) |
| Bot host | Only for channels the bot is in | Everything else |
| Push relay | Delivering wake-ups | Content (it never receives plaintext) |
| Project (release key) | Honest apps and web bundles | n/a |

## 6. Metadata the host sees

Listed in PROTOCOL 19.1. The shortest version: **who, when, how much, from where, with whom**, and who was mentioned. Not what.

## 7. Open items for implementers

1. The older `docs/THREAT-MODEL.md` rows for plaintext chat, ClamAV, passkeys and server-held media key are superseded by this document and must be revised.
2. The rate-limit values are initial; the CRACK run records any that are too loose.
3. Spikes listed in PROTOCOL 24 can change a primitive's crate, never a construction.
4. The README must say that no human audit has happened and what was tested by attack (D3).
