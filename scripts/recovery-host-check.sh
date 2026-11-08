#!/usr/bin/env bash
# Host-only fixture gates. Run on Noah; never on Shiva or an existing live VPN.
set -euo pipefail
cd "$(dirname "$0")/.."
gate=${1:?usage: recovery-host-check.sh compose|vm|vm-media-preflight|android-device|whole-object}
case "$gate" in compose|vm|vm-media-preflight|android-device|whole-object) ;; *) exit 64;; esac
exec 9</home/christopher/.hermes/workspace/sprint-recovery-20261107/heavy.lock
flock -w 60 9 || exit 75
[ "$(df --output=avail -B1 . | tail -1)" -gt 12884901888 ] || exit 75
run="recovery-host-${gate}-$(date -u +%Y%m%dT%H%M%S)-$$"
mkdir "evidence/$run"
receipt="$PWD/evidence/$run"
# Existing harnesses use stable receipt names. Preserve previous bytes before execution.
mkdir "$receipt/prior"
case "$gate" in
  compose) patterns=(evidence/compose-runtime.json evidence/compose-container.log evidence/client-multigib*) ;;
  vm) patterns=(evidence/vm-guest-*) ;;
  whole-object|vm-media-preflight) patterns=() ;;
  android-device) patterns=(evidence/android-e2e.json evidence/android-chat.png) ;;
esac
for file in "${patterns[@]}"; do [ ! -f "$file" ] || cp -p -- "$file" "$receipt/prior/"; done
git rev-parse HEAD > "$receipt/head.txt"
python3 scripts/recovery-source-manifest.py > "$receipt/source-before.json"
for selector in ${!CHRISCORD_TEST_@}; do unset "$selector"; done
export PATH="$HOME/.cargo/bin:$PATH" CARGO_BUILD_JOBS=1 CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_RELEASE_DEBUG=0
export CARGO_TARGET_DIR="$PWD/target"
export JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64
export ANDROID_HOME="$PWD/.runtime/android-sdk" NDK_HOME="$PWD/.runtime/android-sdk/ndk/28.2.13676358"
backend_pid= emulator_pid= adb_owned=
cleanup() {
  if [ -n "$backend_pid" ]; then kill "$backend_pid" 2>/dev/null || true; wait "$backend_pid" 2>/dev/null || true; fi
  if [ -n "$emulator_pid" ]; then
    "$ANDROID_HOME/platform-tools/adb" -P 5038 -s emulator-5580 emu kill >/dev/null 2>&1 || true
    kill "$emulator_pid" 2>/dev/null || true
    wait "$emulator_pid" 2>/dev/null || true
  fi
  if [ "$adb_owned" = 1 ]; then "$ANDROID_HOME/platform-tools/adb" -P 5038 kill-server >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT
verify() {
  case "$gate" in
    compose)
      test -z "$(sudo -n docker ps -aq --filter label=com.docker.compose.project=chriscord-sprint-compose)" || { echo 'Owned fixture project already exists; inspect before reuse'; return 75; }
      sudo -n docker volume inspect chriscord-sprint-scanner_scanner-db >/dev/null
      python3 scripts/recovery-bound.py --seconds 1800 --grace 60 -- sudo -n env DOCKER_BUILDKIT=1 docker build --progress=plain -t chriscord-sprint-compose-app .
      # Harness owns exactly this project, cleans its containers/volumes and retains signature cache.
      CHRISCORD_LARGE_BROWSER=1 python3 scripts/recovery-bound.py --seconds 1500 --grace 240 -- python3 scripts/test-compose.py ;;
    vm)
      test -c /dev/kvm
      python3 scripts/recovery-bound.py --seconds 1200 --grace 60 -- sudo -n docker build -t chriscord-vm:fixture infra/vm
      python3 scripts/recovery-bound.py --seconds 600 --grace 60 -- sudo -n docker build -t chriscord-sprint-vpn-fixture:local infra/vm/tests
      python3 scripts/recovery-bound.py --seconds 600 --grace 240 -- python3 scripts/test-vm-guest.py --download
      python3 scripts/recovery-bound.py --seconds 1200 --grace 240 -- python3 scripts/test-vm-guest.py --scenario full ;;
    vm-media-preflight)
      python3 scripts/recovery-bound.py --seconds 1200 --grace 60 -- sudo -n docker build -f infra/vm/media/Dockerfile -t chriscord-vm-publisher:local infra/vm/media
      python3 scripts/recovery-bound.py --seconds 900 --grace 60 -- sudo -n docker build -f infra/vm/media/Dockerfile.audio -t chriscord-vm-audio:local infra/vm/media
      python3 scripts/recovery-bound.py --seconds 60 --grace 30 -- sudo -n docker run --rm --network none --entrypoint /usr/bin/python3 chriscord-vm-publisher:local -c 'import gi; gi.require_version("Gst", "1.0"); gi.require_version("GstWebRTC", "1.0"); from gi.repository import Gst; Gst.init(None); assert all(Gst.ElementFactory.find(n) for n in ["rfbsrc","pulsesrc","webrtcbin","vp8enc","opusenc","rtpvp8pay","rtpopuspay"])' ;;
    whole-object)
      test -n "${CHRISCORD_FSANALYZE:-}" && test -x "$CHRISCORD_FSANALYZE" || { echo 'Provision the licensed local scanner first; no engine installed by this runner'; return 75; }
      python3 scripts/recovery-bound.py --seconds 1800 --grace 60 -- cargo build --locked --release -p chriscord-server
      sha256sum target/release/chriscord-server > "$receipt/backend.sha256"
      python3 scripts/recovery-bound.py --seconds 3000 --grace 180 -- python3 scripts/test-whole-object-engine.py --engine "$CHRISCORD_FSANALYZE" --receipt "$receipt/whole-object.json" ;;
    android-device)
      test -c /dev/kvm
      # Refuse collision with the fixture's fixed ADB/emulator/backend ports.
      python3 - <<'PY'
