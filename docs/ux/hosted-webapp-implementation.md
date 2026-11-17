# HouseCall hosted webapp implementation candidate

Date: 2026-11-17. Base: `25e77650725f6fbc7035a81b7696bf6ae37a4e91`.
Worktree: `/home/christopher/GitHub/.worktrees/chriscord/hosted-webapp`,
branch `noah/hosted-webapp`. One Codex implementer; no additional agents,
commits, pushes, deployments, production access or external test targets.
Model/effort and session identifiers are not exposed in this task context.
The pre-existing untracked `hosted-webapp-design.md` was read and preserved.

**Candidate, not ready to ship.** Source and focused unit/build checks exist;
actual browser acceptance and visual inspection remain blocked by this sandbox's
listener restrictions. Do not open registration/directory/hosting gates on this
report alone. No deployment or source archive upload was attempted.

## Implemented behavior

- `npm run build:hosted --prefix client` builds the real React client at `/app/`
  into `client/dist-hosted`. Native and self-host builds still use `client/dist`.
  Hosted permission is a compile-time mode, independent of hostname, hashes and
  `VITE_API_ORIGIN`. Its dev mode has no community API proxy.
- `/app/`, `#login`, `#account` select HouseCall login, `#signup` selects account
  creation, and `#direct` selects community login. Forms reuse the existing mark,
  tokens, Field, Button, ErrorLine and NavRow. One primary action per form;
  direct-connect remains available without a central account or successful API
  preflight. Stored community sessions can open while account restoration fails.
- The original portal `Account` performs real OPAQUE, account binding checks and
  vault CAS. Hosted-only opt-in persistence stores a non-extractable AES-GCM key
  and binding in IndexedDB, never passwords or raw export keys. Refresh validates
  the current HttpOnly account session/binding before opening the encrypted list.
  Definite expiry removes the matching device key; outages do not discard it.
  Conditional deletion prevents a stale tab from deleting a newer account's key.
  Same-origin script execution and copied browser profiles remain outside this
  storage protection, as with existing browser community session storage.
- The same `App`, `LegacyHost`, `useHosts`, transport, shell and picker handle
  direct guests and HouseCall users. Hosted identity allows direct cross-origin
  authentication; ordinary browser identity restrictions remain. Requests omit
  cookies, reject redirects and bind REST/media credentials to the selected host.
  REST/public/account requests have time bounds. Media streaming retains its
  normal lifecycle instead of aborting every long video after a fixed timeout.
- After community authentication, the optional checked Save checkbox saves only
  its origin to the existing encrypted format-1 list. No community password,
  token, device key, invite secret, membership or authority is synchronized.
  Saved entries use the existing picker; a fresh device must authenticate to
  the community. Settings can save an active guest session after HouseCall login
  without entering its community password again. Unlink changes only the vault.
- Account settings contain plaintext export warning, bounded format-1 import,
  unlink confirmation, accurate lack-of-password-reset copy and account deletion.
  Logout clears the device key, community sessions and browser session wrapping key and notifies other hosted
  tabs. Web Locks serialize hosted account operations; binding/CAS checks remain
  authoritative, including writes from older portal clients. No vault format or
  account database schema migration was introduced.
- Avatar caches are scoped to a stable per-host/per-session media fetcher, avoiding
  collisions when different servers issue identical user IDs and media paths.
- Public search reads only the separate directory. Owner-only home-server
  settings confirm public name/description/origin before publishing. The server
  retains an Ed25519 key and signs metadata to the fixed central directory URL.
  DNS TXT proof binds the advertised origin to that key. The central service
  performs bounded DNS resolution, never generic HTTPS probes or community fetches.
  Updates, unpublish, replay checks, key rotation and seven-day stale expiry are
  implemented. Renewal is manual via Update listing; no periodic publisher was
  added. Directory and registration remain separately gated and off by default.
- The Caddy example changes only the hosted asset route/policy and explicit API
  routes. No access logging was enabled. Account/directory responses keep their
  restrictive policy. Hosted assets permit direct HTTPS connections, blob media
  and self-only camera/microphone. No VPS chat/media/RTC proxy was introduced.

## Changed paths

