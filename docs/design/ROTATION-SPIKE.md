# Rotation spike (B12)

## What the code shows

- `crates/sfu/src/lib.rs` built every connection with `Rtc::builder()`, which uses str0m 0.25's
  `ExtensionMap::standard()`. That map includes `urn:3gpp:video-orientation` as id 13
  (`str0m-0.25.0/src/rtp/ext.rs`, `standard()`).
- The browser offer on the publish leg carries it (id 13, captured from Chromium below), and the
  server answered by accepting the shared subset, so it was negotiated.
- Nothing in `crates/sfu` reads or writes orientation (`grep -i orientation crates/sfu/src` is empty).
  Forwarding does not set `video_orientation` on the writer, so subscribers never receive the flag.
- `client/src/transport/voice.ts` does no SDP work except Opus (`opusFullband`); it does not touch
  header extensions.

Conclusion: when a sender negotiates video-orientation it may stop rotating pixels and send the
sensor orientation as a header flag instead. The SFU drops the flag, so subscribers would render
sideways video. This is conclusive from the code.

## Change

`publish_builder()` in `crates/sfu/src/lib.rs` uses the standard map minus id 13. The answer no
longer contains the extension, so the sender rotates the pixels itself.

Tests:
- `video_orientation_is_not_negotiated_on_the_publish_leg` (cargo, SDP level): a default str0m
  offer carries the extension, the server answer does not, and mid is still negotiated.
- voice e2e "video orientation is not negotiated on the publish leg": Chromium offers it, the
  answer omits it, and no server offer to a viewer contains it. Raw extmap lists are written to
  `client/test-results/client-video-extmap.json`.

Chromium measured: offer lists `a=extmap:13 urn:3gpp:video-orientation`; the answer lists only
abs-send-time, transport-cc, mid, rtp-stream-id, repaired-rtp-stream-id.

## Still outstanding (Noah, real iPhone)

The three-orientation check has not been done. On an iPhone in the PWA/native client, publish
camera in portrait, landscape-left and landscape-right, and confirm a desktop viewer sees an
upright picture each time, including after rotating mid-call. If sideways video persists, capture
`chrome://webrtc-internals` (or Safari equivalent) SDP for the publish leg and the viewer's
`videoWidth`/`videoHeight` per orientation.
