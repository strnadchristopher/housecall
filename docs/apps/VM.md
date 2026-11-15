# Shared browser / VM

This is the consolidated operator entry point for [VM policy](../VM.md), [guest/runtime evidence](../VM-RUNTIME.md) and [private media](../VM-MEDIA.md). Those documents retain historical receipts and limitations; later sections describing the supervisor, authenticated input and media overlay supersede their earlier “not implemented” paragraphs. Source wiring exists; integrated desktop/audio/reset acceptance is still pending. The easy image recipe intentionally has no VM profile.

## Prepare the source deployment

Use `compose.yaml` plus `compose.vm-media.yaml` from the same revision. Requirements: Linux KVM at `/dev/kvm`, nftables support, an existing healthy Gluetun container with `tun0` or `wg0`, a prepared Debian desktop/browser guest disk, and space for base/overlay/backups **plus the supervisor's 12 GiB free reserve**. Reserve UID 47191 across the VPN namespace. Determine the KVM group without changing host membership or device permissions:

```sh
stat -c '%g' /dev/kvm
```

Set that numeric value as `VM_KVM_GID` in the private `.env`. Set `GLUETUN_CONTAINER`, `VM_TUNNEL_INTERFACE`, `VM_MEMORY_MB` and `VM_CPUS`, and choose `HOUSECALL_VM_CHANNEL_ID` from an actual authorized channel ID. Configure a numeric reachable `SFU_PUBLIC_IP` and `SFU_PORT`. The media overlay supplies fixed private app QMP, supervisor and publisher socket paths; do not substitute public TCP listeners.

Build the infrastructure images on a suitably resourced host (not executed in this lane):

```sh
docker compose -f compose.yaml -f compose.vm-media.yaml --profile vm build
```

The image build does not create a browser guest OS. For the production Debian browser recipe, run `bash scripts/prepare-vm-browser.sh PINNED_BASE NEW_OUTPUT` on a Docker/KVM build host. It verifies the Debian cloud SHA-512 from VM-RUNTIME.md, expands the root disk to 16 GiB, installs Xorg/LightDM/Openbox/Firefox ESR and guest PulseAudio, and applies `infra/vm/desktop/browser-guest.sh`. Its `browser` account autologins only into the graphical session; both account passwords are locked, root gettys are masked, SSH server is removed, cloud-init is disabled, IPv6 is disabled and DNS uses literal upstream resolvers. Firefox opens a local neutral search page, not a signed-in account. Debian package repositories are live security repositories rather than an immutable snapshot: preserve the final output SHA-512 and build logs; source pinning alone does not make later builds byte-identical. No arbitrary guest download is part of first boot. The separate `scripts/prepare-vm-desktop.py` remains a **synthetic test desktop only**, not the production browser recipe.

Before launching QEMU, start the initializers (after configuring and starting Gluetun):

```sh
docker compose -f compose.yaml -f compose.vm-media.yaml --profile vm up -d vm-policy
docker compose -f compose.yaml -f compose.vm-media.yaml --profile vm run --rm vm-media-init
```

Provision the actual Compose project's `vm-disk` named volume with the verified base as `/vm/base.qcow2`, readable by UID/GID 47191, using your host's protected volume administration tooling. Compose's project name defaults to `housecall`, so normally the volume is `housecall_vm-disk`; verify it before copying. Do not replace a base or overlay from an existing deployment. The initializer only owns volume roots; it does not recursively fix a supplied image. Keep the base immutable. On first boot the launcher records `base.sha512`; later boots and resets verify it. Persistent changes go in `session.qcow2` and survive restarts.

Start explicitly:

```sh
docker compose -f compose.yaml -f compose.vm-media.yaml --profile vm up -d
```

## Keep the fail-closed boundary

QEMU shares only the selected Gluetun network namespace. The separate `housecall_vm_47191` nft output table at priority -200 permits that UID's plaintext IPv4 traffic only through the selected tunnel interface, drops all other egress including IPv6/loopback, and survives Gluetun iptables flushes. For **kernel WireGuard**, encrypted outer packets inherit the original socket UID: the installer discovers its nonzero privileged fwmark and single numeric IPv4 peer endpoint, then permits only matching marked UDP to that endpoint. QEMU has neither NET_ADMIN nor NET_RAW and cannot set SO_MARK. Unmarked direct traffic remains denied. Invalid discovery aborts installation without replacing the old table; a peer endpoint/mark change fails closed until policy is reinstalled. OpenVPN has no such exception. Gluetun's ordinary firewall alone permits its Docker subnet and is insufficient. QEMU has no fallback bridge or host network. Its resolver file must point at a literal upstream/VPN resolver, never Docker's privileged loopback proxy.

