# HouseCall public portal candidate

Only `/app/` and `/api/account/*`. The public homepage `/` is the independent
`website/` project. No existing chat app, server or native behavior is changed.
No central account is needed to connect. All server addresses are supplied by
the user; the browser reviews and navigates to that server's own frontend for
its real server-local login. No central fetch, proxy, CORS or membership change. The UI refuses the portal
hostname (including other ports) to keep its host-only cookie out of navigation.

**Registration stays closed pending acceptance.** The real exact
`@serenity-kit/opaque@1.1.0` and Playwright 1.58.1 are installed, with the real npm
lockfile retained. The earlier 1.1.1 pin was invalid: public npm returned E404.
Installed types/metadata and bounded ESM/CJS glue were inspected without dumping
embedded WASM. Dependency API/real crypto proof, static build and unit/store crash
checks pass. These are not application HTTP/browser acceptance. See
`evidence/GATES.md` for executed and parent-only gates. No deployment occurred.

## Reproducible local verification

Use Node >=20.19.0 and npm >=9. Node 20.19.2 is present here. The parent reports Debian 13's signed
Node 20.19.2 package; target runtime checks remain required; this code needs standard
Node HTTP/crypto/fs and WebCrypto, no native build, SQLite or Rust. Browser needs
WebAssembly and WebCrypto over HTTPS (localhost HTTP is a fixture exception).
Do not switch authentication routes or use a paid API.

```sh
cd /path/to/housecall/portal
df -h .                     # STOP below 5GiB free; keep task artifacts below 2GiB
export TMPDIR="${TMPDIR:-$HOME/.cache/housecall-portal-tests}"
mkdir -p "$TMPDIR"
npm ci --ignore-scripts --fetch-retries=0
npm run verify:dependency
npm audit --omit=dev
npm audit
npm run build
npm test
npm run test:account
npm run test:direct-http
npm run test:browser
```

`@serenity-kit/opaque` is pinned to 1.1.0, Playwright to 1.58.1. No semver ranges.
Retain and review `package-lock.json`; subsequent installs use `npm ci --ignore-scripts`.
OPAQUE packages inline WASM and needs no lifecycle compilation.
Playwright's browser installation is a separate parent operation. Prefer an
already installed matching Chromium; otherwise `npx playwright install chromium`
only when disk budget permits. No traces, automatic failure screenshots or video:
they could record passwords. The explicit screenshots are of an anonymous portal
and synthetic fixture address only, generated in ignored `evidence/`.

Installed-artifact review read `package.json`, all `index.d.ts`, README, MIT
LICENSE and bounded ESM/CJS wrappers, including WASM initialization and result/error
handling. The npm artifact contains no CHANGELOG.md or Rust source; do not claim a
main-branch changelog proves this artifact contains a fix. The verifier hashes
actual files, checks API shape, pin and lock integrity, and performs real
registration/two logins/stable exportKey/wrong-password rejection with explicit
`memory-constrained` KSF on both registration and login. It prints no secrets.
This does not prove WASM source equivalence or independently audit this app.
The recorded release dependency audit reported zero advisories; reproduce it
with the commands above. This is neither an application audit nor a future guarantee.
Review upstream source/provenance and any applicable advisory before registration.
Browser WASM needs CSP `wasm-unsafe-eval`, never general `unsafe-eval`. Browser E2E
must verify the copied ESM works. Its MIT license accompanies the built artifact.

## Local starts

Independent direct-connect path (no dependencies, backend or setup):

```sh
npm run build
PORTAL_PORT=43180 npm run start:direct
# Open http://127.0.0.1:43180/app/
```

Actual service with synthetic LOCAL state (never production secrets/data):

```sh
mkdir -m 700 /tmp/hc-portal-review-state
export PORTAL_STATE=/tmp/hc-portal-review-state
export PORTAL_SECRETS_FILE=/tmp/hc-portal-review-state/secrets.json
export PORTAL_ORIGIN=http://127.0.0.1:43180
npm run init
npm start
```

