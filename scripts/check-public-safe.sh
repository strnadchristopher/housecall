#!/usr/bin/env bash
set -uo pipefail
pattern='littleobelisk|strnad|chriscord|christopher|192\.168\.|\.ts\.net|\b(shiva|archie|noah)\b'
hits=$(git grep -n -I -i -E "$pattern" -- . \
  ':!scripts/check-public-safe.sh' ':!Cargo.lock' ':!client/package-lock.json' \
  | grep -v 'github\.com/strnadchristopher/housecall' || true)
if [ -n "$hits" ]; then
  printf '%s\n' "$hits"
  echo "public-safe: FAIL" >&2
  exit 1
fi
echo "public-safe: OK"
