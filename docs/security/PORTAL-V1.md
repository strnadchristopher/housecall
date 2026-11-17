# Portal V1: implemented convenience subset

This contract describes the optional public portal candidate, pending acceptance.
It is a convenience subset, NOT the future ID-V1 architecture. ID-V1's reviewed
device/root/push/QR design is preserved unchanged; federation, native keys and
push are outside this task. No SSO, community membership or chat encryption is
provided by this portal. Release integration from 984405e includes this NEW
contract only, not the unpublished candidate base or its ID-V1 draft.


Status: implementation candidate, registration CLOSED by default. It does NOT ship
full ID-V1 device certificates, federation, SSO, root/DM key backup, QR, native
integration, recovery, notifications, or new self-host admission rules.

## Boundary review (before implementation)

Base: 277414e272229e05d9138fd278f37705cefaf0d0. Structural navigation:
`ast-grep run --lang typescript --pattern 'export class $C { $$$ }' client/src/core/identityService.ts`,
then imports/call sites and Rust route/handler declarations with `rg`.
`server/src/lib.rs` owns server-local password admission and sessions;
`server/src/identity.rs` checks that local session/password for DM key publication.
`client/src/core/identityService.ts` deliberately separates native creation from
browser import; `client/src/transport/identityStorage.ts` uses OS storage or browser
memory. DM-V1 seed derivation, backup, pinning and SECURITY-LEVELS.md lines 1–19
remain authoritative and untouched. Portal imports none of these modules.

Public `/` belongs to the independent static website. `/app/` is an independent
static portal. `/api/account/*` is an OPTIONAL loopback Node service. A HouseCall
account remembers only an encrypted list of user-entered HTTPS frontend addresses.
Every selected server performs its own real login and admission. No backend ever
fetches a server address, and no central token is passed to a server. No personal
server is a default, demo, fixture or test target.

## Compact threat model

* Database theft: only keyed username indexes, random account bindings, OPAQUE
  records, monotonically versioned AEAD ciphertext. No raw usernames, IPs, user
  agents, wall-clock timestamps, host passwords, chat data, native keys or email.
  Theft of the separate index key permits dictionary tests of handles. Theft of
  setup plus DB permits password guessing at OPAQUE/Argon2 cost. Use strong unique
  passwords. Username availability is disclosed during signup.
* Active malicious portal/operator/browser extension/XSS: can replace browser code
  and steal passwords and plaintext while used. This web application cannot offer
  native endpoint protection. TLS protects transport, not a malicious publisher.
  A provider can read RAM; no promise that future logging cannot be compelled.
* Transient metadata: socket IP, request time, username, request sizes and access
  patterns exist in RAM. No analytics, remote fonts, CDN, telemetry or request logs.
  Rate keys are HMACs under a random rotating RAM salt; never trust forwarded IPs
  from arbitrary peers. Production proxy overwrites X-Forwarded-For and backend
  accepts it only in explicit loopback-proxy mode. No durable request error text.
* Session theft: Secure/HttpOnly/SameSite=Strict host cookie, 256-bit random ID,
  only SHA-256 digest in bounded RAM, absolute expiry, logout invalidation and
  restart invalidation. Exact configured Origin plus JSON and custom-header CSRF
  checks on ALL API calls. Session never authorizes a self-hosted chat server.
* Abuse: small payloads, exact schemas, single-use expiring random exchanges,
  bounded per-IP/global request budgets, exchange/session/account/storage/socket
  caps, request deadlines, one synchronous OPAQUE operation at a time. No workers
  or unbounded CPU queue. Registration requires an explicit operator gate.
* Vault isolation: session account selects the row; callers cannot name another
  account. AES-256-GCM, random 96-bit IV, client-only OPAQUE exportKey -> HKDF-SHA256
  with separate domain, random binding salt. AAD binds format, account and revision.
  PUT and DELETE require the initiating tab's `expectedBinding`, canonical base64url
  of exactly 32 bytes, matching the immutable authenticated account binding before
  any write, deletion or account invalidation. Missing/malformed bindings return
  400; mismatches return 409 with `code: "account_changed"`, without changing the
  cookie, sessions, pending exchanges or account data. The binding is a comparison
  guard, never an account selector. PUT also requires current revision; malformed
  envelopes and stale writes are rejected. The client locks only its stale tab
  and asks for login again; it does not send logout on account mismatch.
  Ciphertext is untrusted. Client validates decrypted list before rendering.
  Online CAS prevents lost updates, not a malicious operator's rollback/fork on
  a fresh browser. No cross-device transparency protocol is claimed.
* Password loss: no reset/recovery; encrypted list is unrecoverable without the
  password or an already unlocked tab/export. Keys live only in memory; reload
  requires login. Explicit plaintext export warns about local download exposure.
* Direct navigation: user chooses destination and confirms visible canonical URL;
  HTTPS, no credentials/query/fragment, no control/backslash tricks, bounded URL.
  Explicit HTTP loopback only; never probe hosts. UI refuses the portal hostname
  (including other ports), so its host-only session cookie cannot accompany navigation. No referrer. Host may be hostile;
  its own login is independent. Direct path works with account API unavailable.

## Endpoint/data contract (JSON, same origin only)

