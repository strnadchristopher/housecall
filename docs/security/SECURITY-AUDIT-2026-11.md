# HouseCall bounded publication source review — November 2026

Reviewed 2026-11-17 at source base `2c56a3754f64b05e358e10dad79df69330297375`.
The task identifies publishing main `984405ea71655baf5d33a85c400dd75a52100b64`
as its antecedent and this tree as the deployed website/optional-account source.
Those deployment assertions were supplied by the task; this reviewer did not independently
read back production. Assigned owner: Codex, gpt-6.1-sol, medium; one bounded source review.

This is **not a full formal security assessment**, an independent external cryptographic
audit, a penetration test, or approval to publish or enable registration. Findings below are
confirmed by source inspection, with runtime reproduction explicitly pending. Runtime source
was left unchanged during the initial review; the authorized fix follow-up below changes F1–F3 only. Publication, provider configuration, deployments and acceptance belong
to the publication owner. Prior review documents describe historical work and are not proof
that the present implementation passes their gates.

## Publication-owner acceptance — 2026-11-17

This section records later verification and supersedes the earlier reviewers' pending-runtime
status for F1–F3 below. It does not turn this bounded assessment into an external audit.

- Independent source review found a legacy-media startup regression in the initial F2 fix.
  It was corrected with widened checked counters and an explicit interrupted-derivative fixture.
- The exact corrected source snapshot was hash-verified before and after isolated CPU acceptance.
  Fresh separate media/server Cargo targets executed **122 passing Rust cases, zero failures**:
  31 media cases, one finite-configuration case and 90 server cases covering access, media,
  E2EE, transcode recovery, snaps, security, invites, linking and route inventory.
  Three existing ignored manual/large media cases remain unrun, not counted as passes.
  Test discovery explicitly included all eleven finite-media cases and the legacy recovery case.
- The original bootstrap vulnerability was reproduced against the preceding source;
  corrected early-request/bootstrap and transactional ordering regressions passed.
  The harmless deploy-tag regression passed without deployment credentials or SSH.
- Gitleaks 8.30.1 scanned all twelve pushed Git refs, the unpublished website/portal ancestry
  and the final source tree. The original history had 138 heuristic findings; the final tree
  had 116. Each was contextually classified: explicitly fixed testing-only crypto material,
  protocol examples byte-matching those vectors, blank example settings, public VPN/certificate
  identifiers or Docker UID options mistaken for curl authentication. No live credential was
  identified in those findings. This is not a guarantee against unknown secrets.
- All 68 inventoried Actions run logs were obtained/scanned, including a retried 1.4 GB
  expanded log streamed through the scanner. Log scans reported no findings. All 34 retained
  Actions artifacts and 47 assets from five non-draft releases were downloaded and scanned
  with archive traversal (depth three) plus printable-string scans. The 55 artifact findings
  were individually verified as public VPN keys or kernel X.509 identifiers. Draft releases
  remain drafts. Packed-binary analysis remains heuristic; no installer execution, full binary
  reverse engineering, signature/source-equivalence proof or new native release is claimed.
- The separate managed-hosting prototype is not an approved service. Payments and paid VPS
  provisioning remain disabled. Its own private review and local fixture results do not
  qualify portal integration, provider operation, enrollment, DNS/TLS, backup or recovery.

No personal community server, private media, real user account/data or live deployment was
used for these checks. No security certification, universal protection, full scanner-stack,
public-network call, native-device or production backup/restore acceptance is implied.
The changes are source fixes on the publication branch, not a new released server image;
older release tags/images do not acquire these fixes automatically. Build the reviewed source
until a separately verified updated image is available.

## Scope and method

Started with `pwd`, `git status --short`, the full HEAD, branch and worktree registration;
the tree was clean and the base matched. Read the applicable parent `AGENTS.md`, repository
`SECURITY.md`, current `README.md`, portal README and relevant security/setup notes.
No repository `AGENTS.md`, `Agents.md` or `CLAUDE.md` was found. Used installed
`ast-grep outline` on the Rust route/authorization/media/identity/link/voice modules and
portal service/storage/direct-connect modules before targeted source reads and `rg` searches.
`codegraph --help` established availability; no graph was indexed and no graph coverage is claimed.

