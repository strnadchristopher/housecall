#!/bin/sh
set -eu
# This table is separate from Gluetun's iptables-managed tables. Never flush any other table.
# UID 47191 is reserved exclusively for this QEMU process in the shared network namespace.
iface=${VM_TUNNEL_INTERFACE:-tun0}
case "$iface" in tun0|wg0) ;; *) echo 'VM_TUNNEL_INTERFACE must be tun0 or wg0' >&2; exit 1;; esac
ip link show "$iface" >/dev/null
policy=$(mktemp)
trap 'rm -f "$policy"' EXIT
if nft list table inet housecall_vm_47191 >/dev/null 2>&1; then
  echo 'delete table inet housecall_vm_47191' >> "$policy"
fi
cat >> "$policy" <<POLICY
add table inet housecall_vm_47191
add chain inet housecall_vm_47191 output { type filter hook output priority -200; policy accept; }
add rule inet housecall_vm_47191 output meta skuid 47191 meta nfproto ipv4 oifname "$iface" accept
add rule inet housecall_vm_47191 output meta skuid 47191 drop
POLICY
# One transaction: replacement failure preserves existing rules; no delete/add window.
nft -f "$policy"
nft list chain inet housecall_vm_47191 output