Do not enable registration on that plain-HTTP start for browser testing: Secure
cookies need HTTPS. `npm run test:browser` starts a private TLS fixture with the
actual service at `https://127.0.0.1:43181` and separate synthetic HTTPS server at
`https://localhost:43182` (different hostname so no portal cookie is sent). It creates short-lived self-signed certificates using openssl, temporary
OPAQUE setup, private DB, and disposable random credentials. It never contacts
an existing server. Its intentional review-only registration gate is local to
that test process. Trust errors are ignored only in the test browser context.
Use one worker. Ports must be free; never reuse someone else's server.

`test:account` forks the actual service into a fresh process and uses the actual
OPAQUE client against HTTP loopback. Raw cookies are explicitly transported by
the test to exercise service semantics; browser TLS cookie enforcement is tested
separately. Tests cover registration/proof, stable exportKey, wrong/unknown login,
AEAD write/read and absence of plaintext in DB, duplicate signup, cross-account
isolation, stale writes, CSRF, logout, malformed/replayed/expired proofs, SIGKILL restart
persistence, live second-service rejection, recent-auth deletion and session expiry. Test-only clock injection
is passed in process memory; there is no time-control HTTP route.

`test:browser` exercises real signup/login/save/read after reload, wrong password,
export, logout and HTTPS destination navigation without referrer. It checks 390px
layout, target size, keyboard path, reduced motion, and generates direct/account desktop/mobile
screenshots. Removal, locking, deletion, HttpOnly/Secure/Strict cookies and local
font loading are also asserted. Direct parsing/navigation remains usable with network disabled.
No service or crypto mocks are used. API unavailability is honest and retryable.

## Operations for independent review, not deployment authorization

Examples are in `infra/`. Production backend binds only 127.0.0.1:43180, with
Caddy separately serving `/app/` and `/`; backend downtime must NOT affect either
static path. Do not expose Node directly or point the reverse proxy at a chat
server. Check with `caddy validate --config /path/to/Caddyfile` and
`systemd-analyze verify /path/to/housecall-portal.service` on the target package
versions. Do not copy example files into production during implementation.

Create a dedicated unprivileged user, private 0700 state directory, and 0600 env
and secrets files outside source. Run `init` exactly ONCE with that user's state
and secrets paths, then preserve BOTH database and secrets across releases and
restarts. No automatic initialization in `start`. Changing setup or indexKey
breaks accounts. No registration until dependency, independent security, UX and
production checks pass; then operator explicitly sets
`PORTAL_REGISTRATION_OPEN=yes-reviewed`. Registration defaults closed but existing
accounts can log in. Closing it also refuses pending registration finishes.

This release uses a singleton atomic JSON snapshot store for at most 1,000
accounts / 100MiB, trading write throughput for small dependencies. Each write
fsyncs file and directory. It serializes writes and holds the DB in memory;
benchmark worst-case file size/fsync/event-loop latency before raising capacity.
Read-only/missing/corrupt state or secrets refuse startup. Node holds a Linux
`flock` on `service.lock` through an open descriptor; `/usr/bin/flock` from Debian's
util-linux is required, with no new npm/native dependency. Init takes the same
lock. Contending processes fail closed. Descriptor close, SIGKILL, OOM or reboot
releases OS ownership, allowing systemd restart to read the latest atomic snapshot.
The empty lock file remains permanently: NEVER unlink a live lock, replace its
inode or regenerate secrets to fix a restart. No PID/age guessing or stale-file
reaping. All writers must use this protocol on a local Linux filesystem; no NFS,
multiworker, cluster or hot parallel rollout. After a crash an incomplete `.tmp`
is ignored; the committed `accounts.json` remains authoritative. A completed
rename may survive even if the HTTP response was lost; CAS/reload resolves it.
The focused storage regression kills an actual Store process and decrypts the
latest persisted row after a new process acquires ownership; the account gate
repeats crash/restart through the actual HTTP service. DB durability depends on
local filesystem fsync. Before upgrading from the old O_EXCL candidate, stop the
old process completely: it does not participate in OS advisory locking.

