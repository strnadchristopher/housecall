# Local Shared VM runtime fixture

The shipping launcher now serializes disk operations with an exclusive lock held for QEMU's lifetime, records the supplied base image's SHA-512 on first boot, verifies that checksum on later boots, and rejects symlinked disk paths. A read-only mount for the base disk is recommended. `reset-overlay.sh --confirm-reset-to-base` takes the same lock, checks the recorded base checksum, creates and checks a new qcow2 overlay, syncs it, and atomically replaces the persistent overlay. Reset refuses to proceed while the launcher is running. The VM remains stopped after reset; restart is explicit. This local operator command removes all changes in the overlay. It is not yet an in-app operation.

The launcher supervises QEMU and forwards container termination while keeping the disk lock. `VM_SERIAL_CONSOLE=1` enables an optional local Unix serial console at `/control/serial.sock`; no TCP listener is created. VNC and QMP remain Unix-only. Control directory permissions and its group are an administrative trust boundary: anyone who can open QMP can control the guest. Do not mount these sockets into an untrusted container or expose a raw proxy.

The local `infra/vm/qmp.py` helper bounds replies to64 KiB, correlates response IDs, limits asynchronous events, and permits only small paired key press/release batches. It captures a framebuffer only to the fixed `/control/frame.ppm` path. This is a trusted local administration helper, not the missing authenticated browser input gateway. The activity domain's controller lease is not wired to it. An eventual gateway must recheck session, room, active voice membership, current lease and generation for every input event, serialize handoff against queued input, and release held keys/buttons when a lease ends.

## Reproducing the bounded fixture

Prerequisites: local Docker available through `sudo -n docker`, `/dev/kvm`, existing images `chriscord-vm:fixture` and `chriscord-sprint-vpn-fixture:local`, and the pinned Gluetun image used by the existing namespace tests. The fixture uses a private internal bridge, synthetic ephemeral WireGuard keys and local HTTP/DNS canaries. It never joins an existing VPN container, calls Shiva, or sends guest traffic onto the public internet. The root disk stays under ignored `.runtime/vm-guest/`.

```
python3 scripts/test-vm-guest.py --download
python3 infra/vm/tests/test_qmp.py
python3 scripts/test-vm-guest.py
```