Inspected the server's public/private router split, session authentication, owner setup,
invites, access approval and joins; message and media authorization; implemented DM crypto,
key backups and device linking; SFU media boundary; preview/provider URL handling and
transcode arguments; storage/logging controls; portal OPAQUE exchanges, cookies, CSRF,
vault binding and persistence; CI, release, deployment and desktop updater source.
This was targeted inspection, not exhaustive coverage of every optional integration,
native plugin, parser, dependency, platform or route interleaving.

## Confirmed findings and assigned fix status

Mechanism descriptions and line locations below refer to the reviewed base, before fixes.

Severity describes practical impact with the stated prerequisites. High confidence means
the mechanism follows directly from the inspected code; it does not mean a live exploit ran.

### F1 — Public access request can permanently block first owner setup

**Status: implemented in this worktree; parent review and Rust runtime acceptance pending.**

**High availability impact; high confidence; unauthenticated; new installations only.**

Locations: `server/src/access.rs:44`, `server/src/access.rs:91`,
`server/src/access.rs:129`, `server/src/lib.rs:596`, `server/src/lib.rs:612`.
The request-access setting defaults open when absent. Its public handler creates a disabled,
non-owner row in `users` without checking that an owner exists. Both setup guards reject
when **any** user exists. The schema initializes the home server independently of an owner
(`server/src/servers.rs:13`), so the pending request can persist on a fresh database.

Supported-workflow trigger: expose a fresh self-hosted instance through its HTTPS proxy,
then an anonymous visitor submits one syntactically valid access request before the host
finishes the setup wizard. The legitimate setup token subsequently receives 409, including
after restart. No owner exists to approve or decline the request. This is denial of bootstrap,
not owner takeover; already initialized communities are outside this trigger.

Parent assignment: reject access requests until owner initialization is complete, checking
inside the write transaction as well as before password work. Preserve the setup token and
single-owner race guards. Add a fresh-database regression in `server/tests/access.rs` proving
that an early request cannot prevent legitimate setup, plus the concurrent ordering case.
Do not resolve this by treating a disabled pending user as the owner or deleting real data.

### F2 — Upload chunks are bounded, but persistent storage consumption is not

**Status: aggregate admission implemented; parent review and Rust runtime acceptance pending. Manual retention/expiry remains an operator gate.**

**Medium availability impact; high confidence; authenticated community member required.**

Locations: `server/src/media.rs:84`, `server/src/media.rs:95`,
`server/src/media.rs:103`, `server/src/media.rs:112`,
`crates/media/src/lib.rs:110`, `crates/media/src/lib.rs:150`,
`crates/media/src/lib.rs:346`; default data placement in `compose.yaml:15` and `compose.yaml:52`.

Ordinary upload length accepts a `u64`; only the sealed class has a total-size cap.
The store enforces 4 MiB per PATCH and the declared offset/length, but has no aggregate
per-user/storage quota, outstanding-upload cap or abandoned-upload expiry in these paths.
Incomplete chunks are encrypted and durably retained before scanning. The default Compose
data directory holds both media and SQLite, without a filesystem-size limit in Compose.

Supported-workflow trigger: an invited or approved member creates ordinary uploads in a
channel they belong to and repeatedly appends valid chunks without completing them. They
can consume available disk, impairing uploads and potentially SQLite writes on the same
filesystem. The 600 requests/minute/session throttle limits rate, not cumulative storage.
This does not imply declaring a huge length preallocates that much space. Scanning and
quarantine do not prevent exhaustion because bytes are stored first. Repeated sealed
uploads can also accumulate beyond their individual cap. The absence of a product total
cap is already acknowledged in `docs/SETUP.md`; this review records its availability cost.

Parent assignment: retain resumability but bound aggregate bytes and outstanding uploads
with atomic reservations/accounting, a configured storage budget and abandoned-upload
cleanup. Decide ordinary-file product limits explicitly. Extend `server/tests/media.rs`
with tiny synthetic budgets; prove rejection/reclamation without filling a real disk.
An ordinary-file cap alone does not fix repeated-upload exhaustion.

### F3 — Manual deploy tag is interpolated into a shell command

**Status: implemented; harmless local tag regression passed. Independent workflow/receiver acceptance pending; no dispatch/SSH executed.**

**Medium; high confidence; privileged dispatch and a crafted existing ref required.**

Locations: `.github/workflows/deploy.yml:25`, `.github/workflows/deploy.yml:28`,
`.github/workflows/deploy.yml:38`. The input is checked out as an arbitrary ref, then
inserted directly into a double-quoted shell command. Shell substitutions in that input
become executable shell syntax on the runner after workflow expression expansion.
Double quotes do not prevent command substitution. This step has the deployment key in
its environment and a temporary private file.

