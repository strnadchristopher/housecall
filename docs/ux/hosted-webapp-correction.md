# Hosted candidate correction receipt — 2026-11-17

Same worktree, sole writer; HEAD remains `25e77650725f6fbc7035a81b7696bf6ae37a4e91`.
Read initial git status, prior implementation receipt/design, the complete parent
`housecall-hosted-first/test-results/hosted.json` and all four error contexts.
Preserved the existing candidate. No commit, push, deploy, external test target,
agent delegation, production edit, dependency install or Rust rebuild.

Changes:

- `Dockerfile`: copy only the four transitively required portal browser modules.
  `client/scripts/check-docker-source.mjs` copies client sources plus exactly that
  Docker COPY list into a temporary tree, reuses installed client dependencies,
  builds there, and removes only its own temporary tree. No portal source symlink,
  portal node_modules or repository-parent source fallback is available there.
- `client/src/hosted/HostedAccount.tsx`: changed-binding broadcasts clear/revalidate
  central state without clearing community sessions. Definite account expiry or
  binding mismatch also clears only central state. Explicit logout remains the
  browser-wide community-session clearing path, including offline local logout.
  A rejected stale delete cannot broadcast logout or revoke other tabs' sessions.
- `client/src/ui/Root.tsx`: keep the shell mounted and hidden behind central auth;
  completion/cancel returns to the original account settings pane and guest login.
- `portal/src/directory.mjs` and `portal/test/directory.test.mjs`: prune seven-day
  expired listings and unlist tombstones older than the five-minute replay window
  together with insertion in one capped atomic write. Recheck time after DNS.
  Injected-time tests fill all 1000 slots, retain tombstones through the inclusive
  replay boundary, reject old packets, reclaim capacity, reopen persisted state,
  and reject a packet that ages out during DNS. No real-time waiting.
- `client/tests/{hosted-fixture.mjs,e2e/hosted.spec.ts}`: per-case/context synthetic
  client cookie scoped to the hosted loopback origin; the fixture overwrites XFF
  with a trusted mapped identity. Publication has a separate bounded bucket.
  Previously all auth/search/publication shared the same 30-request peer bucket:
  this explains signup 429 and can produce the generic directory failure after
  desktop activity. DNS proofs remain tied to the seeded persistent signing keys;
  no production limit, signature, ownership or replay check is weakened. The parent
  rerun must confirm this diagnosis for the directory failure.
  Upload targets the ordinary input excluding camera capture. Two guest tabs now
  exist before promotion; assert restored central identity and both community
  sessions after reload, plus CAS rejection and explicit multi-tab logout.
  Stale write/delete/key-retention assertions form their own case to isolate that
  account lifecycle's limit bucket. All prior meaningful assertions remain.
- `portal/README.md`: clarify Docker/hosted source inputs, exact source-archive
  placement under the example's website fallback, and why archiving unchanged
  HEAD would omit this uncommitted candidate. No source archive was published.

Verification from worktree root:

| Command | Result |
| --- | --- |
| `node client/scripts/check-docker-source.mjs` | Passed isolated ordinary production client build; existing chunk-size warnings |
| `npm run build:hosted --prefix client` | Passed; existing chunk-size warnings |
| `npm test --prefix client` | Passed 35 files / 364 tests |
| `npm test --prefix portal` | Passed 3 file suites |
| `npm run test:directory --prefix portal` | Passed directory file suite, including both added injected-time cases |
| `(cd client && ./node_modules/.bin/tsc --noEmit --project tsconfig.json)` | Passed after final browser-test edits |
| `node --check client/scripts/check-docker-source.mjs` | Passed |
| `node --check client/tests/hosted-fixture.mjs` | Passed |
| `node --check portal/src/directory.mjs` | Passed |
| `npm run test:hosted --prefix client -- --list` | Passed: 12 cases, 6 each desktop/390px |
| `npm run test:hosted --prefix client` | Blocked before tests: configured webServer exits 1 |
| `(cd client && node tests/hosted-fixture.mjs)` | Explicit `EPERM`; no sandbox fallback |
| `git diff --check` | Passed |

Caddy example source inspection found scoped API/asset handlers, bounded body and
upstream deadlines, explicit loopback forwarding replacement, no access log, and
separate hosted/API policies. The example was not edited in this correction.
`command -v caddy` finds no executable, so syntax is **not validated** here.
No image or Rust build ran; disk remains about 4.4 GB free. Existing server binary
can be reused because this correction changes no server source.

Parent local acceptance commands (no rebuild of Rust needed):

```sh
npm run build:hosted --prefix client
npm run test:hosted --prefix client
caddy validate --adapter caddyfile --config portal/infra/Caddyfile.example
```

Two-tab behavior and the browser failure fixes are authored, typechecked and
build-checked, but remain unproven in a browser until that rerun. Original parent
browser evidence remains in the supplied scratch directory. Candidate is not
claimed ready for release.
