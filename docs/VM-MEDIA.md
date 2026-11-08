# Private shared-VM media publisher

The candidate in `infra/vm/media/` captures a QEMU Unix VNC display and a dedicated PulseAudio monitor, encodes VP8 and Opus once, and publishes them through the existing Rust SFU. It contains actual capture, SDP negotiation, private signaling, firewall and process-watchdog source. It is **not yet accepted as working VM playback**: no container image, GStreamer pipeline, guest audio, or browser playback was executed during this implementation slice. Local `GstWebRTC` GI metadata is missing. The tests below verify policy and watchdog behavior only.

## Boundaries and deployment wiring

Keep QEMU UID 47191 in its existing Gluetun namespace with the existing VPN-only firewall. The publisher must never share that namespace: allowing it to reach the SFU there would weaken the guest's network boundary. Do not give either service host networking, host PulseAudio/PipeWire sockets, `/dev/snd`, desktop session buses, a Docker socket, or host credentials.

Run three distinct containers/namespaces:

1. Existing QEMU: KVM and persistent guest disk, VPN-only networking. Move the VNC socket into a **display-only directory**, `/display/display.sock`, shared with the publisher. Keep QMP, serial and guest disk outside that mount. Replacing the socket in a shared directory survives QEMU restarts; a bind mount of a single socket inode does not.
2. `Dockerfile.audio`: UID 47193, GID 47191, `network_mode: none`, no hardware devices. Its explicit Pulse configuration creates only `vm_output` and `vm_output.monitor`, plus `/audio/native`. It disables dynamic module loading, client-requested exit, SHM/memfd, discovery and default startup scripts. The daemon accepts only the dedicated `vmmedia` group; no persistent cookie. A guest accessing this daemon cannot load a tunnel or reach a host microphone. This daemon's lack of networking is a required security boundary, not an optional optimization.
3. `Dockerfile`: isolated publisher network namespace, no exposed ports. Root startup installs an nftables default-deny policy, allowing loopback and UDP to/from only the configured numeric SFU candidate IP/port. It then irreversibly drops to UID 47192/GID 47191, clears capabilities and sets no-new-privileges. The runtime opens an ephemeral **127.0.0.1-only, single-connection** RFB relay to the private Unix display socket because GStreamer's `rfbsrc` accepts TCP, not Unix sockets. It does not listen on an external interface. The publisher sees only display, audio and signaling sockets.

`compose.media.example.yaml` provides the service hardening and mount shape for root-compose integration. It is a reference fragment, not a second deploy command. Provision root-controlled runtime directories before starting containers: `vm-display` owned by QEMU UID 47191/GID 47191, `vm-audio` by UID 47193/GID 47191, and `vm-signaling` by the app UID/GID 47191; display/audio mode02770; signaling mode02750 (only app owner may write). QEMU umask 0007. App signaling socket mode 0660. Never mount the entire existing `/control` directory into the publisher. The app must have group 47191 and listen on the shared signaling socket. The source process additionally verifies the app's exact UID through Linux `SO_PEERCRED`.

Replace the existing QEMU `hda-duplex` device with output-only audio and configure the dedicated sink explicitly:

```text
-device intel-hda
-audiodev pa,id=vm_audio,server=unix:/audio/native,out.name=vm_output,out.frequency=48000,out.channels=2,out.latency=10000
-device hda-output,audiodev=vm_audio
-vnc unix:/display/display.sock
```

The QEMU container needs its Pulse backend library and the `/audio` mount; its guest network policy stays unchanged. Verify the sink actually receives the guest output: QEMU warns that some invalid audio options can silently leave audio unavailable. A desktop/browser guest image and a selected guest output device are still required; the existing serial-only fixture does not prove browser playback.

Configuration: `VM_MEDIA_APP_UID` and `VM_MEDIA_SFU_IP` are required. `VM_MEDIA_SFU_PORT` defaults to 50000; `VM_MEDIA_APP_SOCKET`, `VM_MEDIA_VNC_SOCKET` and `VM_MEDIA_PULSE_SOCKET` default to `/signaling/publisher.sock`, `/display/display.sock` and `/audio/native`. The SFU address must equal its advertised host candidate and be reachable from the publisher namespace, including any container NAT/hairpin routing. No DNS, STUN, TURN, external discovery, bearer tokens or browser session credentials are used. IPv6 routing additionally needs correct namespace neighbor discovery; the initial supported deployment uses a numeric IPv4 endpoint.

## Server integration contract

The bridge is HTTP/1.1 over a private Unix socket, accepting **only publisher UID 47192** by `SO_PEERCRED`. It must never be mounted into a public HTTP router. Requests/responses are JSON with a fixed `Content-Length`; no transfer encoding. The client limits SDP to 64 KiB, response body to 128 KiB, headers to 8 KiB and the entire HTTP exchange to 750 ms, including slow/trickled responses.