Realistic trigger: a repository writer supplies a crafted existing tag, and an authorized
operator dispatches the deployment for that tag and satisfies any production environment
approval. Git ref syntax permits command-substitution characters. Checkout must succeed
before the vulnerable step is reached. This is not an anonymous or fork-PR exploit and does
not establish that environment approvals are absent. The SSH forced-command restriction
does not constrain shell evaluation on the local runner.

Parent assignment: pass the input as an environment value, validate a narrow release-tag
grammar before checkout (as release.yml already does), resolve only `refs/tags/…` to a
reviewed immutable commit and use shell variable expansion rather than expression insertion.
Also validate the receiver's deploy argument contract. A harmless isolated shell/fixture
regression should reject metacharacters and branch refs; do not exercise this against a
deployment host or with deployment secrets. A harmless isolated shell check confirmed that a
whitespace-free synthetic input passes Git ref grammar and expands a command substitution.
No workflow, SSH connection or deployment was executed.

## Verified source boundaries and operator visibility

These observations describe implemented controls, not a claim that all bypasses were ruled out.

| Area | Current code and limits |
| --- | --- |
| Community authentication | `server/src/lib.rs:289` separates public endpoints from authenticated routes. `identify` at line 441 requires both bearer token and device key, compares their stored digests, checks expiry and current disabled state. Sessions last 30 days (`session_with`, line 555). Argon2 work is bounded by a two-slot semaphore. Passwords are delivered to the community server over its transport; this is separate from portal OPAQUE. |
| Owner claim and joins | Setup checks its bootstrap token and rechecks initialization in a transaction (F1 follow-up is pending acceptance). Owner checks gate invitations, approvals and server membership changes (`lib.rs:724`, `access.rs:192`, `servers.rs:195`). Invite consumption and joining share transactions (`lib.rs:865`, `lib.rs:915`). Possession of an emailed invite is the capability: acceptance does not independently prove mailbox ownership. |
| Message authorization | `lib.rs:468` checks channel membership; message access, send/edit/delete paths at lines 1142, 1219, 1361 and 1417 apply membership/author rules. Group/channel messages are stored as plaintext body fields. The SQL inspected uses bound values; schema interpolation in `servers.rs:13` uses fixed internal definitions. |
| One-to-one DMs | `client/src/crypto/dm.ts:10` derives a static-DH conversation key and uses XChaCha20-Poly1305 envelopes bound to conversation and sender/recipient. `client/src/adapters/legacy/dm.ts:110` distinguishes native E2E, browser encryption and missing-key states, with peer pin/change checks. `server/src/identity.rs:361` recognizes keyed two-person DMs; `check_send` at line 398 refuses new plaintext there. Older plaintext remains. There is no forward secrecy or global replay/rollback guarantee. First contact is TOFU; out-of-band safety-number comparison matters. |
| DM attachments | `client/src/crypto/dm.ts:89` encrypts files with per-file keys carried inside the encrypted payload. Inline MIME types are allowlisted; other content becomes an octet-stream download. `server/src/media.rs:150` treats sealed ciphertext as opaque and reports no malware scan. Sealed files remain wrapped in the server's storage encryption too. |
| Channels, groups and calls | Group/channel contents are not E2E. `server/src/voice.rs:343` checks membership before joining; its engine callback at line 305 checks session validity repeatedly. `crates/sfu/src/peer.rs:384` handles WebRTC media data and forwards it at line 624. Transport encryption terminates at the SFU; it does not hide media from the operator. Screen previews are server-readable JPEGs (`voice.rs:181`). No independent native/call runtime validation ran here. |
| Key backups and web trust | `client/src/crypto/backup.ts:21` encrypts the identity seed using recovery material; the server stores the encrypted backup (`identity.rs:242`). Recovery words plus an old backup can expose that seed; replacing words does not erase old copies. Native identity/pin storage uses the secure-session bridge; web storage is in memory (`client/src/transport/identityStorage.ts:8`). A modified web publisher can capture entered or linked keys. Memory clearing in JavaScript cannot guarantee erasure. |
| Device linking | `server/src/link.rs:218`, `:274`, `:370`, `:418` implement short-lived, session-bound start/claim/approval/result states with one-use transitions. `client/src/core/linkService.ts:101` checks the typed code and calls reauthentication before wrapping keys. Those UX/reauth checks are client controls, not extra password verification in the server's approve handler. No QR/native device acceptance was run. |
| Ordinary media/storage keys | `server/src/main.rs:66` loads the media key from operator configuration. `crates/media/src/lib.rs:150` encrypts chunks with AES-GCM and upload/offset/length AAD. The operator can decrypt ordinary files; filenames, ownership, channels and lengths are metadata. Scanner plaintext is transient processing data. Compose configures scanner scratch as tmpfs and disables container swap via equal memory/swap limits; effective host enforcement is unverified. |
| Paths, URLs and injection | Media HTTP IDs are UUIDs; filenames reject separators and controls; metadata validates chunk names (`crates/media/src/lib.rs:110`, `:320`). Embeds allow public HTTPS:443, reject mixed private/public DNS answers, pin resolution, disable proxies/redirects and bound HTML (`server/src/embeds.rs:80`, `:118`, `:127`, `:139`). Plex resources stay on the configured provider origin (`crates/activities/src/plex.rs:43`, `:236`); provider HTTP disables redirects (`crates/activities/src/lib.rs:24`). Transcoding uses argument arrays and a pipe-only protocol whitelist (`server/src/transcode.rs:410`). No concrete SSRF/path traversal/application SQL injection was established in these inspected paths; this is not exhaustive parser assurance. |
| Logs, reports and backups | Server tracing includes internal user/channel/session identifiers in some security events (`identity.rs:193`, `:412`), so “no metadata logging” is not a community-wide claim. Reports require log/screenshot consent and are owner-readable (`lib.rs:1596`, `:1658`, `:1704`). Keyword log redaction at line 1680 is not a general personal-data scrubber. `main.rs:12` restricts new data directories and the DB file on Unix; SQLite is not application-encrypted. Neither backup retention, host logging, database sidecar permissions nor restore/key-loss behavior was validated on a running host. |

