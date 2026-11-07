# Shared VM implementation boundary

Rabb.it used a shared remotely hosted browser: viewers watched one browsing session and passed control. This differs from synchronized independent movie players. Background: [Rabb.it](https://en.wikipedia.org/wiki/Rabb.it).

The optional compose `vm` profile prepares QEMU/KVM with an administrator-supplied Debian base disk, persistent qcow2 overlay, Unix-socket QMP and VNC. It joins the existing Gluetun namespace; it has no fallback bridge or host network. Do not start this profile on Shiva during development. The profile is infrastructure groundwork, not an integrated shared-browser activity.

## Enforced network boundary

Gluetun's default firewall permits its directly attached Docker subnet. Our disposable fixture reproduced direct HTTP and DNS access with both the VPN healthy and its tunnel removed. Sharing its namespace alone is therefore insufficient. See [Gluetun namespace guidance](https://github.com/qdm12/gluetun-wiki/blob/main/setup/connect-a-container-to-gluetun.md) and [firewall](https://github.com/qdm12/gluetun-wiki/blob/main/faq/firewall.md).

`vm-policy` atomically installs a separate nftables `inet chriscord_vm_47191` output hook at priority -200. It permits IPv4 sockets owned by reserved UID **47191** only when the chosen output interface is `tun0` (or explicitly configured `wg0`); it drops every other packet from that UID, including IPv6 and loopback. Other namespace users are unaffected. This nft table is independent of Gluetun's iptables-managed tables and survives their flush/restore. There is no automatic policy deletion on container shutdown.

QEMU runs as UID/GID 47191 with all capabilities dropped and no privilege escalation. This UID must be reserved across every process sharing the Gluetun network namespace. The guest's user-mode network sockets are owned by QEMU and pass through this output boundary. Guest IPv6 is also disabled. Guest-to-host loopback and Docker-subnet connections cannot bypass the policy. The read-only `infra/vm/resolv.conf` contains a literal upstream resolver, so queries use the QEMU UID rather than Docker's privileged `127.0.0.11` DNS proxy. Configure that file with the VPN provider's resolver if required; do not use a loopback proxy.

Compose waits for the policy service's healthy nft table before starting QEMU. The policy initializer requires the configured tunnel interface and records its namespace identity; QEMU rejects a missing/mismatched identity. Initialization failure starts no QEMU. Stopping the tunnel or deleting its interface leaves UID output blocked. Recreating Gluetun creates a new namespace; recreate both VM services together, so the policy installs before QEMU enters it. A host administrator deleting the entire nft ruleset can defeat this boundary; health checking detects missing tables but cannot make such privileged deletion race-free. Do not run firewall tools that flush all nft tables in this namespace. Stop the VM before intentional policy maintenance.

## Local setup prerequisites

Place an administrator-prepared Debian `base.qcow2` in the `vm-disk` volume, readable by UID47191, and set `VM_KVM_GID` to the host `/dev/kvm` group ID. The policy initializer assigns the volume roots to UID47191; it does not recursively change a supplied image. The overlay is created only when absent and persists across restarts. `VM_TUNNEL_INTERFACE` must be exactly `tun0` or `wg0`. `GLUETUN_CONTAINER` selects the already-running VPN container. No real Gluetun container was modified during development.

The VM image now requires kernel nftables support and the `nft` utility. The QEMU container image builds locally (`evidence/vm-image-build.log`), and the isolated fixture tests the shipping policy script. A Debian guest has not yet been booted as an integrated test. VNC/QMP are internal Unix transports, not WebRTC. Do not expose these sockets through an unauthenticated proxy.

## Evidence and remaining acceptance

`infra/vm/tests/test_killswitch.py` creates only disposable `chriscord-sprint-vpn-*` containers, an internal bridge, synthetic ephemeral WireGuard keys, a local WireGuard server, pinned Gluetun, HTTP/DNS canaries and an unprivileged probe. It cleans owned resources. `--nft` executes the exact shipping policy, tests working VPN HTTP/DNS, direct-subnet denial, iptables-flush persistence, tunnel-down denial, recovery and tunnel-interface deletion. `evidence/vm-killswitch-baseline-results.json` records the original Gluetun bypass, and `evidence/vm-killswitch-iptables-results.json` records the earlier scoped-iptables experiment.

External IPv6 baseline traffic fails between disposable Docker containers on this host even before policy installation. Two diagnostic attempts are preserved; subsequent nft runs mark that baseline skipped, and external IPv6 blocked observations are not accepted as proof. `infra/vm/tests/test_nft_ipv6.sh` independently proves working IPv6 loopback under UID47191 becomes blocked by the shipping policy, stays blocked after iptables flush, and remains available to another UID. That proves kernel IPv6 UID filtering, not external IPv6 VPN routing.

Still required: execute the full egress matrix **inside a booted Debian guest**, including IPv4/IPv6/DNS and Gluetun process/container restart; provision the guest image; build an authenticated WebRTC capture/audio bridge; wire the controller lease to QMP input; implement reset-to-snapshot and its owner confirmation; test queued input revocation. Reset must stop QEMU, replace only the overlay atomically, preserve the base checksum, and restart. The existing activities lease and Rust SFU do not yet provide this bridge.
