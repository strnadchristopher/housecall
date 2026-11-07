# Acceptance matrix

Only evidence with a successful terminal result establishes a pass. Provisional logs can include failed earlier runs. PROGRESS.md is the current receipt.

| Requirement | Automated evidence source | Remaining acceptance |
| --- | --- | --- |
| Private invite-only setup | server security tests, browser invite flow | passkey-first under 60s on actual mobile |
| Passkeys + fallback | WebAuthn tests and virtual authenticator browser test | native authenticators, recovery hardening |
| Device sessions/revocation | API cross-user and revoked token tests | non-exportable request signing/native secure storage |
| Every-route authorization | automatic91-pair route inventory + module access tests | cross-user behavior tests for new features |
| CSP/no trackers | headers assertion, source dependency audit | rendered app network review on each native platform |
| Chat + DMs | 3-user Playwright, API security tests | native/browser parity; complete thread subscription UX |
| Unsend | server purge/client tombstones;9APNs/FCM outbox fixture tests incl in-flight-unsend race, retries/restart | native token registration/OS receipt and retraction under background/offline constraints |
| Large resumable media | media property, >2GiB process-interrupted fixture and real browser2GiB aborted-PATCH/resume39.62s | real scanner limit handling (large file remains quarantined), disk-full |
| Media transcode/thumb/stream | actual FFmpeg fMP4/JPEG + authenticated browser MSE playback before full buffering, access/unsend checks | seek outside retained buffer, native WebView decoding, seek-dependent source formats |
| Search/pin/react/edit/typing/read | API/client tests | full browser interactions per platform |
| Giphy | fixed-origin parser/property tests | keyed fixture/live picker fetch and playback |
| Markdown/embeds | inert markdown AST + public-IP DNS-pinned text previews/SSRF tests | Opus safe semantic renderer; remote image previews |
| Voice/video/screenshare | 3-browser Opus/VP8 + screen replacement; synthetic localhost median48ms/p95 71ms | physical LAN glass-to-glass; optimized load passes10; thirty-peer/sustained load unverified |
| Plex activity | 3-browser real synthetic HLS decode, browse/play/pause/seek with <0.5s drift | live Plex transcoder/library/subtitles and native media support |
| DJ activity | encrypted local intro+song, route authorization,3-browser decode/sync/skip fixtures | live matched providers, supplied voice reference, progressive start |
| Shared VM | booted Debian12, paced QMP input, guest HTTP/DNS VPN-only and tunnel/container failure checks, persistent disk/offline reset | app WebRTC capture/audio/viewer and controller-lease integration; external IPv6 guest baseline |
| Gimme | durable worker/idempotency/restart fixtures + 3-user dry-run channel status | live provider compatibility; no production calls in sprint |
| Reports | realClamAV3.9s browser consent/upload/owner-only download/resolve + API authorization | native screenshot/log capture consent, Opus presentation |
| Compose | built image a1d4a167 and completed18-check isolated runtime, real scans + multiGiB browser | final source image after remaining features |
| Desktop | patched Tauri Linux release + checksum, Windows/macOS CI | observed Windows/macOS CI success and real OS media permissions |
| Android | ARM64 APK/signature + installed WebView invite/chat/unsend/revoke E2E | quiet core emulator rerun passes with no ANR; native passkeys/push/media, physical device; Romeo unavailable |
| iOS | shared Tauri crate/mobile entry + Maya plan | generated Xcode project and build verification |
| Security dependencies | cargo audit/deny and npm audit | recheck final lockfiles, no blanket advisory suppression |
| UI contract/themes | UI_CONTRACT_READY and screen/flow contract | Opus presentation/theme implementation and Noah merge |

## Real-device measurement protocol

Glass-to-glass: film a high-resolution clock and LED transition in a camera feed while filming receiving display with a separate high-frame-rate reference camera. Record source/render timestamps, LAN topology, resolution/fps, codec, loss, NACK/PLI, CPU/RSS and p50/p95/p99 over at least 100 transitions. WebRTC RTT or scripted timeout is not glass-to-glass latency. Browser synthetic media establishes routing only.

30-peer load: independent clients with audio+video, not 30 HTTP connections or 30 silent peer objects. Observe forwarding bitrate, CPU/RSS/VRAM, frame rate, audio quality, jitter and packet loss for a sustained run; include joins/leaves and screen share. Keep no more than two heavy builds concurrent while measuring, ideally none.

## Maya iOS plan

Use pinned sprint commit archive without .env/vendor-ref/evidence credentials. Generate Tauri iOS project on Maya with matching locked CLI, run `tauri ios build --debug` for simulator first; signing/device install requires later explicit step. Exercise invited join, platform passkey create/login/cancel, device revoke while foreground/background, camera/mic permission denial and restoration, audio route switching, background/foreground websocket recovery, APNs sandbox delivered-notification removal, uploads after suspension, activity resync and screenshot/log consent. Record device OS/model/build SHA and screenshots. No claim of buildability until Xcode compiles generated project.