Compose waits for the policy before QEMU. If Gluetun is recreated, stop and recreate **both** policy and VM services for the new namespace; do not restart QEMU into a namespace without its verified policy. Do not flush namespace nft tables while the guest runs. Privileged host changes can defeat the boundary; a healthcheck cannot make them race-free.

The media publisher has its **own** restricted network namespace, allowing only the numeric SFU UDP endpoint. It must never join Gluetun. The dedicated audio daemon has no network and exposes only a private null sink/monitor. No host sound device, desktop buses, credentials, Docker socket or host networking belongs in these services. Publisher mounts include display/audio/signaling only, excluding disks and QMP. The overlay provisions display/audio directories mode 02770 and app-owned signaling mode 02750; Unix peer credentials restrict source admission. VNC/QMP remain private Unix sockets.

## Input, capture and reset

Join the chosen voice channel and start the VM activity. Only its current authorized host/controller may send bounded input; membership, connected voice, lease, generation and revision are rechecked. Owner capture must be explicitly armed; departure, stop or missing heartbeat revokes it. A configured/armed source is not proof of visible desktop motion or audible guest audio.

The in-app destructive reset requires its explicit discard confirmation, a current controller lease, a connected initiating voice device and a unique operation. The app uses the private supervisor; it does not issue arbitrary QMP/process commands. The supervisor holds the common disk lock, stops/reaps its own QEMU, checks the trusted base, creates/checks an offline candidate, revalidates authority, journals and atomically replaces the overlay. Failed candidate startup rolls back; an unknown response does not imply rollback. On reload/reconnect use **Check reset** to discover the recorded outcome before considering another operation. A new login can inspect its initiating user's outcome but cannot replay the destructive request. Reset disarms media; rearm explicitly after success.

For offline operator reset, stop QEMU first; never reset a running overlay:

```sh
docker compose -f compose.yaml -f compose.vm-media.yaml --profile vm stop shared-vm
docker compose -f compose.yaml -f compose.vm-media.yaml --profile vm run --rm --no-deps --entrypoint /usr/local/bin/reset-vm-overlay shared-vm --confirm-reset-to-base
```

The helper installed by `infra/vm/Dockerfile` takes the same disk lock and preserves the base checksum. It discards all overlay changes and leaves the guest stopped. Back up deliberately before resetting, then restart with the full overlay command. Do not delete the volume or its reset journal as a recovery shortcut.

## After bring-up

Record the final guest base SHA-512 privately with the deployment notes. Once the stack is up, ordinary `docker compose up -d` includes the VM services when the private `.env` lists `compose.vm-media.yaml` in `COMPOSE_FILE` and sets `COMPOSE_PROFILES=vm`. Production streaming is never armed by the operator: the owner joins the configured voice channel, starts Shared Browser and arms capture in the app. Then verify decoded video/audio, input/handoff, late viewers and reset/rearm with real clients. Recreating Gluetun or changing its WireGuard peer requires reinstalling the policy before QEMU restarts.

## Historical evidence and runtime gates

No image, guest, VPN, media or reset command on this page was executed in this W6 pass. Historical receipts in the source docs apply only to their exact fixtures. Independent Python policy tests do not prove a booted browser or production routing.

On the parent's isolated fixtures, run the pinned guest network/persistence and paced-input tests from VM-RUNTIME.md; then prepare the desktop and run `python3 scripts/test-vm-desktop.py --desktop-receipt <receipt.json>` under its serialized resource guard. Verify three viewers, actual decoded video/audio, input/handoff, persistence/reset/reload, revocation and heartbeat loss. Repeat VPN IPv4/IPv6/DNS positive-control and tunnel/Gluetun restart tests with the new mounts. Exercise wrong Unix UID, stale generations, publisher denied egress, reset failure injection and base-checksum preservation. Physical glass-to-glass and A/V skew remain separate measurements. No claim of “ready” follows from static checks.
