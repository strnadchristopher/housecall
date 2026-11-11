# Cleanup handoff

Branch `hc-clean`, started from `4e990a8`. Nothing pushed, deployed or built with Tauri.

## Changes

- **Invites without email** (`server/src/lib.rs`): `email` is optional in `POST /api/invites`; the response always has a string `link`; mail is sent only when an address is given and mail is configured. The old "log the link" fallback is gone (the link is in the response). Test `invite_without_email_returns_acceptable_link` in `server/tests/security.rs` failed first (HTTP 422), then passed. `docs/API.md` updated.
- **Compose/env**: `HOUSECALL_ORIGIN` and `HOUSECALL_PUBLIC_URL` are required (`:?` message). `GIMME_BASE_URL` and `SWITCHBOARD_URL` default to empty. Hard-coded external proxy network removed; `compose.proxy.yaml` added (`HOUSECALL_PROXY_NETWORK`, alias `housecall`). `deploy/` deleted, relevant notes moved into `.env.example` comments. `scripts/test-compose.py` no longer creates a proxy network.
- **Integrations empty by default** (code changes that were needed, not only config):
  - Gimme: `GIMME_BASE_URL` empty means dry-run (disabled) even with `GIMME_DRY_RUN=false`; the built-in personal default URL is removed.
  - Switchboard: the endpoint was hard-coded and `SWITCHBOARD_URL` was never read. `Switchboard::new` now takes the endpoint; `DJ_ENABLED=true` with an empty `SWITCHBOARD_URL` fails at startup with a clear error. The DJ feature therefore needs a Switchboard-compatible endpoint you supply.
  - `HOUSECALL_PUBLIC_URL` fallback in the server is now `http://localhost:3000`.
  - New test `server/tests/empty_integrations.rs`: all integration variables empty, configure succeeds, `/api/health` returns `{ok:true}`.
- **Scrub**: names, hosts and private addresses replaced (`chat.example.com`, `192.0.2.1`). `scripts/publish-desktop-update.sh` deleted. `client/scripts/build-desktop.mjs` no longer bakes in a default API origin (`VITE_API_ORIGIN` is optional). Check script untouched.
- **Policies**: `SECURITY.md`, `CONTRIBUTING.md`, `README.md` rewritten.
- **CI**: new `public-safe` job; `client/playwright.config.ts` receipt default is `test-results/client-playwright.json`; the artifact upload also includes `client/test-results/`.

## Verification (real results)

| Command | Result |
| --- | --- |
| `cargo fmt --all --check` | pass, no output |
| `cargo test --locked --workspace` | pass: 51 + 1 + 1 + 1 + 16 + 4 passed, 0 failed (1 ignored, pre-existing) |
| `cargo test --locked --manifest-path crates/activities/Cargo.toml` (CI runs it separately; touched `dj.rs`) | pass: 4 + 10 + 4 + 6 |
| `cargo clippy --workspace --all-targets -- -D warnings` | pass |
| `npm run build --prefix client` | pass (chunk size warning only) |
| `npm test --prefix client` | pass: 3 files, 35 tests |
| `docker compose --env-file <temp env> -f compose.yaml config -q` | pass; with the variable unset it fails with the `HOUSECALL_ORIGIN` message as intended |
| `compose.yaml` + `compose.proxy.yaml` `config -q` with `HOUSECALL_PROXY_NETWORK=edge` | pass |
| `scripts/check-public-safe.sh` | FAIL, only under forbidden paths (below) |

No test was failing before my change. Not run: Playwright e2e/voice/Plex, `cargo audit`/`deny`, the `client/src-tauri` Rust tests (I changed an origin string in `linux_permissions.rs`'s tests only), `scripts/test-compose.py` (needs Docker `up`).

## Remaining public-safe hits (forbidden paths, owned by another worker)

- `client/src/ui/Onboarding.tsx:10`, `client/src/ui/Shell.tsx:102`, `client/src/ui/screens/Media.tsx:257`: copy that names the owner.
- The old workbench fixtures and `ui.spec.ts` that carried a personal fixture username and hostname were removed with the old UI on `hc-ui`.

The CI `public-safe` job will fail until those are scrubbed.

## Notes

- `HOUSECALL_UPDATES_DIR` mount and `/updates` serving remain in compose; updates now come from GitHub Releases, so that can be removed later.
- Desktop builds without `VITE_API_ORIGIN` get an empty server origin; check how `App.tsx` handles that before releasing.