The download is pinned to official [Debian 12 nocloud build 20261026-2643](https://cloud.debian.org/images/cloud/bookworm/20261026-2643/) and this SHA-512:

```
3b7c3342105085c60097147c7f7491e761c115170213ba7d9c87685e32d234bdafe0ddf8d6fd6600a6a837c761fa229ce8b9fe2086d1235f8eebeb778d05b977
```

The fetched qcow2 is 421,527,552 bytes. The cloud image has a root console suitable only for an isolated test; it is not a prepared private browsing desktop. Keep its console private. The fixture uses 768 MiB guest RAM, one vCPU and a 1152 MiB container limit. It reuses cached images and installs no guest packages. Allow 800 MiB total disk for the base, overlay and evidence, with at least 1.2 GiB free before execution. It deletes only its own containers, network, keys and temporary overlay on exit, retaining the verified immutable base. No broad Docker prune or unrelated cleanup is performed.

The fixture aims to verify actual guest boot, QMP keyboard input reaching the guest, one captured console frame, persistent files across VM restart, guest-origin HTTP/DNS through the tunnel, direct subnet/host-loopback denial, tunnel-down and Gluetun-stop denial, recovery, and offline overlay reset preserving the base checksum. Guest IPv6 has no default route because QEMU IPv6 networking is disabled; this is not proof of external IPv6 packet filtering. Existing positive-control IPv6 UID tests remain separate. The result JSON is the authority on which checks completed; a planned assertion is not passing evidence.

## Remaining product integration

This slice does not implement a browser desktop, WebRTC video/audio capture, a service publisher into the SFU, browser input transport, or an authenticated reset API. The app does not mount the VM control volume, and no app endpoint accepts QMP commands. QEMU's virtual sound card alone does not capture audio. A later bridge needs a concrete audio backend and an encoder; the current SFU routes encoded WebRTC media and does not encode a guest framebuffer. QEMU documents [D-Bus display/audio listeners](https://www.qemu.org/docs/master/interop/dbus-display.html) and [QMP input events](https://www.qemu.org/docs/master/interop/qemu-qmp-ref.html#command-input-send-event); these describe possible bridge inputs, not implemented Chriscord support. The Unix-only VNC boundary follows [QEMU's VNC security guidance](https://www.qemu.org/docs/master/system/vnc-security.html).

Initial runtime attempt failed before console connection because the generated host Unix-socket path exceeded the kernel limit; the fixture now uses a shorter run directory. The second full attempt booted Debian and proved QMP status plus live-reset rejection, but its keyboard-created marker was absent. That input approach was stopped after these two attempts. `--scenario network-persistence` explicitly skips the blocked input assertion and exercises the independent guest network and persistence path. The default `full` scenario still retains the input acceptance gate. No input success is inferred from QMP command acceptance.

## Executed evidence

`evidence/vm-guest-network-persistence.log` and `evidence/vm-guest-network-persistence-results.json` record **41 passing checks and one explicitly skipped input gate**. Four actual Debian guest boots completed. The guest reached the HTTP/DNS canaries through WireGuard, lost access when the tunnel or Gluetun stopped, and regained it after recovery. A working direct-subnet canary was inaccessible from the protected guest. Persistent marker files survived VM and VPN-container restarts; the explicit offline reset removed them, preserved the base SHA-512, and produced another bootable guest with working VPN access. The final overlay was 7,471,104 bytes before cleanup. All fixture containers/network and the temporary overlay were removed; the verified base remains cached.

The original QMP input receipt remains a failure, not a passing skipped test; the later paced-input fix is verified separately below. `evidence/vm-guest-attempt2.log` records that blocker. `evidence/vm-qmp-tests.log` records three passing synthetic parser/input-shape tests; these do not establish guest input delivery. `evidence/vm-guest-console.png` is a lossless format conversion of the captured PPM framebuffer and visibly shows Debian's tty1 login. It proves capture, not interactive desktop operation.

The independent network scenario's first attempt received the correct A record but `host` additionally queried AAAA/MX, which the local DNS canary refused. That run is preserved in `vm-guest-network-persistence-attempt1.log`; the passing run explicitly requests the fixture's A-record contract. Loopback HTTP failures have no HTTP positive control here and are labeled observations, not independent filtering proof. IPv6 has no guest default route; external IPv6 VPN routing/filtering acceptance remains open.

## Keyboard FIFO investigation

The failed input helper sent a whole 22-character shell command as 44 press/release events in one synchronous QMP request. [QEMU 7.2's PS/2 implementation](https://github.com/qemu/qemu/blob/v7.2.0/hw/input/ps2.c#L80) has a 16-byte keyboard queue; its [queue operation](https://github.com/qemu/qemu/blob/v7.2.0/hw/input/ps2.c#L186) silently discards events when full. [QMP input dispatch](https://github.com/qemu/qemu/blob/v7.2.0/ui/input.c#L152) sends the supplied event list synchronously. This is a concrete loss mechanism consistent with the absent guest marker, despite successful QMP replies. The captured tty1 login confirms that a guest console exists.

The changed helper retains its 64-key request bound but sends one paired press/release per QMP round trip, with at least 20 ms between pairs. A synthetic regression verifies the per-message event count and pacing. `python3 scripts/test-vm-guest.py --scenario input` isolates one actual guest boot and marker/screenshot validation, without repeating the completed network matrix. Its receipt, when present, determines whether this changed approach reaches the guest; earlier failure evidence remains preserved.

The targeted paced-input run passed all six checks (`evidence/vm-guest-input.log`, `evidence/vm-guest-input-results.json`). QMP keyboard events logged in on tty1 and typed the command that created `/root/qmp-marker`; the independent serial console verified that file exists. `evidence/vm-guest-input-console.png` shows the resulting guest root prompt and command. This confirms guest keyboard delivery after pacing, not just successful QMP replies. All owned resources were cleaned. Earlier failed receipts remain intact. The three paced QMP regression tests pass in `evidence/vm-qmp-paced-tests.log`. Pointer delivery, app lease enforcement, shared WebRTC capture/audio, and the in-app reset flow still need implementation.