## Portal OPAQUE, session and account-binding review

Source inspected: `portal/src/service.mjs`, `account-client.mjs`, `vault.mjs`, `storage.mjs`,
`limits.mjs`, `http.mjs`, `main.mjs`, `app.mjs`, direct-connect parsing and infra examples.

- The portal is a convenience account for an encrypted server-address list. Direct connect
  parses and navigates; it does not server-side fetch, proxy, log into or join communities.
  The UI rejects its own hostname as a destination (`app.mjs:14`), including alternate ports.
- `service.mjs:34` injects the real OPAQUE implementation. Registration defaults closed;
  `main.mjs:13` requires the explicit reviewed setting. Registration grants no session;
  login finish must verify the OPAQUE proof (`service.mjs:100`). Exchange IDs are random,
  stored by digest, consumed once and expire after 60 seconds. Login identifiers bind the
  normalized username and configured origin. This inspects usage, not OPAQUE/WASM internals.
- `account-client.mjs:40` requests the explicit memory-constrained KSF. The pinned
  dependency is `@serenity-kit/opaque@1.1.0`. No claim is made here about current advisories,
  WASM source equivalence, artifact provenance or cryptographic strength of that KSF.
- `service.mjs:62` sets a host-only Secure/HttpOnly/SameSite=Strict cookie with a 30-minute
  absolute server lifetime. Tokens are held as digests in memory; restart drops sessions.
  Exact-origin/custom-header/fetch-site checks at line 68 protect account requests.
- Vault PUT and DELETE compare `expectedBinding` against the cookie-selected account
  before mutation (`service.mjs:19`, `:117`, `:127`). Binding never selects the row.
  PUT also uses revision CAS; DELETE requires confirmation and authentication within five
  minutes and invalidates account sessions/exchanges. The client handles binding mismatch
  separately from ordinary write conflicts (`account-client.mjs:6`, `:52`).
- HKDF of the client OPAQUE export key derives a non-extractable AES-GCM key; AAD binds
  account and revision (`vault.mjs:17`). Reload drops the tab's key. There is no password
  reset/recovery route. Plaintext export is an explicit user download. A malicious publisher
  can replace the web code; a compromised browser can read the unlocked list. Stolen setup
  plus records permits password guessing; revision CAS is not malicious-operator rollback
  protection across fresh logins.
