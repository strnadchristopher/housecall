# Authenticated upload seeking and progressive DJ playback

This is a source candidate, not final browser/native acceptance. It preserves the existing scan-before-release gates for originals and generated derivatives. It does not change scanner policy, inspect private/generated user media, use provider credentials, or alter the historical SFU executable.

Uploaded video and DJ audio now share `client/src/transport/fragmentedMedia.ts`. It obtains a small authenticated seek descriptor, fetches the initialization segment, then requests individual fragments with bearer/device headers and HTTP byte ranges. The player retains roughly thirty seconds ahead and ten behind, plus a fragment boundary. Seeking outside that window cancels the previous operation, clears the partial MP4 parser and replaces the media buffer with fragments at the requested time. Byte offsets remain decimal strings/BigInt, avoiding JavaScript number truncation for large disk objects. A server/proxy that ignores Range is rejected before its body is read.

The new private routes are:

- `GET /api/media-jobs/{id}/video/seek?time=<seconds>` (or `fragment=<index>`): current session, channel membership, ready derivation, scanned storage. Authorization is rechecked after off-thread index reads. Source unsend/deletion invalidates the job and removes its derivatives.
- `GET /api/channels/{id}/dj/audio/{track}/seek?time=<seconds>` (or `fragment=<index>`): current voice membership/session, DJ activity and exact current track, checked again after lookup.

Descriptors expose `duration`, `init_end`, at most eight `{index,start,offset,end}` fragments, and a `next` cursor. Offsets use exclusive `end`. `server/src/media_index.rs` reads the fixed FFmpeg `moov`/`mfra`/`tfra` structures and the final fragment's sample timing. Binary search touches a logarithmic number of index entries; a four-window 256 KiB read cache avoids repeatedly decrypting neighboring entries. Initialization/final-fragment metadata are each bounded at 1 MiB. Neither object bytes nor the entire index are materialized. Existing FFmpeg upload outputs already contain this trailer; new derivatives force keyframes about every two seconds for faster seeks.

DJ preparation still completes local synthesis/encoding and scanner approval before publishing a ready cache entry. Its container is now fragmented MP4 containing the existing 510 kbps stereo Opus, with approximately two-second fragments. The client no longer builds a full 64 MiB Ogg Blob before playback. The server's existing preparation/cache limits remain unchanged. Previously scanned ready Ogg cache entries remain playable through an explicit `legacy_dj_ogg` compatibility response: only those old tracks retain the prior bounded64MiB buffering behavior and `audio/ogg` type. New tracks always use progressive MP4. No unscanned conversion or fallback release occurs.

Compatible WebKit clients use `ManagedMediaSource` with remote playback disabled as required by WebKit; ordinary MediaSource remains the fallback. Codec support is checked against the actual upload initialization or fixed DJ Opus codec. Unsupported devices report an error. Native WKWebView/WebView decoders, hardware audio, and physical latency are separate unexecuted gates. The implementation introduces no session credentials in URLs, cookies, plaintext files, or service workers.

Each load owns its abort controllers, object URL, callbacks and source buffer. Replacement/account exit aborts requests and clears the media element. Delayed initialization, superseded seeks and delayed autoplay rejection cannot restore old playback or surface old-account errors. Network/authorization/decoding failures stop playback; reopening the attachment/player starts a fresh session. Existing DJ clock synchronization and current-track checks continue to control play/pause/seek.

## Verification and remaining execution

Lightweight tests exercise real transport classes against controlled EventTarget/media-stream fixtures. They cover progressive start, authenticated forward/backward seek, ManagedMediaSource selection, late account/seek/play callbacks, partially delivered fragment recovery, refusal of ignored ranges, serial SourceBuffer cancellation, ManagedMediaSource eviction while backpressured, slow late-join DJ seeks, and existing Ogg queue compatibility. These fixtures do not decode media.

```bash
client/node_modules/.bin/vitest run client/tests/media-streaming.test.ts --maxWorkers=1
client/node_modules/.bin/tsc --noEmit --project client/tsconfig.json
```

Authored, unexecuted Rust cases include sparse multi-terabyte virtual offsets without allocating payload, exact offsets above JavaScript's integer limit, malformed/missing index handling, actual FFmpeg derivative index boundaries, anonymous/cross-channel/revoked-session access, source deletion and current-DJ-track invalidation. The existing actual-FFmpeg server tests now check the seek endpoints and new MP4 container. Run them only after the historical SFU receipt and through a shared-lock, single-job, incremental-disabled, disk-floor guard:

```bash
cargo test --locked -p housecall-server media_index::tests
cargo test --locked -p housecall-server --test transcode
cargo test --locked -p housecall-server dj::tests -- --skip three_browsers_decode_and_synchronize_dj_fixture
```

The isolated ignored DJ test now uses ninety-second synthetic audio. Its actual Chromium scenario asserts playback with most audio still unrequested, seeks forward to 70 seconds then backward to 7 seconds, and checks three-client pause/resume/vote-skip. Unique UUID receipts preserve historical evidence:

```bash
cargo test --locked -p housecall-server dj::tests::three_browsers_decode_and_synchronize_dj_fixture -- --ignored --exact --nocapture
```

The existing `client/tests/e2e/upload-video.spec.ts` scenario now seeks the sixty-second synthetic video from the initial buffer to 55 seconds and back to 2 seconds, checking actual decoded progress and anonymous/cross-user/unsend denial for the seek endpoint. It writes a unique `evidence/media-upload-seek-<uuid>.json`. Run with `HOUSECALL_TEST_UPLOAD_VIDEO=1` against a rebuilt candidate server using the existing isolated Playwright harness and the same heavy guard; real ClamAV availability and current Opus UI selectors are prerequisites. Browser screenshots/adversarial UI review and actual native decoder execution remain pending. No frozen launcher/package/test-selector files were edited.

Format references: [FFmpeg MP4 fragmentation flags](https://ffmpeg.org/ffmpeg-formats.html#mov_002c-mp4_002c-ismv), [FFmpeg trailer writer](https://ffmpeg.org/doxygen/7.1/movenc_8c_source.html), and [WebKit ManagedMediaSource requirements](https://webkit.org/blog/14735/webkit-features-in-safari-17-1/).
