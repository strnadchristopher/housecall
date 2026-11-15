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
add rule inet housecall_vm_47191 output meta skuid 47191 meta nfproto ipv4 oifname "$iface" counter accept
POLICY
# Kernel WireGuard preserves the originating socket UID on encrypted outer
# packets. Permit only its privileged fwmark + exact numeric peer endpoint.
# QEMU has no NET_ADMIN/NET_RAW and cannot set SO_MARK; plaintext stays denied.
if ip -details link show "$iface" | grep -qw wireguard; then
  mark=$(wg show "$iface" fwmark)
  endpoint=$(wg show "$iface" endpoints | cut -f2)
  rule=$(python3 - "$mark" "$endpoint" <<'PY'
import ipaddress, sys
mark = int(sys.argv[1], 0)
address, port = sys.argv[2].rsplit(':', 1)
address = ipaddress.IPv4Address(address)
port = int(port)
assert mark > 0 and mark <= 0xffffffff and 1 <= port <= 65535
print(f'add rule inet housecall_vm_47191 output meta skuid 47191 meta nfproto ipv4 meta mark {mark} ip daddr {address} udp dport {port} counter accept')
PY
  )
  printf '%s\n' "$rule" >> "$policy"
fi
cat >> "$policy" <<POLICY
add rule inet housecall_vm_47191 output meta skuid 47191 counter drop
POLICY
# One transaction: replacement failure preserves existing rules; no delete/add window.
nft -f "$policy"
nft list chain inet housecall_vm_47191 output