- Request/body/header/time/session/exchange/account/database bounds are present. Rate
  limits are 30/minute/IP and 300/minute globally; shared NAT users can be denied service.
  Forwarding headers are trusted only from explicit loopback proxy mode; its example must
  overwrite the client-supplied chain. The Node process binds loopback.
- The store checks private permissions, takes an OS flock, writes/fsyncs/renames snapshots
  and fails closed after persistence failure (`storage.mjs:5`, `:20`, `:31`). It is one local
  filesystem writer, not a cluster database. OPAQUE setup and index key must survive restart
  with the DB. Account deletion does not erase journal/filesystem/backup copies. App request
  logging is absent and errors are fixed messages; host/proxy/provider policies remain gates.

No additional concrete portal authorization or cross-account mutation defect was established
in this pass. Real OPAQUE HTTP, cross-tab/browser and deployment behavior remain unverified here.

## GitHub, download and deployment boundary

All three workflow files and `.github/actions/toolchain/action.yml` were read.
No `pull_request_target` trigger was found. CI uses `contents: read` and gates its default
self-hosted jobs against fork PRs by comparing head repository identity; the opt-in Android
job is GitHub-hosted. Pushes to same-repository branches execute project code on the default
persistent self-hosted runners (`ci.yml:5`, `:16`, `:22`, `:36`, `:50`). Anyone authorized to
push such code is therefore in the runner trust boundary. This is not proof of safe runner
isolation, cache hygiene, fork settings, action dependencies or organization runner policy.

Release is manual, validates tag syntax/version, resolves one commit and checks a supplied
image digest/revision before draft preparation (`release.yml:43`). Build jobs receive signing
secrets and release-write authority; publication requires the explicit publish input. The
source supplies Tauri updater signing configuration and `.sig` upload/manifest generation
(`client/src-tauri/tauri.conf.json:45`, `client/src/adapters/legacy/updater.ts:28`). This does
not verify any downloaded signature, OS installer signing/notarization, published manifest,
artifact completeness or key custody. Manual dispatch is not itself an independent approval
gate. Release environment protections were not queried.

Server deploy is manual-only with a production environment and pinned SSH host checking;
there is no push/tag deployment trigger. F3 is now implemented locally, pending parent acceptance. The remote forced-command script,
backup/rollback implementation and production approvals were not inspected or exercised.

Optional hardening, separate from confirmed defects: pin third-party actions to reviewed
immutable commits, review checkout credential persistence in CI/deploy, and isolate ordinary
CI runners/caches from release-signing and deployment authority. Treat these as trust-boundary
decisions; this review did not demonstrate a fork bypass or action compromise.

## Executed checks, reusable fixtures and unrun gates

Executed here: source/line reads with `sed`, `nl`, `rg`; `ast-grep outline`; Git preflight;
`node --version` (20.19.2); `npm test --prefix portal`. The latter exited 0: three test files
passed, covering direct URL/rate/proxy parsing, actual WebCrypto binding/tamper handling,
and private store locking/crash persistence. It uses synthetic temporary state. No browser,
large Cargo build, provider call or production data was used. `git diff --check` is the final
documentation whitespace gate. An isolated Python/subprocess check used `git check-ref-format`
and Bash with synthetic input to confirm F3 shell semantics, without creating a ref or invoking
the workflow. F1/F2 have not been reproduced at runtime; no application/deployment exploit ran.

Both portal and client `node_modules` are absent in this worktree. No dependencies or browsers
were installed. Parent commands below are **proposed, not passed**. Use the parent's already
reviewed dependency/artifact cache and isolated fixture state; do not silently use a different
worktree's build as proof of this source. Serialize Cargo, use a fresh per-worktree target
directory and check free disk first. Avoid the ignored multi-GiB media test for this bounded gate.

```sh
# In the reviewed worktree; parent provisions locked dependencies separately if needed.
df -h .
npm test --prefix portal
npm run verify:dependency --prefix portal
npm run build --prefix portal
npm run test:account --prefix portal
npm run test:direct-http --prefix portal
CARGO_BUILD_JOBS=1 cargo test --locked -p housecall-server --test security --test access --test invites --test media --test e2ee --test link --test route_inventory
CARGO_BUILD_JOBS=1 cargo test --locked -p housecall-server embeds::tests
# With existing client dependencies, focused non-browser tests:
cd client
./node_modules/.bin/vitest run tests/crypto-dm.test.ts tests/crypto-backup.test.ts tests/identity-dm.test.ts tests/identity-link.test.ts tests/identity-verification.test.ts --maxWorkers=1
```

