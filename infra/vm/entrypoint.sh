#!/bin/sh
set -eu
# /vm/base.qcow2 must be an administrator-prepared Debian image. No automatic downloads.
# The overlay is persistent. Reset is an explicit offline operation, never a boot side effect.
test -c /dev/kvm || { echo 'KVM unavailable' >&2; exit 1; }
test -f /vm/base.qcow2 || { echo 'Missing administrator-prepared /vm/base.qcow2' >&2; exit 1; }
# Refuse startup without a VPN tunnel. Runtime isolation relies on Gluetun firewall, not this check.
ip link show tun0 >/dev/null 2>&1 || ip link show wg0 >/dev/null 2>&1 || { echo 'VPN tunnel unavailable' >&2; exit 1; }
if [ ! -e /vm/session.qcow2 ]; then
  qemu-img create -f qcow2 -F qcow2 -b /vm/base.qcow2 /vm/session.qcow2
fi
exec qemu-system-x86_64 -enable-kvm -cpu host -smp "${VM_CPUS:-2}" -m "${VM_MEMORY_MB:-2048}" \
  -nodefaults -no-reboot -display none \
  -drive file=/vm/session.qcow2,format=qcow2,if=virtio \
  -device virtio-vga -device intel-hda -device hda-duplex \
  -netdev user,id=net0,ipv6=off -device virtio-net-pci,netdev=net0 \
  -vnc unix:/control/display.sock -qmp unix:/control/qmp.sock,server=on,wait=off
