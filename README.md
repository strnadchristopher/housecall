# Chriscord

Private, invite-only chat, voice and shared activities for Christopher and friends.

This sprint is **in progress**, not production-ready. [PROGRESS.md](PROGRESS.md) records verified results and remaining work; [PLAN.md](PLAN.md) contains acceptance milestones. No push or deployment is part of this task.

- Rust HTTP service and SQLite: `server/`
- Shared client state, transport and hooks: `client/src/`
- Opus-owned presentation: `client/src/ui/`; [UI contract](docs/UI-CONTRACT.md)
- Encrypted resumable media: `crates/media/`
- Rust SFU: `crates/sfu/`
- Synchronized activity protocol/provider adapters: `crates/activities/`
- [Setup](docs/SETUP.md), [API](docs/API.md), [threat model](docs/THREAT-MODEL.md), [decisions](docs/DECISIONS.md), [test matrix](docs/TEST-MATRIX.md)

For local development: install client dependencies with `npm ci --prefix client`, run `npm run build --prefix client`, create a private env file with `python3 scripts/init-env.py`, and run `cargo run -p chriscord-server` with the documented env variables. Docker packaging uses `compose.yaml`. Do not use production data or credentials in tests.

`UI_CONTRACT_READY` signals the presentation handoff. `SPRINT_DONE` will exist only after every required acceptance gate actually passes.
