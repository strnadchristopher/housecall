#!/usr/bin/env bash
# Publish a signed desktop release to the self-hosted updater feed.
# Usage: scripts/publish-desktop-update.sh <tag> [notes]
# Reads release assets (+ .sig files) from the GitHub release, writes
# latest.json, and copies everything to the Chriscord server's updates dir.
set -euo pipefail
TAG=${1:?tag, e.g. v0.1.2}
NOTES=${2:-"Chriscord ${TAG#v}"}
REPO=${CHRISCORD_REPO:-strnadchristopher/chriscord}
HOST=${CHRISCORD_UPDATE_HOST:-shiva}
DEST=${CHRISCORD_UPDATE_DIR:-/mnt/nvme1tb/appdata/chriscord/updates}
BASE=${CHRISCORD_UPDATE_URL:-https://chriscord.littleobelisk.com/updates}
VERSION=${TAG#v}; VERSION=${VERSION%%-*}

WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
gh release download "$TAG" -R "$REPO" -D "$WORK" \
  -p '*.AppImage' -p '*.AppImage.sig' -p '*-setup.exe' -p '*-setup.exe.sig' -p '*.app.tar.gz' -p '*.app.tar.gz.sig'

python3 - "$WORK" "$VERSION" "$NOTES" "$BASE/$TAG" <<'PY'
import glob, json, os, sys, datetime
work, version, notes, base = sys.argv[1:]
def one(pattern):
    hits = [p for p in glob.glob(os.path.join(work, pattern)) if not p.endswith(".sig")]
    if len(hits) != 1: return None
    sig = hits[0] + ".sig"
    if not os.path.exists(sig): sys.exit(f"missing signature for {os.path.basename(hits[0])}")
    name = os.path.basename(hits[0])
    return {"signature": open(sig).read().strip(), "url": f"{base}/{name}"}
platforms = {}
if (a := one("*.AppImage")): platforms["linux-x86_64"] = a
if (w := one("*-setup.exe")): platforms["windows-x86_64"] = w
if (m := one("*.app.tar.gz")): platforms["darwin-aarch64"] = m; platforms["darwin-x86_64"] = m
if not platforms: sys.exit("no signed updater artifacts in release")
doc = {"version": version, "notes": notes,
       "pub_date": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
       "platforms": platforms}
json.dump(doc, open(os.path.join(work, "latest.json"), "w"), indent=2)
print("platforms:", ", ".join(sorted(platforms)))
PY

ssh "$HOST" "mkdir -p '$DEST/$TAG'"
scp -q "$WORK"/*.AppImage "$WORK"/*-setup.exe "$WORK"/*.app.tar.gz "$HOST:$DEST/$TAG/" 2>/dev/null || true
scp -q "$WORK/latest.json" "$HOST:$DEST/latest.json.tmp"
ssh "$HOST" "chmod -R a+rX '$DEST' && mv '$DEST/latest.json.tmp' '$DEST/latest.json'"
curl -fsS "$BASE/latest.json" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("live:", d["version"], sorted(d["platforms"]))'
