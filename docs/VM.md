# Shared VM implementation boundary

Rabb.it used a shared remotely hosted browser: viewers watched one browsing session and passed control. This differs from synchronized independent movie players. Background: [Rabb.it](https://en.wikipedia.org/wiki/Rabb.it).

The optional compose `vm` profile prepares QEMU/KVM with an administrator-supplied Debian base disk, persistent qcow2 overlay, Unix-socket QMP and VNC. It joins the existing Gluetun namespace; it has no fallback bridge or host network.. The profile is infrastructure groundwork, not an integrated shared-browser activity.

## Enforced network boundary

Gluetun's default firewall permits its directly attached Docker subnet. Our disposable fixture reproduced direct HTTP and DNS access with both the VPN healthy and its tunnel removed. Sharing its namespace alone is therefore insufficient. See [Gluetun namespace guidance](https://github.com/qdm12/gluetun-wiki/blob/main/setup/connect-a-container-to-gluetun.md) and [firewall](https://github.com/qdm12/gluetun-wiki/blob/main/faq/firewall.md).

`vm-policy` atomically installs a separate nftables `inet housecall_vm_47191` output hook at priority -200. It permits IPv4 sockets owned by reserved UID **47191** only when the chosen output interface is `tun0` (or explicitly configured `wg0`); it drops every other packet from that UID, including IPv6 and loopback. Other namespace users are unaffected. This nft table is independent of Gluetun's iptables-managed tables and survives their flush/restore. There is no automatic policy deletion on container shutdown.

QEMU runs as UID/GID 47191 with all capabilities dropped and no privilege escalation. This UID must be reserved across every process sharing the Gluetun network namespace. The guest's user-mode network sockets are owned by QEMU and pass through this output boundary. Guest IPv6 is also disabled. Guest-to-host loopback and Docker-subnet connections cannot bypass the policy. The read-only `infra/vm/resolv.conf` contains a literal upstream resolver, so queries use the QEMU UID rather than Docker's privileged `127.0.0.11` DNS proxy. Configure that file with the VPN provider's resolver if required; do not use a loopback proxy.

Compose waits for the policy service's healthy nft table before starting QEMU. The policy initializer requires the configured tunnel interface and records its namespace identity; QEMU rejects a missing/mismatched identity. Initialization failure starts no QEMU. Stopping the tunnel or deleting its interface leaves UID output blocked. Recreating Gluetun creates a new namespace; recreate both VM services together, so the policy installs before QEMU enters it. A host administrator deleting the entire nft ruleset can defeat this boundary; health checking detects missing tables but cannot make such privileged deletion race-free. Do not run firewall tools that flush all nft tables in this namespace. Stop the VM before intentional policy maintenance.

## Local setup prerequisites

Place an administrator-prepared Debian `base.qcow2` in the `vm-disk` volume, readable by UID47191, and set `VM_KVM_GID` to the host `/dev/kvm` group ID. The policy initializer assigns the volume roots to UID47191; it does not recursively change a supplied image. The overlay is created only when absent and persists across restarts. `VM_TUNNEL_INTERFACE` must be exactly `tun0` or `wg0`. `GLUETUN_CONTAINER` selects the already-running VPN container. No real Gluetun container was modified during development.

The VM image now requires kernel nftables support and the `nft` utility. The QEMU container image builds locally (`evidence/vm-image-build.log`), and the isolated fixture tests the shipping policy script. A Debian guest has not yet been booted as an integrated test. VNC/QMP are internal Unix transports, not WebRTC. Do not expose these sockets through an unauthenticated proxy.

## Evidence and remaining acceptance

`infra/vm/tests/test_killswitch.py` creates only disposable `housecall-sprint-vpn-*` containers, an internal bridge, synthetic ephemeral WireGuard keys, a local WireGuard server, pinned Gluetun, HTTP/DNS canaries and an unprivileged probe. It cleans owned resources. `--nft` executes the exact shipping policy, tests working VPN HTTP/DNS, direct-subnet denial, iptables-flush persistence, tunnel-down denial, recovery and tunnel-interface deletion. `evidence/vm-killswitch-baseline-results.json` records the original Gluetun bypass, and `evidence/vm-killswitch-iptables-results.json` records the earlier scoped-iptables experiment.

External IPv6 baseline traffic fails between disposable Docker containers on this host even before policy installation. Two diagnostic attempts are preserved; subsequent nft runs mark that baseline skipped, and external IPv6 blocked observations are not accepted as proof. `infra/vm/tests/test_nft_ipv6.sh` independently proves working IPv6 loopback under UID47191 becomes blocked by the shipping policy, stays blocked after iptables flush, and remains available to another UID. That proves kernel IPv6 UID filtering, not external IPv6 VPN routing.

Still required: execute the full egress matrix **inside a booted Debian guest**, including IPv4/IPv6/DNS and Gluetun process/container restart; provision the guest image; build an authenticated WebRTC capture/audio bridge; wire the controller lease to QMP input; implement reset-to-snapshot and its owner confirmation; test queued input revocation. Reset must stop QEMU, replace only the overlay atomically, preserve the base checksum, and restart. The existing activities lease and Rust SFU do not yet provide this bridge.

## Recovery input gateway candidate

`HOUSECALL_VM_QMP_SOCKET` and `HOUSECALL_VM_CHANNEL_ID` opt into one fixed private Unix socket/channel. The authenticated POST `/api/channels/:id/vm/input` accepts `{expected_revision,event}` where event is `key` with a whitelisted QEMU qcode, `pointer` with normalized integer x/y0..32767, or `click` with a whitelisted button. Key/button down/up are paired; arbitrary QMP, held modifiers and caller-selected socket paths are rejected. `/api/me` reports `vm_input` configuration separately from `vm_media:false`.

The handler rejects backlog, requires connected voice, checks VM activity/current controller lease/revision, completes the QMP handshake, then checks current connected voice again and final database session/membership/controller authority. Activity changes share the same operation gate. QMP has a total2second deadline and64KiB response bound. The new Rust fixtures cover paired release, session and voice revocation during handshake and a trickled greeting. They are authored, not compiled/executed in the lock-constrained sandbox.

App engineering intents for the `vm` screen are `key` (`values.key`), `pointer` (`values.x/y`) and `click` (`values.button`); the current activity revision/controller is used automatically. Opus owns visible pointer/keyboard controls. This is an input candidate, not a completed remote desktop: the private VNC socket still needs a capture/WebRTC bridge, and QEMU needs a private audio backend before system sound can be streamed. Do not interpret a successful QMP response as proof the guest accepted physical input.

Historical guest receipts in `evidence/vm-guest-*-results.json` supersede the earlier pre-boot paragraph above for their exact fixture source. Final candidate guest/network/reset verification is the explicit `bash scripts/recovery-host-check.sh vm` host gate. Existing offline reset preserves the base checksum; app-driven owner confirmation/stop/reset/restart remains outstanding.


## Optional private media overlay candidate

`compose.vm-media.yaml` now wires the private publisher/audio/source-admission components documented in VM-MEDIA.md. It is an explicit overlay for the `vm` profile, never enabled by the default Compose command. Separate named volumes expose only display/audio/signaling to the publisher, while QMP and persistent guest disks remain excluded. The guest still shares only its existing VPN namespace; the publisher has a separate restricted namespace. QEMU uses output-only audio and an absolute USB tablet; default configurations select a silent backend rather than discovering host audio.

The public authenticated host action POST `/api/channels/:id/vm/media` with `expected_revision` arms the source; DELETE disarms, GET reports configured/armed/phase. The private Unix bridge accepts exactly UID47192; no user tokens reach it. Source admission binds the current host device's connected voice session, membership, VM and a short heartbeat lease. The SFU reserves one publish-only source in addition to its30human admission cap, excludes it from the activity roster and sends it no user tracks. This adds an admission class, not a30-peer performance fix. Capture/runtime/guest/browser verification remains pending.

Socket restart uses a held lifecycle lock and recorded device/inode in an owner-writable signaling directory (02750). It preserves live, foreign and unrecorded paths. Only a matching stale socket proven connection-refused is reclaimed; normal shutdown removes only the recorded owned inode.

## Authenticated offline reset continuation

`HOUSECALL_VM_SUPERVISOR_SOCKET` enables POST `/api/channels/:id/vm/reset` with `expected_revision`, UUID `operation`, and the exact explicit confirmation `discard_vm_changes`. Only the current VM host holding the unexpired controller lease in this device's connected voice session can request it. The private supervisor accepts only the app UID10001; the app verifies supervisor UID47191. Neither side accepts caller paths or QMP/process commands.

The shipping entrypoint now retains the common disk lock in the Python supervisor. It stops and reaps only its own QEMU process, verifies the trusted base checksum, creates/checks a new qcow2 offline, then asks the server to revalidate authority before replacement. The final database check and bounded commit write share a DB lock. The original remains available through atomic rename and durable journal/receipt updates; repeated crashes during rollback preserve the original. A failed candidate start rolls back. A durable committed reset remains committed if only its response/receipt exchange fails. The12GiB reserve is checked before stop, candidate creation and replacement. Media is disarmed and must be explicitly rearmed.

GET on the same route discovers only the authenticated initiating user's latest operation in a channel they still belong to. SQLite binds the operation to its initiating session; a new login may read its outcome but cannot replay its destructive POST. The private `reset_status` command only reads the receipt/journal. Responses distinguish `none`, `pending`, `unknown`, `reset` and `rolled_back`; connection failure does not imply rollback. App discovery runs after authentication/activity loading and blocks a new operation if discovery fails. A pending/unknown operation offers a status check; initial confirmation alone offers cancellation. No bearer token, device key, or reset operation is persisted in browser storage.

The supervisor's successful QMP `query-status.running` proves only QEMU process readiness. It does not prove guest OS boot, desktop usability, audio or physical latency. Eleven tiny-file transaction/status tests and typed client transport tests cover only their named logic. Rust router tests, actual UID denial, process/disk behavior, browser reload and real guest reset remain execution gates. Historical offline-reset evidence does not certify this new path.