Bounded settings and the API contract are in `../docs/security/PORTAL-V1.md`. Limits
are conservative, including 30 requests/min/IP across ALL account routes and
300/min global. Shared NAT users can hit the budget; retry after a minute. Only
a known loopback proxy is supported; Caddy overwrites forwarding headers. Direct
mode ignores them. Do not add a CDN/proxy chain without reviewing IP handling.

App emits only fixed startup/listening/failure lines. No request logs, raw errors,
IP/UA/username/wall-clock columns or analytics. Caddy example discards error logs
as well as omitting access logs. Independently verify journald, proxy, provider,
firewall, host login and backup policy before making deployment-wide privacy
claims. Request metadata necessarily exists transiently. The provider/root or a
malicious web publisher can read RAM and modify future code. Web E2E does not
protect against that endpoint attack. OPAQUE setup + DB theft permits guessing
weak passwords; username lookup key theft permits dictionary username checks.

Encrypted list has random account binding, revision-bound AES-GCM AAD, and a
client-only HKDF-derived key from OPAQUE exportKey. The non-extractable CryptoKey
lives in this tab only. JavaScript strings/WASM memory cannot be guaranteed
zeroized. Reload requires reauthentication even if the HttpOnly cookie persists.
Every vault PUT and account DELETE requires `expectedBinding`, the initiating
tab's immutable 32-byte canonical base64url binding. The server compares it to
the cookie-authenticated row before any mutation or invalidation; it never uses
it to select a row. Missing/malformed bindings return 400. Mismatch returns
409 `{error,code:"account_changed"}` and preserves the shared cookie, sessions,
pending exchanges and data. The client clears only its stale tab and asks for
login again, without global logout. Ordinary vault CAS 409 offers reload and
retains the typed address; registration 409 says the username is unavailable.
CAS prevents accidental concurrent overwrites; no malicious-server rollback or
fork detection, cross-device transparency, password change, email recovery or
reset exists. Password loss is unrecoverable without the password/unlocked list
or export. Plaintext export is explicit and stays on the user's device.

The footer's **Portal source** link points to the same-origin
`/source/housecall-public-source.tar.gz`. The release operator must serve the exact corresponding
source-only release archive there, excluding production secrets/state. This work
adds the offer link, not an archive or a claim of current public availability;
GitHub main does not yet contain this new API. Privacy remains linked separately.

Account deletion requires typing DELETE and authentication within five minutes.
It invalidates all sessions and pending exchanges for that account and deletes
its row/vault. It does not delete chat accounts. Filesystem/journaling/SSD and
operator backups can retain old ciphertext/records; do not promise secure physical
erasure. No backup retention automation is implemented. Any production backup
must encrypt the private DB + setup together, define retention, and test restore
without exposing secrets. Do not store plaintext exports centrally.

Rollback: close registration, stop this isolated service, keep private state and
setup, and serve the static direct-connect portal plus homepage. Preserve the
prior reviewed static artifact and the DB schema-compatible code; never roll back
the database over newer writes. There is no server/native/chat migration to undo.
Do not publish the accepted unpublished chat candidate with this isolated site.

Fable's completed approved `website/DESIGN.md` and `styles.css` were consumed
read-only from the design worktree. `/app/` uses the exact Doorway night/amber
colors, Apfel Grotezk/Inria Sans local fonts (licenses included), bare mark and
door-shaped surfaces. Connect directly is the initial view (one address); Saved
servers opens the optional account view. All prior actions remain available.
No website files were edited and no designer was invoked. Rendered screenshots,
keyboard/pointer inspection and adversarial UX require release-operator acceptance.

`PORTAL-V1.md` describes this implemented convenience subset only. The established
future identity/device/root/push/QR design in `ID-V1.md` was restored byte-for-byte
from 277414e272229e05d9138fd278f37705cefaf0d0. It is outside this task. The release
base 984405e has no ID-V1 document: integrate only the new PORTAL-V1 contract and
portal delta, never the entire unpublished candidate base.