import socket
for port in (5038, 5580, 5581, 3031):
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', port))
PY
      python3 scripts/recovery-bound.py --seconds 1800 --grace 60 -- cargo build --locked --release -p chriscord-server
      sha256sum target/release/chriscord-server > "$receipt/backend.sha256"
      python3 scripts/recovery-bound.py --seconds 1800 --grace 60 -- bash .runtime/build-android-e2e.sh
      (cd client/src-tauri/gen/android && python3 ../../../../scripts/recovery-bound.py --seconds 1200 --grace 60 -- ./gradlew --no-daemon --max-workers=1 :app:assembleUniversalDebugAndroidTest -x :app:rustBuildUniversalDebug)
      apk=client/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
      test_apk=client/src-tauri/gen/android/app/build/outputs/apk/androidTest/universal/debug/app-universal-debug-androidTest.apk
      sha256sum "$apk" "$test_apk" > "$receipt/apks.sha256"
      adb_owned=1
      python3 scripts/recovery-bound.py --seconds 900 --grace 30 -- bash .runtime/run-emulator.sh > "$receipt/emulator.log" 2>&1 &
      emulator_pid=$!
      adb="$ANDROID_HOME/platform-tools/adb"
      timeout 180 "$adb" -P 5038 -s emulator-5580 wait-for-device
      for attempt in $(seq 1 120); do
        [ "$("$adb" -P 5038 -s emulator-5580 shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" != 1 ] || break
        sleep 1
      done
      [ "$("$adb" -P 5038 -s emulator-5580 shell getprop sys.boot_completed | tr -d '\r')" = 1 ]
      "$adb" -P 5038 -s emulator-5580 install -r "$apk"
      "$adb" -P 5038 -s emulator-5580 install -r "$test_apk"
      timeout 180 "$adb" -P 5038 -s emulator-5580 shell am instrument -w -e class com.littleobelisk.chriscord.PushStoreTest,com.littleobelisk.chriscord.PushReconcileTest com.littleobelisk.chriscord.test/androidx.test.runner.AndroidJUnitRunner > "$receipt/instrumentation.log"
      # am instrument can exit0 on test failure. Require JUnit's actual success marker.
      rg '^OK \([0-9]+ tests?\)' "$receipt/instrumentation.log"
      "$adb" -P 5038 -s emulator-5580 shell pm clear com.littleobelisk.chriscord
      mkdir "$receipt/api"
      env -i PATH="$PATH" CHRISCORD_BIND=127.0.0.1:3031 CHRISCORD_ORIGIN=http://localhost:1420 \
        CHRISCORD_DATABASE="$receipt/api/database.sqlite" CHRISCORD_MEDIA_DIR="$receipt/api/media" \
        CHRISCORD_MEDIA_KEY=1111111111111111111111111111111111111111111111111111111111111111 \
        CHRISCORD_SETUP_TOKEN=android-fixture-setup-token-not-production-12345 GIMME_DRY_RUN=true DJ_ENABLED=false \
        timeout -k 10 300 target/release/chriscord-server > "$receipt/api.log" 2>&1 &
      backend_pid=$!
      python3 - <<'PYREADY'
import time, urllib.request
for attempt in range(60):
    try:
        with urllib.request.urlopen('http://127.0.0.1:3031/api/health', timeout=1) as response:
            if response.status == 200: break
    except OSError: pass
    time.sleep(.5)
else: raise RuntimeError('Owned fixture API failed readiness')
PYREADY
      "$adb" -P 5038 -s emulator-5580 reverse tcp:3031 tcp:3031
      "$adb" -P 5038 -s emulator-5580 shell am start -n com.littleobelisk.chriscord/.MainActivity
      python3 scripts/recovery-bound.py --seconds 180 --grace 30 -- node scripts/test-android.mjs ;;
  esac
}
set +e
(trap cleanup EXIT; set -e; verify) > "$receipt/output.log" 2>&1
result=$?
python3 scripts/recovery-source-manifest.py > "$receipt/source-after.json"
if ! cmp -s "$receipt/source-before.json" "$receipt/source-after.json"; then printf "Source changed during gate; do not treat as frozen candidate acceptance.\n" > "$receipt/source-changed.txt"; result=76; fi
printf '%s\n' "$result" > "$receipt/exit.txt"
df -B1 . > "$receipt/disk.txt"
printf '%s exit=%s\n' "$receipt" "$result"
exit "$result"