| Request | Body | Success response |
| --- | --- | --- |
| GET `/v1/vm-publisher/status` | none | `{"armed":true}` or `{"armed":false}` |
| POST `/v1/vm-publisher/join` | `{"generation":"UUID","offer":{"type":"offer","sdp":"..."}}` | `{"generation":"same UUID","peer_id":123,"answer":{"type":"answer","sdp":"..."}}` |
| POST `/v1/vm-publisher/heartbeat` | `{"generation":"UUID","peer_id":123}` | `{"active":true}` or `{"active":false}` |
| POST `/v1/vm-publisher/leave` | `{"generation":"UUID","peer_id":123}` | `{"left":true}` |

The `leave` peer ID can be `null` when join's response was lost or the worker died before handing its ID to the watchdog. Revoke only the matching generation; never let a stale leave revoke a newer owner/source. The server generates the synthetic SFU session, binds the publisher-generated UUID to the currently armed owner/session/activity, and rejects duplicate/replaced sources. The synthetic session must differ from the owner's browser voice session. Use a publish-only SFU peer: subscribe it to no user tracks, filter it out of the controller/member roster, and reserve one source slot beyond the human room cap. The data channel remains `chriscord-signaling`.

Only the authenticated VM owner can arm capture. Revalidate owner session, membership, voice presence, current host/activity and revocation on join and every heartbeat. Stop/revoke/owner departure invalidates the grant and disarms capture. The server independently expires a source after three seconds without a heartbeat. Leave disarms the matching generation so failures after join require a fresh owner action.

Before arming, the supervisor polls status once a second and never imports GI, opens VNC, records audio or starts an encoder. Each attempt gets a fresh UUID. A separate child owns all capture/encode/ICE work, while the supervisor checks authorization every 500 ms. A failed/inactive heartbeat ends capture independently of a stalled GI thread: the configured request deadline, polling delay and forced process teardown total at most approximately 1.55 seconds plus OS scheduling delay. Initial setup has a 15-second ceiling. It checks the armed gate during setup, before join creates a peer. This is not a hard realtime guarantee; measure it under load. The supervisor sends leave after capture has stopped and never keeps a stale worker alive while reconnecting.

## Media and renegotiation

The static graph is view-only RFB → raw video → 1280×720, at most 30 fps → VP8 (2.5 Mbps, two encoder threads, bounded dropping queues); private `vm_output.monitor` → 48 kHz stereo → Opus 510 kbps/fullband, 10 ms frames. These are initial resource settings, not a measured latency claim. No decoding, local display, microphone source, playback sink or recording file is created. An unexpected received RTP pad stops the publisher.

The publisher creates exactly one ordered signaling data channel and two send-only tracks. It waits for ICE gathering before the initial offer, then applies the private bridge's answer. Remote SFU candidates must all be UDP host candidates at the configured numeric address/port; DNS, relay, TCP and other addresses are rejected before applying SDP. The nftables boundary remains necessary because SDP validation alone is not a network sandbox. Advertised trickle support is harmless; no out-of-band trickle message is accepted or sent.

Later SFU offers arrive as `{"type":"offer","sdp":"..."}` on the data channel and receive direct `{"type":"answer","sdp":"..."}` replies after local gathering. Overlapping/oversized/invalid negotiations, pipeline errors, closed/failed/disconnected connections and signaling backpressure stop capture. There is no transcript logging: worker stderr is suppressed because native errors can include SDP/endpoints. Diagnostics must use consented synthetic fixtures rather than enable verbose logging during a private session.

## Checks and remaining acceptance

Run the small independent policy suite without GStreamer:

```sh
python3 -m unittest discover -s infra/vm/media -p 'test_*.py' -v
python3 -m py_compile infra/vm/media/policy.py infra/vm/media/publisher.py infra/vm/media/relay.py infra/vm/media/network.py
git diff --check -- infra/vm/media docs/VM-MEDIA.md
```

Eleven tests passed during authoring: candidate pinning and malformed SDP; wrong/stale source identity; real Unix HTTP peer credentials and malformed/oversized/truncated responses; an absolute slow-trickle deadline; firewall shape; no worker while unarmed; mocked revocation stops capture before leave; a bidirectional single-client loopback-to-Unix relay; and forced termination of an uncooperative real child. These do **not** exercise GStreamer, QEMU, PulseAudio, or the SFU.

After the shared build hold is released, build the images from the candidate source (not executed here):

