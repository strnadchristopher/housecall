#!/bin/bash
# Usage: prepare-vm-browser.sh PINNED_BASE NEW_OUTPUT
# Requires Docker/KVM. No production disk or overlay is accepted as input.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
input=$(realpath "$1")
output=$(realpath -m "$2")
expected=3b7c3342105085c60097147c7f7491e761c115170213ba7d9c87685e32d234bdafe0ddf8d6fd6600a6a837c761fa229ce8b9fe2086d1235f8eebeb778d05b977
test "$input" != "$output" && test ! -e "$output"
printf '%s  %s\n' "$expected" "$input" | sha512sum -c -
docker build --memory 3g -t housecall-vm-prepare:browser -f "$root/infra/vm/desktop/Dockerfile.prepare" "$root/infra/vm/desktop"
# The 3 GiB cloud disk is too small for Firefox and kernel upgrades.
docker run --rm --network none --entrypoint qemu-img -v "$(dirname "$output"):/image" housecall-vm-prepare:browser create -f qcow2 "/image/$(basename "$output")" 16G
docker run --rm --device /dev/kvm --memory 3g --cpus 2 --entrypoint virt-resize \
 -v "$input:/input.qcow2:ro" -v "$output:/output.qcow2" \
 housecall-vm-prepare:browser --expand /dev/sda1 /input.qcow2 /output.qcow2
docker run --rm --device /dev/kvm --memory 3g --memory-swap 3g --cpus 2 --pids-limit 512 \
 -v "$output:/image/base.qcow2" -v "$root/infra/vm/desktop:/recipe:ro" \
 housecall-vm-prepare:browser -a /image/base.qcow2 --memsize 2048 --smp 2 \
 --install xserver-xorg,lightdm,openbox,firefox-esr,pulseaudio,alsa-utils,x11-xserver-utils,fonts-dejavu-core,dbus-x11,ca-certificates,curl \
 --run /recipe/browser-guest.sh
sha512sum "$output" | tee "$output.sha512"
