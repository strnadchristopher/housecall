#!/usr/bin/env bash
set -uo pipefail
pattern='littleobelisk|strnad|chriscord|christopher|192\.168\.|\.ts\.net|\b(shiva|archie|noah)\b'
hits=$(git grep -n -I -i -E "$pattern" -- . \
  ':!scripts/check-public-safe.sh' ':!Cargo.lock' ':!client/package-lock.json' \
  | grep -v -E \
    -e 'github\.com/strnadchristopher/housecall' \
    -e 'ghcr\.io/strnadchristopher/housecall' \
    -e '^\.github/FUNDING\.yml:[0-9]+:ko_fi: strnadchristopher$' \
    -e '^README\.md:[0-9]+:.*https://ko-fi\.com/strnadchristopher[)"]' \
    -e '^README\.md:[0-9]+:.*https%3A%2F%2Fgithub\.com%2Fstrnadchristopher%2Fhousecall[)&]' || true)
if [ -n "$hits" ]; then
  printf '%s\n' "$hits"
  echo "public-safe: FAIL" >&2
  exit 1
fi
echo "public-safe: OK"
