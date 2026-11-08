#!/usr/bin/env bash
# Run one recovery gate while sharing Noah's existing heavy-work lock.
set -euo pipefail
cd "$(dirname "$0")/.."
gate=${1:?usage: recovery-check.sh sfu-profile|server|native-linux|android-tests|android-apk|native-push-browser|chat-browser}
case "$gate" in sfu-profile|server|native-linux|android-tests|android-apk|native-push-browser|chat-browser) ;; *) exit 64;; esac
run="recovery-${gate}-$(date -u +%Y%m%dT%H%M%S)-$$"
mkdir "evidence/$run"
receipt="$PWD/evidence/$run"
exec 9</home/christopher/.hermes/workspace/sprint-recovery-20261107/heavy.lock
if ! flock -w 60 9; then
  printf 'Shared heavy lock unavailable; no gate started.\n' > "$receipt/blocked.txt"
  exit 75
fi
[ "$(df --output=avail -B1 . | tail -1)" -gt 12884901888 ] || { printf 'Less than 12 GiB free\n' > "$receipt/blocked.txt"; exit 75; }
git rev-parse HEAD > "$receipt/head.txt"
python3 scripts/recovery-source-manifest.py > "$receipt/source-before.json"
for selector in ${!CHRISCORD_TEST_@}; do unset "$selector"; done
unset RESEND_API_KEY CHRISCORD_MAIL_FROM
export CHRISCORD_PUBLIC_URL=http://localhost:1420
git diff --binary -- . ':!evidence' > "$receipt/tracked.patch"
export PATH="$HOME/.cargo/bin:$PWD/.runtime/tools/cargo-audit-x86_64-unknown-linux-gnu-v0.22.2:$PWD/.runtime/tools/cargo-deny-0.20.2-x86_64-unknown-linux-musl:$PATH"
export CARGO_TARGET_DIR="$PWD/target"
export CARGO_BUILD_JOBS=1 CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_RELEASE_DEBUG=0
export CHRISCORD_TEST_BINARY="$PWD/target/release/chriscord-server"
export CHRISCORD_TEST_PID_PATH="$receipt/server.pid"
export CHRISCORD_TEST_RECEIPT="$receipt/playwright.json" CHRISCORD_VOICE_RECEIPT="$receipt/voice.json"
export JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64
export ANDROID_HOME="$PWD/.runtime/android-sdk" NDK_HOME="$PWD/.runtime/android-sdk/ndk/28.2.13676358"
set +e
(
  set -e
  case "$gate" in
    sfu-profile)
      printf 'Historical optimized phase-instrumented binary; predates scanner/auth/VM publisher source. Not final-candidate runtime acceptance.\n' > "$receipt/binary-scope.txt"
      sha256sum "$CHRISCORD_TEST_BINARY" > "$receipt/binary.sha256"
      getconf CLK_TCK > "$receipt/clock-ticks.txt"
      CHRISCORD_TEST_LOAD=1 python3 scripts/recovery-bound.py --seconds 300 --grace 60 -- npm run test:voice --prefix client ;;
    server)
      python3 scripts/recovery-bound.py --seconds 1800 --grace 60 -- bash -c 'cargo fmt --all -- --check && cargo test --locked --manifest-path crates/media/Cargo.toml && cargo test --locked --manifest-path crates/sfu/Cargo.toml && cargo test --locked -p chriscord-server && cargo clippy --locked -p chriscord-server --all-targets -- -D warnings && cargo build --locked --release -p chriscord-server && cargo audit --deny warnings && cargo deny check' ;;
    native-linux)
      python3 scripts/recovery-bound.py --seconds 1800 --grace 60 -- bash .runtime/verify-native-final.sh ;;
    android-tests)
      cd client/src-tauri/gen/android
      python3 ../../../../scripts/recovery-bound.py --seconds 1200 --grace 60 -- ./gradlew --no-daemon --max-workers=1 :app:testUniversalDebugUnitTest ;;
    android-apk)
      python3 scripts/recovery-bound.py --seconds 1800 --grace 60 -- bash .runtime/build-android-final.sh ;;
    native-push-browser)
      python3 scripts/recovery-bound.py --seconds 1800 --grace 60 -- cargo build --locked --release -p chriscord-server
      sha256sum "$CHRISCORD_TEST_BINARY" > "$receipt/binary.sha256"
      CHRISCORD_TEST_NATIVE_PUSH=1 python3 scripts/recovery-bound.py --seconds 240 --grace 60 -- npm run e2e --prefix client ;;
    chat-browser)
      python3 scripts/recovery-bound.py --seconds 1800 --grace 60 -- cargo build --locked --release -p chriscord-server
      sha256sum "$CHRISCORD_TEST_BINARY" > "$receipt/binary.sha256"
      python3 scripts/recovery-bound.py --seconds 240 --grace 60 -- npm run e2e --prefix client ;;
  esac
) > "$receipt/output.log" 2>&1
result=$?
python3 scripts/recovery-source-manifest.py > "$receipt/source-after.json"
if ! cmp -s "$receipt/source-before.json" "$receipt/source-after.json"; then printf "Source changed during gate; do not treat as frozen candidate acceptance.\n" > "$receipt/source-changed.txt"; result=76; fi
printf '%s\n' "$result" > "$receipt/exit.txt"
df -B1 . > "$receipt/disk.txt"
printf '%s exit=%s\n' "$receipt" "$result"
exit "$result"
