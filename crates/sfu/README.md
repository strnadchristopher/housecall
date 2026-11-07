# Chriscord WebRTC SFU

This Rust library hosts a shared UDP port and forwards encoded audio/video media between authenticated peers in the same room. `str0m` supplies ICE, DTLS, SRTP, RTP/RTCP, codecs' packetization and SCTP; Chriscord owns session authorization, room isolation, peer bounds, forwarding policy and the server integration. It does not decode/transcode media or allocate VRAM. The forwarding/renegotiation implementation derives from str0m's chat example; see NOTICE and LICENSE-STR0M-MIT.

The application constructs `Sfu::start(bind, public_ip, authorize)`. The authorization callback checks channel membership and the authenticated device session at join and every second during active transport. A removed member, expired session or revoked device therefore loses transport within one second, even without another HTTP request. There is one peer per device session, at most 30 total; joining again removes that session's former transport. Room isolation applies to forwarded tracks, media and keyframe feedback. A peer may leave only its own connection. A bounded control queue prevents unbounded HTTP join backlog.

## Browser protocol

1. Create an RTCPeerConnection with a reliable `chriscord-signaling` data channel and up to three sending media tracks (microphone, camera, screen). Do not request simulcast in this first slice.
2. Configure audio Opus `stereo=1;sprop-stereo=1;maxaveragebitrate=510000;maxplaybackrate=48000`, sender maxBitrate 510000, optional processing according to user preference. Negotiated ceilings do not guarantee constant achieved bitrate; silence and codec VBR reduce it.
3. Create an offer, set local description and wait for ICE gathering to finish. POST the raw `{type:"offer",sdp}` description to authenticated `/api/channels/{id}/voice/join`, with the usual bearer and device headers. The response is `{peer_id,answer}`. Apply `answer` as remote description.
4. The server sends additional raw SDP offers over the data channel as other peers' tracks appear/disappear. Serialize negotiation, apply the offer, create/set an answer and send the raw answer back on that channel. Handle `ontrack` with normal media elements. Client-initiated renegotiation must not race a server offer: this slice fails closed on offer glare. Prefer `replaceTrack` to switch camera/screen when possible.
5. `GET /api/channels/{id}/voice/stats` returns `{peers:[{peer_id,user_id,connected,received_frames,forwarded_frames,forwarded_bytes}]}` for connected devices in that room. These are server encoded-media counters, not decoded browser frames and not latency. DELETE `/api/channels/{id}/voice/{peer_id}` leaves.

Server configuration uses both `SFU_BIND` (e.g. `0.0.0.0:50000`) and `SFU_PUBLIC_IP` (a server LAN/Tailscale IP or `127.0.0.1` for local Chromium tests). Both absent disables voice; providing only one fails startup. Publish that UDP port directly; Caddy's HTTP reverse proxy does not forward UDP. NAT TURN fallback and multiple advertised candidates are not supplied by this slice. For off-LAN use a reachable Tailscale address until TURN support is implemented. No third-party STUN/TURN services are used by default. OpenSSL runtime libraries are required by the chosen str0m crypto backend.

## Verification scope

`cargo test --manifest-path crates/sfu/Cargo.toml -j 1 -- --nocapture` includes a real localhost UDP test: three str0m peers exchange synthetic encoded Opus frames through ICE/DTLS/SRTP, a fourth peer in a separate room receives none, and a revoked session disappears. The test uses actual crypto/transport; it does not decode the synthetic payload or establish browser playback/physical glass-to-glass latency. It also property-tests SDP JSON parsing.

See `evidence/activities-sfu-tests.log` for executed results, and root/client-owned browser evidence for actual fake-device browser playback. Thirty-client load and physical LAN camera/display measurements must be assessed independently. Do not claim the <150 ms target based on RTT, encoded packet counters or the synthetic Opus test.

Current limits: CPU scaling of frame-based forwarding at 30 cameras is unmeasured; all active encoded frames are forwarded without adaptive simulcast; Opus ceiling requires browser SDP negotiation; screen track setup is limited by glare handling; no TURN; and activity playback providers remain separate from this transport. Configured SFU activity routes now require a connected session and derive their roster from connected peers.
