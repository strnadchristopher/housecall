# Activities implementation and integration boundaries

`crates/activities` is a standalone Rust crate. `server/src/activities.rs` persists activity state transactionally in SQLite and emits channel events. This is working synchronized **control state**, not evidence of synchronized media playback. Current members come from channel membership; an SFU roster must replace this with active voice membership before claiming voice-channel activity launch parity.

## State protocol

`Session::new(kind, host, members, now_ms)` accepts Plex, DJ or VM and 1–30 authorized members. `apply(actor, expected_revision, Command, now_ms)` authorizes, validates against the current revision, applies atomically, and returns a snapshot. Stale commands return conflict; refresh the snapshot instead of blindly resubmitting. Failed commands do not alter state. Use server time in milliseconds consistently; browsers must not supply it. `snapshot` rejects outsiders. `replace_members` is a trusted server-only revocation hook. Persist the session before broadcasting the returned snapshot.

Every snapshot contains `kind`, `revision`, `server_time_ms`, `host`, `members`, `playback`, `queue`, `skip_votes`, `controller` and `control_requests`. Playback has media ID, duration, playing flag, anchor position and anchor time. Clients estimate the offset to the server clock, derive the current position from the anchor, and correct drift. Audio/video playback drift and glass-to-glass delay have **not** been measured by these domain tests. Reconnecting clients receive the latest full snapshot. `tick(now_ms)` ends finished media, advances DJ queues and expires VM control, returning a snapshot when state changed. The HTTP integration advances on requests; continuous timed broadcasting still needs a worker.

Commands:

- Plex: host selects a numeric Plex item ID and duration, plays, pauses or seeks. Selection and duration must ultimately come from validated Plex metadata.
- DJ: each member enqueues a track; server overwrites requester identity. Only requester or host removes a track. Unique users vote to skip; strict majority skips. Host can skip directly. Queue is capped at 500 metadata entries, not media bytes.
- VM: request control, explicit handoff, renew or release. Control expires in 30 seconds. Every input packet must call `authorize_input`, including packets on existing sockets. Departing members lose control immediately. Snapshot reset and the VM gateway are infrastructure concerns, not implemented by the state machine.

The authenticated server routes are `GET/POST/DELETE /api/channels/{id}/activity`, `POST /api/channels/{id}/activity/commands` and `POST /api/channels/{id}/gimme/requests`. Start body is `{"kind":"plex"}` (or `dj`, `vm`); command body is `{"expected_revision":0,"command":{"type":"select","media_id":"42","duration_ms":10000}}`. Route tests cover anonymous and cross-channel denial, three viewers, stale writes, host restrictions and membership removal.

## Provider adapters

Plex's token stays in an `X-Plex-Token` server header; it is never included in returned DTOs or URLs. `Plex::libraries`, `browse` (100 items/page), `metadata`, `transcode` and `subtitle` construct real PMS requests. Redirects are disabled. All client-supplied IDs are numeric. Transcoding requests HLS/H.264/AAC, including a subtitle selection. The embedding media gateway must rewrite HLS segment URIs, authenticate every fetch, keep the token server-side, and clean up transcode sessions. That playback gateway is **not implemented**. The API choices follow the [official PMS reference](https://developer.plex.tv/pms/), including its JSON Accept header, transcode endpoint and stream metadata.

DJ `Resolver::resolve` accepts strictly validated YouTube/SoundCloud track URLs or text search. Spotify track URLs fetch catalog title/artist with a server-held token and resolve a YouTube search. This is a candidate match, not an acoustic identity guarantee; a confidence/review UI and fallback matching remain outstanding. `yt-dlp` executes without a shell or user config, with process timeout and bounded output. Short-lived CDN URLs are server-private and excluded from serialized responses. Fetch them only from an isolated media worker with controlled outbound networking; the resolver itself is not a complete SSRF sandbox for extractor redirects. See [yt-dlp CLI documentation](https://github.com/yt-dlp/yt-dlp) and [Spotify Get Track](https://developer.spotify.com/documentation/web-api/reference/get-track). Spotify access-token acquisition/refresh is not yet supplied by this adapter.

Switchboard uses the prescribed local endpoint, `model: role:chat`, and `X-Inference-Task: chriscord.dj`. Song titles are sent as untrusted metadata. A localhost-only override enables fixtures. Banter generation and local speech are implemented adapters; scheduling banter between actual streamed songs remains outstanding. See [DJ-REFERENCE.md](DJ-REFERENCE.md).

## Gimme v2

Read the user-requested skills at `~/.hermes/skills/media/gimme-movie-requests/SKILL.md` and `~/.hermes/skills/media/gimme-app-operations/SKILL.md`, plus the first skill's `scripts/request.py`. The authoritative v2 section supersedes its legacy examples. No live Gimme service was called or changed.

`Gimme` defaults to dry-run. Discovery requires API version 2 from capabilities and contract, and all requests use `x-api-key`. Each submitted operation has an explicit idempotency key; reusing a key with a different body is rejected in-process. Live adapter calls accept only HTTP 202 submissions and strict relative job paths; HTTP 200 polling alone is not success. Completed jobs preserve `result_status` and `result`. A confirmation-required result remains a proposal: this adapter has no torrent confirmation/cancellation endpoint. Pending jobs preserve the job ID/path for later polling, and Retry-After seconds precede body delay. Redirects are disabled. The caller must persist intents/jobs and implement bounded retry orchestration; no automatic retry loop is included.

The server route is explicitly **dry-run only**: it returns the intended operation and publishes `gimme.dry_run`, with `provider_verified:false`. It does not claim that a movie was requested or downloaded. Its v2 discovery documents are fixtures. Live contract schema validation beyond version discovery, durable job processing/status posts, and deployment with real credentials remain unfinished.

## Configuration and verification

Provider configuration must be read from environment by the server composition root: `PLEX_URL`, `PLEX_TOKEN`, `SPOTIFY_ACCESS_TOKEN`, `SWITCHBOARD_API_KEY`, `YT_DLP_PATH`, `GIMME_URL`, `GIMME_AGENT_API_KEY`, `DJ_TTS_PROVIDER`, `DJ_REFERENCE_WAV`, `DJ_XTTS_MODEL_DIR`. Do not put credentials in client builds or logs.

Run `cargo test --manifest-path crates/activities/Cargo.toml -j 1`. Evidence: `evidence/activities-tests.log`; server tests have separate root-owned evidence. Provider tests are local TCP fixtures, not real Plex/Spotify/Switchboard/Gimme validation. Property tests fuzz song URL normalization, protocol JSON parsing and playback arithmetic. Real streaming, all-three-client browser playback sync, local clone performance, VM egress/WebRTC and voice-integrated authorization are remaining acceptance checks.