```sh
docker build -f infra/vm/media/Dockerfile -t chriscord-vm-publisher:local infra/vm/media
docker build -f infra/vm/media/Dockerfile.audio -t chriscord-vm-audio:local infra/vm/media
docker run --rm --network none --entrypoint /usr/bin/python3 chriscord-vm-publisher:local -c 'import gi; gi.require_version("Gst", "1.0"); gi.require_version("GstWebRTC", "1.0"); from gi.repository import Gst; Gst.init(None); assert all(Gst.ElementFactory.find(n) for n in ["rfbsrc","pulsesrc","webrtcbin","vp8enc","opusenc","rtpvp8pay","rtpopuspay"])'
```

Root integration must then run an isolated desktop-guest fixture against the actual bridge/SFU and three viewers. Prove visible timestamped desktop motion **and audible guest audio**, codec/bitrate stats, one encode for all viewers, no self-return audio, late join/leave and renegotiation, owner handoff/stop/logout/revocation, kill-on-heartbeat-loss with timestamps, restart/rearm, and persistence/reset. Record actual glass-to-glass and A/V skew under intended CPU limits; the 150 ms target remains unmeasured for this source.

Repeat guest VPN-only/kill-switch tests with the new Unix mounts present. Probe publisher UDP to the allowed SFU and denied other IP/port/TCP/DNS; verify no external RFB listener; verify the audio daemon has no network interfaces beyond its isolated loopback, no hardware sources and cannot load a module. Check wrong Unix UID, forged/stale generation, missing heartbeat, late join response, and concurrent arm/leave races. Until these pass, the original usable shared-VM video/audio gate remains open.

## Primary references

- [GStreamer rfbsrc](https://gstreamer.freedesktop.org/documentation/rfbsrc/index.html): TCP endpoint and view-only capture controls.
- [GStreamer pulsesrc](https://gstreamer.freedesktop.org/documentation/pulseaudio/pulsesrc.html): explicit server and device selection.
- [GStreamer webrtcbin](https://gstreamer.freedesktop.org/documentation/webrtc/index.html): transceivers, SDP promises and data channels.
- [GStreamer maintained Python example](https://gitlab.freedesktop.org/gstreamer/gstreamer/-/blob/main/subprojects/gst-examples/webrtc/sendrecv/gst/webrtc_sendrecv.py): GI API reference; this publisher omits its external discovery/signaling and receiver sinks.
- [PulseAudio modules](https://www.freedesktop.org/wiki/Software/PulseAudio/Documentation/User/Modules/) and [daemon options](https://www.freedesktop.org/wiki/Software/PulseAudio/Documentation/User/Daemon/): private Unix protocol, null-sink monitor and loading restrictions.
- [PulseAudio access control](https://www.freedesktop.org/wiki/Software/PulseAudio/Documentation/Developer/AccessControl/): trusted-client implications behind the dedicated networkless daemon.
- [QEMU audio options](https://www.qemu.org/docs/master/system/invocation.html): Pulse server, sink and latency configuration.

## Actual desktop acceptance fixture source

`scripts/prepare-vm-desktop.py` uses only the existing checksum-pinned Debian base, copies it into a new owned fixture directory and uses a disposable libguestfs appliance to install a synthetic X desktop. No production VM is opened. `infra/vm/desktop/fixture.py` emits a changing visible clock/barcode, a real440Hz stereo ALSA tone and a keyboard marker. The image-preparation receipt binds the derived base and fixture source. This preparation downloads Debian packages and must run inside the parent's serialized resource guard.

`scripts/test-vm-desktop.py --desktop-receipt <receipt.json>` starts isolated owned VPN, guest, networkless audio, publisher, server/SFU and browser fixtures. It captures source hashes before/after, image IDs and unique receipts; it refuses candidate source changes and enforces the12GiB floor while browsers run. The parent resource guard must cover setup/cleanup too. `client/tests/vm-desktop-acceptance.mjs` imports the actual `Api` and `VoiceSession` modules, joins three users, checks late renegotiation, decoded VP8 frames and increasing decoded Opus energy/samples, one source and no returned source media, real input/handoff, guest persistence/reset and replay, explicit media rearm, owner departure, heartbeat loss and the guest kill-switch with all new mounts. All recorded media is synthetic. Only owned resources are removed after receipts.

These files are authored and syntax-checked, not runtime-accepted. Required follow-up includes source-bound image builds, executing this harness, wrong-UID/private-bridge and publisher-egress runtime probes, browser rendered reset/reload checks, reset failure injection with actual QEMU, source revoke/logout races, and external-clock physical glass-to-glass/A/V-skew measurement. Decoded frames/energy and an on-screen timestamp are not substitutes for physical speaker/camera measurements. No generated private media or live VPN/provider is involved.