All API calls require `X-HouseCall: 1`, exact configured `Origin`, JSON mutations,
no query strings, no cross-origin CORS. Browser GETs that omit Origin must instead
carry `Sec-Fetch-Site: same-origin`; an explicit wrong Origin is always refused.
Unknown fields are errors.

| Method/path under /api/account | Request | Response |
| --- | --- | --- |
| GET /status | none | `{registrationOpen}` |
| POST /register/start | `{username,registrationRequest}` | `{exchange,registrationResponse}` |
| POST /register/finish | `{exchange,registrationRecord}` | `{ok:true}`; no implicit session |
| POST /login/start | `{username,startLoginRequest}` | `{exchange,loginResponse}`; unknown users use OPAQUE fake response |
| POST /login/finish | `{exchange,finishLoginRequest}` | `{binding,revision}` plus cookie, or generic 401 |
| POST /logout | `{}` | `{ok:true}`, invalidate session |
| GET /vault | none | `{binding,revision,envelope}`; envelope null at revision 0 |
| PUT /vault | `{expectedBinding,expectedRevision,envelope}` | `{revision}`; 409 if stale or account changed |
| DELETE / | `{expectedBinding,confirmation:"DELETE"}` | `{ok:true}`; requires session authenticated within 5 minutes; deletes record/vault and all sessions |

A binding mismatch is distinguished from ordinary CAS/duplicate-name 409 by the
fixed `account_changed` code. CAS recovery keeps the typed address and offers
Reload saved list; duplicate-name copy applies to registration only.

The portal footer offers **Portal source** at
`/source/housecall-public-source.tar.gz`, alongside Privacy. Noah must publish the
exact corresponding source-only archive at that same-origin path with the release;
no archive is generated here, and current public availability is not claimed.
Production secrets/state must never be included. GitHub main is not the source
for this new API until the corresponding change is published there.

Username: NFKC, lowercase, then ASCII `[a-z0-9_]{3,32}`. Index:
HMAC-SHA256(private index key, `housecall portal username v1\0` + normalized name).
OPAQUE userIdentifier is that index. Client/server identifiers bind normalized
username and configured public origin. The client explicitly selects
`memory-constrained` Argon2id during registration AND login (64MiB, 3 iterations, parallelism 4 in
upstream source). No server-derived vault key, OPAQUE session key or password sent.

Durable JSON database: `{schema:1,accounts:{[index]:{binding,record,revision,envelope}}}`.
Private env JSON: `{setup,indexKey}` generated ONLY by explicit init, never by
service startup. Database atomic temp write, fsync, rename, directory fsync;
private directory, 0600 files, singleton process lock. Hard caps: 1,000 accounts,
64KiB decoded ciphertext each; database bounded to 100MiB. No historical versions.
Envelope: `{format:1,iv,ciphertext}` canonical base64url, 12-byte IV and 16..65536
ciphertext bytes. HKDF salt is UTF-8 binding; info `housecall portal vault key v1`;
AAD is UTF-8 `housecall portal vault v1\0${binding}\0${revision}`. Plaintext:
`{format:1,servers:[canonical URL strings]}`, maximum 100 entries, no passwords.

Limits: 32KiB auth / 96KiB vault request, 128 pending exchanges (60s), 512 sessions
(30min), 2,048 rate buckets (60s salt rotation), 30 requests/IP/minute and 300
requests/global/minute, 64 active requests/connections. Limits fail closed with
429/503. RAM expiry uses monotonic time; no persistent timestamps. Production
Node 20.19+ (Debian 13 package candidate must be checked by Noah), memory cap in
systemd. One process only; no cluster/shared DB.

## Dependency/release gates

The earlier drafted 1.1.1 pin was invalid (public npm E404). Real published
@serenity-kit/opaque 1.1.0 and Playwright 1.58.1 are installed with a real lockfile.
The installed MIT license, package metadata, full types and bounded ESM/CJS glue
were inspected. No packaged CHANGELOG or Rust source is present; source/WASM
correspondence and provenance remain review gates. API/crypto verifier, build,
unit and OS-lock crash persistence pass. Real HTTP/browser acceptance remains
pending; library proof is not app acceptance. Parent's dependency audit reports
zero advisories, not an application audit. No fallback crypto.

Persistent single-writer ownership uses Linux flock on a Node-held descriptor,
acquired by `/usr/bin/flock` (Debian util-linux) over inherited fd 3. It releases
on crash/reboot automatically. Never unlink/replace the lock inode. Local Linux
filesystem only; init and service share the lock. Atomic snapshot/fsync preserves
committed state; no auto initialization, DB reset or secret regeneration. Before
switching an older O_EXCL candidate to this protocol, fully stop the old process.

Before opening registration Noah must run real HTTP/account/direct/browser gates,
one focused independent security review and adversarial UX. Registration defaults
closed. See portal/README.md and evidence/GATES.md for exact commands/rollback.

Primary sources inspected (2026-11-17):
https://github.com/serenity-kit/opaque
https://opaque-auth.com/docs/get-started/add-to-existing-project
https://github.com/serenity-kit/opaque/blob/main/SECURITY.md
https://github.com/serenity-kit/opaque/blob/main/CHANGELOG.md
https://github.com/serenity-kit/opaque/blob/main/src/lib.rs
