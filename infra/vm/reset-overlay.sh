#!/bin/sh
# Explicit offline reset. The running launcher holds the same exclusive lock.
set -eu
[ "${1:-}" = '--confirm-reset-to-base' ] && [ "$#" = 1 ] || {
  echo 'Usage: reset-vm-overlay --confirm-reset-to-base (VM must be stopped)' >&2; exit 2;
}
test "$(id -u)" = 47191 || { echo 'Reset must run as reserved UID 47191' >&2; exit 1; }
umask 007
exec 9>/vm/session.lock
flock -n 9 || { echo 'VM is running or another disk operation is active' >&2; exit 75; }
for item in base.qcow2 base.sha512 session.qcow2; do
  test ! -L "/vm/$item" || { echo 'Symlinked VM disk files are forbidden' >&2; exit 1; }
done
test -f /vm/base.sha512 || { echo 'Boot once to record the trusted base checksum' >&2; exit 1; }
(cd /vm && sha512sum -c base.sha512)
temp=$(mktemp /vm/.reset-XXXXXX.qcow2)
trap 'rm -f "$temp"' EXIT
qemu-img create -f qcow2 -F qcow2 -b /vm/base.qcow2 "$temp"
qemu-img check -f qcow2 "$temp"
sync "$temp"
mv -f "$temp" /vm/session.qcow2
sync /vm
printf '%s\n' 'Overlay reset to verified base; persistent changes were removed. Start the VM explicitly.'