| Area | Paths |
| --- | --- |
| Explicit build | `client/package.json`, `client/vite.config.ts`, `client/src/main.tsx`, `.gitignore` |
| Hosted state/forms/settings/search | `client/src/hosted/{config.ts,target.ts,portal.d.ts,HostedAccount.tsx,HostedViews.tsx,DirectorySettings.tsx,hosted.css}` |
| Existing host adapters | `client/src/App.tsx`, `client/src/adapters/legacy/{LegacyHost.tsx,hosts.ts,identity.ts,chat.ts}` |
| Existing shell/settings | `client/src/ui/Root.tsx`, `client/src/ui/kit.tsx`, `client/src/ui/onboarding/Onboarding.tsx`, `client/src/ui/settings/{SettingsView.tsx,sections.tsx}`, `client/src/ui/shell/{AppShell.tsx,ServerPicker.tsx,nav.ts}`, `client/src/core/chat.ts` |
| Direct transport | `client/src/transport/{api.ts,publicApi.ts,webSession.ts}`; existing session format retained with an explicit browser-wide clear operation |
| Portal persistence | `portal/src/{account-client.mjs,device-vault.mjs,http.mjs}`, `portal/scripts/build.mjs` |
| Public directory | `portal/src/{directory.mjs,service.mjs,main.mjs}`, `server/src/{directory.rs,lib.rs}` |
| Acceptance | `client/playwright.hosted.config.ts`, `client/tests/hosted-fixture.mjs`, `client/tests/e2e/hosted.spec.ts`, `client/tests/hosted-transport.test.ts`, `portal/test/directory.test.mjs`, `server/tests/directory.rs`, `portal/package.json` |
| Operator documentation | `portal/infra/Caddyfile.example`, `portal/README.md`, `docs/SELF-HOSTING.md`, this report |

Dependencies/lockfiles are unchanged. Existing installed dependencies were reused.

## Executed checks

Commands run from the worktree root unless noted. Baseline client unit tests passed
before source edits: 34 files, 361 tests. Baseline portal pure/store/vault tests
passed: three file suites. The supplied task states that the existing built `/app/`
root was already qualified at the base; that is not new cross-origin acceptance.

| Exact command | Result |
| --- | --- |
| `npm test --prefix client` | Changed suite: 35 files, 364 tests passed, including three new host-bound transport cases |
| `npm run build --prefix client` | Passed ordinary production build; existing large-chunk warnings remain |
| `npm run build:hosted --prefix client` | Passed hosted production build, copied pinned OPAQUE ESM + MIT license |
| `npm test --prefix portal` | Passed three file suites (direct parsing, vault format, storage) |
| `npm run test:directory --prefix portal` | Passed DNS/signature/publication, replay, unsafe-origin, pagination, stale-expiry, unlist and DNS-key-rotation cases |
| `npm run build --prefix portal` | Passed legacy portal asset build, including new device-vault module |
| `npm run verify:dependency --prefix portal` | Passed pinned metadata/artifact checks and real OPAQUE registration/two logins/stable exportKey/wrong-password proof |
| `CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 cargo build -p housecall-server --locked` | Passed debug server build |
| `CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 cargo test -p housecall-server --test directory --test access --test profile --test invites --locked` | Passed 32 integration tests: 1 directory, 8 access, 16 profile, 7 invites |
| `CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 cargo test -p housecall-server --lib --no-default-features` | 48 passed, 16 failed, 2 ignored; runtime/socket fixtures blocked |
| `CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 cargo test -p housecall-server --locked` | Compiled test targets, then same library result; later suites not reached. Log: `/tmp/housecall-hosted-cargo-test.log` |
| `cargo fmt --all -- --check` | Passed after formatting only the new Rust files/module ordering |
| `npm run test:account --prefix portal` | Blocked: actual service child exits before listening in sandbox |
| `npm run test:direct-http --prefix portal` | Blocked: “Actual loopback service could not start; run outside sandbox” |
| `npm run test:browser --prefix portal` | Blocked before tests: configured webServer exits 1; direct fixture run says “Browser fixture could not listen” |
| `npm run test:hosted --prefix client` | Blocked before browser execution: configured webServer exits 1. Direct synthetic fixture attempt reports `EPERM`, explicitly no sandbox fallback |
| `npm run test:hosted --prefix client -- --list` | Discovers ten production-built acceptance cases across desktop and 390×844 |
| `node --check portal/src/account-client.mjs`, `node --check portal/src/directory.mjs`, `node --check client/tests/hosted-fixture.mjs` | Passed syntax checks |
| `git diff --check` | Passed |

The 16 Rust failures include permission-denied listeners in activities, DJ, Gimme,
push and VM-media fixtures, VM input unavailable in the QMP test, and a VM-reset
fixture assertion. They are not waived or reported as passing. Parent reruns must
resolve their results. No external providers were contacted as a test substitute.