Small reusable fixtures: `server/tests/access.rs`, `security.rs`, `invites.rs`, `media.rs`,
`e2ee.rs`, `link.rs`; `portal/test/account.test.mjs`, `service-child.mjs`, `storage-child.mjs`,
`direct-http.test.mjs`, `vault.test.mjs`; client crypto vectors in `client/tests/vectors/`.
Focused F1–F3 regressions are now authored below; the parent must execute and review them before treating fixes as verified.
`portal/test/browser-fixture.mjs` and `browser.spec.mjs` supply a synthetic local TLS browser
gate for a separately authorized run; no browser run was attempted here.

Publication gates still owned by the parent/publication owner:

1. Independently source-check findings and docs; assign runtime fixes, review the exact delta
   and run focused regressions plus relevant existing authorization/crypto tests.
2. Full remote Git history secret scan with a real secret scanner, including all relevant refs;
   release/artifact metadata and signature checks; exact production live readback. **Not run
   or claimed passed here.** `scripts/check-public-safe.sh` is a name-pattern policy check,
   not a secret scanner; it was read, not executed. No regex secret-scan substitute was used.
3. Review runner settings, production approvals and signing/deployment key isolation through
   authorized read-only configuration checks. Verify exact corresponding source availability
   for the deployed portal and any distributed binaries. This review did not fetch remotes,
   verify the source archive link or change repository visibility.
4. Verify OPAQUE dependency artifact/provenance/advisories and account HTTP/TLS browser gates,
   including cookie enforcement, replay, expiry, cross-tab account switching and deletion.
   Reconcile actual registration state; the source default does not prove deployment state.
5. Verify host/proxy/provider log policy, backup encryption and retention, restore with the
   correct keys, effective permissions/sidecars, scanner tmpfs/swap limits and storage budget
   on a dedicated synthetic fixture. No production secrets, private media or account data
   should be used. Native install, OS credential-store, updater, device and cross-NAT call
   claims require their own platform acceptance.

No commits, pushes, visibility changes, releases, deployments, personal-server access, emails,
paid infrastructure, global installation or `npm audit fix` occurred. Managed hosting remains
in preparation; this review provides no service qualification, pricing or launch approval.

## Confirmed-fix follow-up — 2026-11-17 (same owner, same base)

Implemented, **pending independent parent acceptance**:

- F1: `server/src/access.rs` checks owner existence and request openness before hashing
  and inside the write transaction; `/instance` is closed before initialization. Setup
  token/any-users/single-owner guards are unchanged. `server/tests/access.rs` adds early
  rejection/bootstrap and toggle-during-password-work regressions.
- F2: `crates/media/src/lib.rs` adds explicit `Limits`, mutex-held reservation before create,
  one startup metadata reconciliation, checked arithmetic, per-owner/global/file/count
  admission and conservative I/O failure handling. All upload states count; only successful
  removal releases deletion capacity. Over-budget data is retained. `Store::new` remains
  the library compatibility constructor. In-memory aggregate/owner byte counters use
  u128 so valid legacy reservations can exceed u64; persisted lengths and API limits
  remain u64.
  `server/src/media_limits.rs`, `main.rs`, `media.rs` apply validated finite production
  defaults and generic 413/429/507 errors. `dj.rs`/`transcode.rs` reserve bounded generated
  outputs and release unused bytes on committed length. Test files: new
  `crates/media/tests/limits.rs`, media unit fault-injection tests, `server/tests/media.rs`
  and adapted generated-stream regression in `server/tests/transcode.rs`.
- F3: `.github/workflows/deploy.yml` validates the release grammar before tag-only checkout,
  disables persisted checkout credentials, pins the resolved commit and uses quoted env
  variables for archive/SSH arguments. `scripts/test-deploy-tag.py` rejects malicious
  Git-ref-shaped substitutions and branch refs without executing payloads or SSH.

Configuration/docs: `.env.example`, `compose.yaml`, `compose.easy.yaml`, `docs/SETUP.md`,
`docs/SELF-HOSTING.md`. Previously completed README/SECURITY/SUMMARY work is preserved.
Defaults: 20 GiB total, 4 GiB/owner, 2 GiB/file, 16 incomplete/owner, 10,000 uploads.
Logical reservations need filesystem headroom for tiny-chunk/metadata overhead; this is
not full host/DB/log DoS protection or a tenant/billing capacity promise. No automatic
expiry/deletion is added. Set retention and reviewed manual cleanup separately.

