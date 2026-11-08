import type { Api } from "./api";
import { FragmentedMedia } from "./fragmentedMedia";

/** Only the server's fragmented H.264/AAC MP4 derivatives are accepted. */
export function initializationMime(bytes: Uint8Array): string | undefined {
  if (bytes.length > 1024 * 1024) throw new Error("Video initialization exceeds 1 MiB");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (offset: number, size: number) => String.fromCharCode(...bytes.subarray(offset, offset + size));
  for (let offset = 0; offset + 8 <= bytes.length;) {
    const size = view.getUint32(offset);
    if (size < 8 || size > 1024 * 1024) throw new Error("Invalid video initialization box");
    if (offset + size > bytes.length) return;
    if (text(offset + 4, 4) === "moov") {
      let avc: string | undefined;
      let audio = false;
      // The derivative is produced by our fixed FFmpeg pipeline. Inspect its
      // codec configuration, never filenames or an untrusted codec string.
      for (let at = offset + 8; at + 12 <= offset + size; at++) {
        if (text(at, 4) === "avcC" && bytes[at + 4] === 1)
          avc = `avc1.${[bytes[at + 5], bytes[at + 6], bytes[at + 7]].map(n => n.toString(16).padStart(2, "0")).join("")}`;
        if (text(at, 4) === "mp4a") audio = true;
      }
      if (!avc) throw new Error("The derivative has no H.264 configuration");
      return `video/mp4; codecs="${avc}${audio ? ", mp4a.40.2" : ""}"`;
    }
    offset += size;
  }
}

/** Scanned H.264/AAC playback with authenticated seeks outside retained buffers. */
export class UploadedVideo extends FragmentedMedia {
  constructor(video: HTMLVideoElement, api: Api, error: (message: string) => void) {
    super(video, api, initializationMime, error);
  }
}
