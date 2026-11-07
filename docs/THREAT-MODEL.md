# Chriscord threat model

Status: implementation in progress; this is a threat model and acceptance ledger, not a security certification.

## Assets and trust boundaries

Private message content, membership, invite tokens, account credentials, sessions, encrypted attachments, push tokens, reports, third-party service credentials and VM browser sessions are sensitive. Christopher is the trusted instance administrator. Internet visitors and invited members are untrusted at API boundaries. Browser content, filenames, markdown, embed URLs, media containers, subprocess output, Plex/Gimme replies, WebRTC SDP/RTP and VM input are untrusted parsers.

Trust boundaries: HTTPS reverse proxy → Rust HTTP service; HTTP service → SQLite/media storage; client → OS credential/notification APIs; service → allowlisted integrations; WebRTC transport → SFU; VM guest → Gluetun network namespace; local TTS/yt-dlp/ffmpeg processes → untrusted media. Neither an authenticated user nor the owner may supply arbitrary filesystem paths or arbitrary proxy destinations.

## Threats, controls, required evidence

| Threat | Implemented or required control | Verification gate |
| --- | --- | --- |
| Public signup / invitation guessing | No open registration; 256-bit single-use invite secret, hash at rest, expiry, owner-only issuance, transaction redemption | reuse/expiry/race tests; route matrix |
| Bootstrap takeover | env bootstrap secret, one-time transactional setup | invalid token, repeated setup and setup race tests |
| Credential theft/bruteforce | Argon2 fallback; strong random secrets; passkey origin/RP verification required; rate limits | auth tests; real virtual-authenticator browser test still required |
| Session replay/revocation | bearer and independent device secret hashes; server expiry; device-scoped revoke | stolen bearer alone, wrong device, revoke then every protected route |
| Device compromise | Browser adapter avoids persisted session secrets; native secure-store/non-exportable request proof still required | mobile secure-storage + hardware binding not yet verified |
| Cross-channel/DM access | membership checks per route and per event recipient; IDs carry no authority | non-member read/write/edit/react/pin/search/read/typing/upload tests |
| Unsend races | durable ID-only events and deletion tombstones; purge message+notifications in transaction; client tombstone wins stale fetch | 3-user browser test, persistence/reconnect, remote push remains missing |
| XSS/trackers | React text escaping, no raw HTML; restrictive CSP, same-origin assets, no analytics; embeds unavailable | hostile markup browser test; inspect headers; future markdown sanitizer tests |
| CSRF | no ambient cookie authentication; auth headers + device secret; explicit origin CORS | cross-origin preflight/writes and allowed-origin tests |
| SSRF | arbitrary embeds disabled; integration origins configured, no redirects/credential forwarding; required URL validation | parser/address tests, DNS rebinding and redirects before enabling embeds |
| Upload traversal/tampering | UUID paths, bounded chunk requests, owner checks, AES-GCM upload+offset AAD; filename validation | media security suite, property tests, wrong key/bitflip/cross-user tests |
| Malicious uploads | quarantine until definitive scan; scanner failure/size exceed fail closed | EICAR and oversized real scanner tests pending |
| Resource exhaustion | bounded HTTP/chunk bodies, rate limits, 4 MiB chunk decrypt buffers, disk-only total cap; limited process resources | >2 GiB resume fixture, disk-full, parallel upload and load evidence |
| Parser crashes | property testing ranges/bytes/URLs/protocol, conservative schemas | cargo test proptest; fuzz corpora/panic regression |
| Host media theft | AES-GCM encrypted chunks, env-only key, private file permissions | ciphertext inspection; key backup/recovery plan |
| DB/backups leak content | trusted-server plaintext chat, private DB permissions, encrypted host backups required | operator backup policy; E2EE decision explicitly documented |
| Compromised integration | env-only credentials, redacted logging, bounded result bodies, subprocess argv not shell, fixed tool path | fixture adversarial responses, tool exit/timeouts |
| VM egress escape | dedicated existing Gluetun namespace, firewall kill-switch, no host network, no default fallback | guest IPv4/IPv6/DNS VPN-drop test pending |
| VM control theft | one expiring membership-bound lease checked every input; revoke on leave | activities state machine tests plus actual input bridge pending |
| Report data exfiltration | explicit screenshot/log consent, owner-only read, redaction before persistence | consent/access tests; attachment path pending |
| Supply-chain compromise | lockfiles, cargo audit/deny, npm audit, no unnecessary plugins | logs and CI gates; advisories reviewed without blanket ignores |

## Unresolved risks / release blockers

Passkeys, cryptographic hardware device binding, native notification delivery/retraction, encrypted attachment lifecycle tied to message unsend, role permissions, real scanner coverage of huge media, safe rich embeds, WebRTC SFU, VM guest isolation and actual platform E2E must all be verified before SPRINT_DONE. A stub, fixture adapter or green unit test cannot satisfy a real end-to-end gate. Existing cryptographic library use does not replace system review.

No service is deployed by this sprint. Keep test instances bound to loopback, use synthetic data and disposable stores, and never import production .env files. Docker profiles are deployment instructions only until runtime evidence says otherwise.

## Recovery and operations

Back up SQLite using its online backup mechanism and encrypted media together with separately protected encryption keys. Test restoration on a disposable instance. Revocation must invalidate live realtime sessions as well as future HTTP requests. Retain only non-sensitive audit metadata; never log bearer/device/invite credentials, passwords, TTS reference audio or service tokens. Configure Caddy TLS and trusted forwarding explicitly; do not trust arbitrary X-Forwarded-For values. Disk exhaustion must return a recoverable error without advancing upload offsets. Keep all external integrations disabled unless credentials and policy are intentionally configured.