Disk began around 6.3 GB free. Debug/incremental were disabled and jobs stayed at
the repository's bounded setting. Full target compilation grew task `target` to
about 2.2 GB; the shared disk also fell to roughly 2.1 GB free. Further Rust builds
were stopped. No baseline, unrelated files or shared caches were cleaned.

## Parent-only acceptance and remaining release gates

Use the same inspectable candidate with enough disk space (at least 6 GiB free
before Rust builds). Do not weaken this sandbox or change fixtures to skip network
assertions. No production access is required or authorized by these commands.

```sh
cd /home/christopher/GitHub/.worktrees/chriscord/hosted-webapp
df -h .
export CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0
cargo fmt --all -- --check
cargo build -p housecall-server --locked
cargo test -p housecall-server --locked
npm test --prefix portal
npm run test:directory --prefix portal
npm run build --prefix portal
npm run test:account --prefix portal
npm run test:direct-http --prefix portal
npm run test:browser --prefix portal
npm test --prefix client
npm run build --prefix client
npm run build:hosted --prefix client
npm run test:hosted --prefix client
caddy validate --adapter caddyfile --config portal/infra/Caddyfile.example
git diff --check
```

Caddy is not installed in this sandbox, so its validation remains unexecuted.
The parent browser suite starts only isolated local TLS origins, two real chat
server processes, the real OPAQUE service and a synthetic scanner. It builds no
fake chat UI and does not intercept successful auth or chat responses. Account
outage is a real HTTP 503 fixture gate, independent of asset/community serving.
The debug-only publication override accepts loopback HTTP only; release builds
always use the fixed public URL. Do not pass a release binary to this suite.

The suite covers login/signup keyboard paths, 390px layout, guest-only API outage,
actual message/upload/media/RTC paths, two server identities, link/reload, fresh-device
community auth, unlink with a connected community, guest promotion, stale CAS,
account binding/key retention, multi-tab logout, owner publication/search/unpublish
and non-owner UI. Independent server tests assert non-owner authorization. It
writes only blank-form screenshots and sanitized request origin/RTC summaries in
ignored `client/hosted-evidence/`; no passwords, cookies, tokens or query strings.
No browser screenshot or request-origin artifact has actually been produced here.

Additional required review after the suite can run:

- Inspect every desktop/mobile screenshot and walk actual clicks, focus return,
  picker keyboard navigation, pagination, errors, mobile drawer and software-keyboard
  behavior. Tests are authored but not browser-debugged in this environment.
- Repeat on trusted HTTPS origins with no certificate override and inspect actual
  production Caddy CSP/Permissions-Policy, microphone/camera and RTC candidates.
  Local tests deliberately trust only their synthetic certificates through the
  browser test option; they do not prove public certificate or local-network policy.
- Exercise the ordinary same-origin browser client and applicable native smoke
  gates; compilation/unit tests alone do not prove native runtime non-regression.
  Existing passkey endpoints remain unchanged; the current client has no passkey
  sign-in UI. Cross-origin WebAuthn cannot reuse a community's RP origin. Native
  push/secure OS storage and platform integrations remain native-only.
- Confirm old portal writes and newer hosted writes retain format-1 rollback
  compatibility and non-overwrite behavior with actual concurrent browser tabs.
  First-device login, import/export/delete and service restart/expiry need full
  lifecycle review; pure vault/account proofs are not a replacement.
- Validate the new separate self-host release before advertising directory support.
  Review DNS provider propagation/rotation, expiry/owner recovery and capacity.
- Keep registration, directory and hosting holds closed. Prepare a versioned static
  release, exact corresponding-source archive/license offer and old release/config
  target before any separately authorized rollout. Roll back assets/config only,
  preserving account writes and the separate directory file. No VPS steps were run.

## UI guideline re-check

The full local UI guidelines and design handoff were read. The user's explicit
sober centered login overrides their decorative hero/type/artifact defaults.
Source review checked palette/type/token cohesion, bare existing mark/icons, no
new decorative gradients/glows/cards/pills/mockups, no content hidden behind an
entrance animation, one primary action with a quiet secondary route, field order,
password autocomplete sections, responsive width/gutters, touch input sizing,
error semantics, native button/switch keyboard behavior, long DNS wrapping,
scrolling and clear disclosure before public listing. Existing shell components
and their motion/reduced-motion rules are reused. Hosted-only touch styling is
scoped by `data-hosted` so native/self-host fields do not change.

The visual parts of that re-check are **pending**, not claimed complete: browser
listeners cannot start here. Exact centering, contrast, clipped edges, keyboard
occlusion, focus return and real control behavior must be inspected in the parent
screenshots/browser. Fix any failures before calling the candidate ready.
