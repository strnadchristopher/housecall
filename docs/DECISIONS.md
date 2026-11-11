# Engineering decisions

## Rust, SQLite, shared client

Axum/Tokio and SQLite WAL fit a private 5–30 person instance with one self-hosted server. SQLite keeps setup, backup and recovery simpler than a separate database service. Blocking database work must remain short and bounded; expensive hashing, disk operations and subprocesses belong off the async reactor. Shared React/TypeScript state and transport with Tauri 2 are the target across desktop/mobile; native WebAuthn, media and background notification behavior still require platform verification. Presence of a project file is not proof of a platform build.

## DM end-to-end encryption

This iteration does **not** claim DM E2EE. The trusted, owner-administered server can read messages. This enables server search, moderation, previews and simple multi-device recovery, but a server compromise exposes chat text. TLS and encrypted media at rest are not E2EE. For a group that expects privacy from the administrator or host, E2EE is necessary; introduce OpenMLS only with verified group membership changes, device verification, replay protection, key backup and recovery, attachment-key distribution, and independent security review. Do not invent a custom group cipher or silently advertise “end-to-end encrypted.” Revisit before inviting anyone whose trust model excludes the server owner. See [OpenMLS](https://openmls.tech/).

## Sessions and passkeys

Passkeys are required for sprint acceptance. A random opaque session plus a separately generated device secret is the initial transport. Both hashes are stored server-side. This prevents use of a stolen bearer alone but is **not hardware proof of possession**; browser storage compromise can steal both. A finished device-binding design needs a non-exportable device key and signed per-request challenges or native secure-store protection, plus passkey reauthentication for sensitive operations. Fallback passwords use Argon2 and rate limits; they do not replace the passkey acceptance gate.

## Unsend and operating-system push limits

Delete server content and membership-scoped durable notifications transactionally, send deletion tombstones, close desktop notification handles and reconcile on reconnect. Do not include private message text in remote push payloads. iOS can remove delivered notifications when the app executes, but background delivery is not guaranteed; an offline OS cannot be remotely forced to erase a displayed alert. APNs collapse IDs replace queued deliveries; they are not a remote erase API. Therefore unconditional “delete everywhere including offline delivered pushes” is physically unenforceable. The product must accurately expose pending retractions. [Apple background delivery](https://developer.apple.com/documentation/usernotifications/pushing-background-updates-to-your-app), [notification management](https://developer.apple.com/documentation/usernotifications/unusernotificationcenter).

## Encrypted uploads and scanning

Random per-chunk AES-256-GCM nonces; authenticated upload ID, offset and plaintext length; owner/membership authorization; atomic durable manifests; bounded 4 MiB request chunks and streaming read ranges. No product cap on total file length. The media key is env-only and must be backed up securely; losing it loses media. Filenames are display metadata, never filesystem paths. Encryption protects disk contents, not a compromised running service with its env key. Plaintext is decrypted in memory only.

Scanning fails closed. ClamAV has internal size/format limits; accepting a stream does not prove every byte was analyzed. `AlertExceedsMax yes` is mandatory. Multi-GB acceptance cannot be claimed using a test scanner or by bypassing these limits. Large-media format validation and an appropriate streaming scanner are still required for production readiness. [ClamAV size limit notes](https://blog.clamav.net/2023/08/).

## Activities and local DJ voice

Authoritative revisions and playback clock anchors synchronize clients. VM input requires a server lease, not a client-selected controller. Target SFU is in-house Rust using str0m; no GPU dependency, no mesh masquerading as SFU. LAN glass-to-glass latency and 30-person load require actual measurements.

The requested Steve Harvey voice is restricted to a private group and must never be exposed as a public or hosted cloning service. No voice reference is present, so a local placeholder voice is the only usable voice. Use a pluggable local TTS command and explicitly configured local model/reference; never use a hosted clone API. Reference requirements and model adapters are documented in DJ-REFERENCE.md. Generated speech should remain identified as synthetic in settings. No reference audio will be scraped automatically.

## Integration boundaries

Gimme uses v2 capabilities/contract discovery, stable idempotency keys and relative same-origin job polling. This sprint invokes only fixtures/dry runs. No movie confirmation/download or TV subscription against production. Plex, Giphy and Switchboard secrets stay server-side. Unconfigured features fail unavailable. Explicit text-only link previews now enforce public HTTPS443, all-answer DNS checks and pinned dialing, no redirects/proxy inheritance, and bounded HTML/DOM parsing. Remote images and arbitrary HTML remain disabled.
