#!/bin/sh
set -eu
# /vm/base.qcow2 must be an administrator-prepared Debian image. No automatic downloads.
# The overlay is persistent. Reset is an explicit offline operation, never a boot side effect.
test -c /dev/kvm || { echo 'KVM unavailable' >&2; exit 1; }
test -f /vm/base.qcow2 || { echo 'Missing administrator-prepared /vm/base.qcow2' >&2; exit 1; }
# Compose gates startup on successful nft policy installation in this exact namespace.
test "$(id -u)" = 47191 || { echo 'QEMU must run as reserved UID 47191' >&2; exit 1; }
test "$(cat /control/policy-namespace)" = "$(readlink /proc/self/ns/net)" || { echo 'Policy namespace mismatch' >&2; exit 1; }
iface=${VM_TUNNEL_INTERFACE:-tun0}
case "$iface" in tun0|wg0) ;; *) exit 1;; esac
ip link show "$iface" >/dev/null || { echo 'VPN tunnel unavailable' >&2; exit 1; }
# Literal resolv.conf is bind-mounted read-only; Docker loopback DNS would bypass the UID boundary.
if grep -Eq '^[[:space:]]*nameserver[[:space:]]+(127\.|::1)' /etc/resolv.conf; then
  echo 'Loopback DNS is forbidden for the VM' >&2; exit 1
fi
if [ ! -e /vm/session.qcow2 ]; then
  qemu-img create -f qcow2 -F qcow2 -b /vm/base.qcow2 /vm/session.qcow2
fi
exec qemu-system-x86_64 -enable-kvm -cpu host -smp "${VM_CPUS:-2}" -m "${VM_MEMORY_MB:-2048}" \
  -nodefaults -no-reboot -display none \
  -drive file=/vm/session.qcow2,format=qcow2,if=virtio \
  -device virtio-vga -device intel-hda -device hda-duplex \
  -netdev user,id=net0,ipv6=off -device virtio-net-pci,netdev=net0 \
  -vnc unix:/control/display.sock -qmp unix:/control/qmp.sock,server=on,wait=off
