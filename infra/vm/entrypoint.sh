#!/bin/sh
set -eu
umask 007
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
# Held by this supervisor until QEMU exits; reset uses the same nonblocking lock.
exec 9>/vm/session.lock
flock -n 9 || { echo 'Another VM or disk operation is active' >&2; exit 75; }
for item in base.qcow2 base.sha512 session.qcow2; do
  test ! -L "/vm/$item" || { echo 'Symlinked VM disk files are forbidden' >&2; exit 1; }
done
if [ ! -e /vm/base.sha512 ]; then
  (cd /vm && sha512sum base.qcow2 > base.sha512.tmp && mv base.sha512.tmp base.sha512)
fi
(cd /vm && sha512sum -c base.sha512)
if [ ! -e /vm/session.qcow2 ]; then
  temp=$(mktemp /vm/.create-XXXXXX.qcow2)
  qemu-img create -f qcow2 -F qcow2 -b /vm/base.qcow2 "$temp"
  mv "$temp" /vm/session.qcow2
fi
# Optional local administration/test console. It is never a TCP listener.
set --
if [ "${VM_SERIAL_CONSOLE:-0}" = 1 ]; then
  set -- -chardev socket,id=serial0,path=/control/serial.sock,server=on,wait=off -serial chardev:serial0
fi
child=
terminate() {
  if [ -n "$child" ]; then
    kill -TERM "$child" 2>/dev/null || true
    wait "$child" 2>/dev/null || true
  fi
  exit 0
}
trap terminate TERM INT
qemu-system-x86_64 -enable-kvm -cpu host -smp "${VM_CPUS:-2}" -m "${VM_MEMORY_MB:-2048}" \
  -nodefaults -no-reboot -display none \
  -drive file=/vm/session.qcow2,format=qcow2,if=virtio \
  -device virtio-vga -device intel-hda -device hda-duplex \
  -netdev user,id=net0,ipv6=off -device virtio-net-pci,netdev=net0 \
  -vnc unix:/control/display.sock -qmp unix:/control/qmp.sock,server=on,wait=off "$@" &
child=$!
set +e
wait "$child"
result=$?
set -e
exit "$result"