Executed locally: `cargo fmt --all --check`,
`cargo fmt --manifest-path crates/media/Cargo.toml --check`,
`python3 scripts/test-deploy-tag.py`, `git diff --check`; isolated Python/PyYAML reads
validated both Compose budget mappings, manual production trigger and Bash syntax using
`bash -n`. No Docker, large build, dependency installation, host contact or workflow run.
Rust compilation/tests are **unrun**: no target caches and only approximately 11 GiB free
were reported; this lane is restricted to source authoring/light checks. Dependency/network,
scanner/ffmpeg and effective host resource controls remain parent environment gates.

Exact parent commands on an immutable reviewed snapshot on an isolated Linux build host, with separately
provisioned locked dependencies and parent-enforced disk/memory/time bounds (serialize):

```sh
mkdir -p .runtime/acceptance/tmp .runtime/acceptance/target
export TMPDIR="$PWD/.runtime/acceptance/tmp"
export CARGO_TARGET_DIR="$PWD/.runtime/acceptance/target"
export CARGO_BUILD_JOBS=1 CARGO_INCREMENTAL=0
cargo fmt --all --check
cargo fmt --manifest-path crates/media/Cargo.toml --check
python3 scripts/test-deploy-tag.py
timeout 30m cargo test --locked --manifest-path crates/media/Cargo.toml
timeout 30m cargo test --locked -p housecall-server --bin housecall-server media_limits::tests
timeout 30m cargo test --locked -p housecall-server --test access --test media --test e2ee --test transcode --test snaps --test security --test invites --test link --test route_inventory
git diff --check
```

Never add `--ignored`: large streaming and live scanner fixtures remain excluded. The parent
must independently review source, execute focused/normal scanner-decrypt-delete regressions,
verify finite settings in the candidate deployment, and validate the remote forced-command
receiver contract/backup semantics through its separate authorized owner. Remote receiver
source was unavailable in this repo and no host was contacted. Existing portal/crypto,
runner/signing, history-secret-scan, native/call, backup/restore and publication gates above
remain material and unverified; no claim of complete security or paid-hosting approval.

### Independent-review correction — legacy interrupted derivatives

The initial F2 candidate incorrectly treated aggregate u64 overflow as corruption.
Pre-fix transcode created two ordinary uploads with length `u64::MAX` for video and
thumbnail; DJ used the same sentinel. An interruption could therefore leave valid
metadata that prevented the finite-budget Store from opening before recovery ran.
The correction widens only in-memory total/owner byte counters to u128, including
checked admission sums, budget comparisons and reservation subtraction. Individual
lengths, public limits and file counts remain u64. Startup neither deletes data nor
rewrites legacy lengths; malformed metadata still fails closed. Over-budget stores
open for reads/deletion while new growth is denied.

`crates/media/tests/limits.rs` replaces the incorrect overflow-fails-startup expectation
with a tiny ready source plus two same-owner sentinel derivatives. It checks source
reads, unchanged sentinel lengths, denied growth, partial/full deletion reclamation,
exact owner/global capacity and another restart. The explicit malformed JSON regression
is retained. `server/tests/transcode.rs` adds Store-open-before-configure recovery using
the interrupted job's recorded video/thumbnail IDs; it requires the configured FFmpeg
file to exist but launches no media process. Fixtures contain no huge file writes.

Accounting paths were source-reviewed for create rollback, conservative failed-save
reservations, committed shrink/ready transitions and deletion release. This is not
runtime acceptance. The parent's earlier 30-pass/3-ignored media report may have used
stale shared Cargo artifacts and is not accepted as candidate correctness evidence.
The parent must archive `crates/media/tests/limits.rs` explicitly, discover and run all
its tests, and rerun the media crate, server configuration and recovery gates with a
fresh per-worktree target directory (separate from baseline output). No public API
changes should be made to accommodate stale compiled artifacts. All publication and
independent runtime acceptance gates remain pending.

Executed for this correction: `cargo fmt --all`,
`cargo fmt --manifest-path crates/media/Cargo.toml`, `cargo fmt --all --check`,
`cargo fmt --manifest-path crates/media/Cargo.toml --check`,
`python3 scripts/test-deploy-tag.py`, and `git diff --check`; all exited 0.
No Rust compilation or runtime tests were executed in this continuation.
