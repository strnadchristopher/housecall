#!/usr/bin/env bash
# Runs every server-side Rust check CI runs, in CI's order, from the repo root.
# `cargo test --workspace` alone misses the excluded crates (media, activities, sfu).
# CI calls this script, so the two cannot drift. cargo audit/deny stay in CI only.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
# Excluded crates reuse the shared build directory instead of creating their own.
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$PWD/target}"

steps=(
  "fmt|cargo fmt --all --check"
  "workspace tests|cargo test --locked --workspace"
  "media tests|cargo test --locked --manifest-path crates/media/Cargo.toml"
  "activities tests|cargo test --locked --manifest-path crates/activities/Cargo.toml"
  "sfu tests|cargo test --locked --manifest-path crates/sfu/Cargo.toml"
  "clippy|cargo clippy --workspace --all-targets -- -D warnings"
)

passed=0
for step in "${steps[@]}"; do
  name="${step%%|*}"
  command="${step#*|}"
  echo "==> $name: $command"
  if $command; then
    echo "PASS $name"
    passed=$((passed + 1))
  else
    echo "FAIL $name"
    echo "Summary: $passed of ${#steps[@]} steps passed; stopped at '$name'."
    exit 1
  fi
done
echo "Summary: all ${#steps[@]} steps passed."
