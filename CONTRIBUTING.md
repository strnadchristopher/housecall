# Contributing

## Build and test

These are the commands CI runs (`.github/workflows/ci.yml`).

Server and crates (needs `ffmpeg`, `pkg-config`, `libssl-dev`):

```sh
cargo fmt --all --check
cargo test --locked --workspace
cargo test --locked --manifest-path crates/media/Cargo.toml
cargo test --locked --manifest-path crates/activities/Cargo.toml
cargo test --locked --manifest-path crates/sfu/Cargo.toml
cargo clippy --workspace --all-targets -- -D warnings
cargo audit && cargo deny check
```

Client (Node 22):

```sh
npm ci --prefix client
npm run build --prefix client && npm test --prefix client
cargo build --locked
cd client && npx playwright install --with-deps chromium && npm run e2e && npm run test:voice && node tests/run-plex.mjs
```

Public-safety check (no personal hostnames or names in tracked files):

```sh
scripts/check-public-safe.sh
```

## Strings

User-facing text is labels, states and errors only. No instructions, marketing, explanations
or personality in the interface.

## Licensing

Contributions are licensed under AGPL-3.0. By contributing you additionally grant Maple Avenue
Labs LLC the right to distribute the project, including your contribution, through app stores.
