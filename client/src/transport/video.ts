import type { Api } from "./api";

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

function event(target: EventTarget, name: string, signal: AbortSignal, action?: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: unknown) => {
      target.removeEventListener(name, done); target.removeEventListener("error", failed); signal.removeEventListener("abort", aborted);
      if (error) reject(error); else resolve();
    };
    const done = () => finish();
    const failed = () => finish(new Error("Video decoding failed"));
    const aborted = () => finish(new DOMException("Playback stopped", "AbortError"));
    target.addEventListener(name, done, { once: true }); target.addEventListener("error", failed, { once: true }); signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) { aborted(); return; }
    try { action?.(); } catch (error) { finish(error); }
  });
}
async function pause(signal: AbortSignal) {
  await new Promise<void>((resolve, reject) => {
    const stop = () => { clearTimeout(timer); reject(new DOMException("Playback stopped", "AbortError")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, 200);
    if (signal.aborted) stop(); else signal.addEventListener("abort", stop, { once: true });
  });
}

/** Streaming authenticated fetch -> MSE, bounded by playback time, never a full-file Blob. */
export class UploadedVideo {
  private abort?: AbortController;
  private url?: string;
  constructor(private video: HTMLVideoElement, private api: Api, private error: (message: string) => void) {}
  async load(path: string) {
    this.destroy();
    const abort = new AbortController(); this.abort = abort;
    this.video.onerror = () => this.error("This device could not decode the uploaded video");
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      if (!globalThis.MediaSource) throw new Error("Streaming uploads are unavailable on this device");
      const source = new MediaSource();
      const opened = event(source, "sourceopen", abort.signal);
      this.url = URL.createObjectURL(source); this.video.src = this.url;
      await opened;
      const response = await fetch(this.api.mediaRequest(path, { signal: abort.signal }));
      if (!response.ok) throw new Error(`Video unavailable (${response.status})`);
      reader = response.body?.getReader();
      if (!reader) throw new Error("Video response is empty");
      let initial = new Uint8Array(0);
      let buffer: SourceBuffer | undefined;
      while (!abort.signal.aborted) {
        if (buffer) {
          // Backpressure keeps fetch and browser media buffers bounded even for
          // multi-hour files. Seek is available within the retained buffer.
          while (buffer.buffered.length && buffer.buffered.end(buffer.buffered.length - 1) - this.video.currentTime > 30) await pause(abort.signal);
          const removeBefore = this.video.currentTime - 10;
          if (removeBefore > 0 && buffer.buffered.length && buffer.buffered.start(0) < removeBefore)
            await event(buffer, "updateend", abort.signal, () => buffer!.remove(0, removeBefore));
        }
        const { done, value } = await reader.read();
        if (done) {
          if (!buffer) throw new Error("Video has no initialization segment");
          if (source.readyState === "open") source.endOfStream();
          return;
        }
        // Fetch may coalesce many server chunks. Subdivide before appending so
        // a single large read cannot bypass the playback-window backpressure.
        for (let offset = 0; offset < value.length; offset += 64 * 1024) {
          let bytes = new Uint8Array(value.subarray(offset, offset + 64 * 1024));
          if (!buffer) {
            if (initial.length + bytes.length > 1024 * 1024) throw new Error("Video initialization exceeds 1 MiB");
            const joined = new Uint8Array(initial.length + bytes.length); joined.set(initial); joined.set(bytes, initial.length); initial = joined;
            const mime = initializationMime(initial);
            if (!mime) continue;
            if (!MediaSource.isTypeSupported(mime)) throw new Error("This device cannot decode H.264/AAC uploads");
            buffer = source.addSourceBuffer(mime); bytes = initial; initial = new Uint8Array(0);
          }
          while (buffer.buffered.length && buffer.buffered.end(buffer.buffered.length - 1) - this.video.currentTime > 30) await pause(abort.signal);
          await event(buffer, "updateend", abort.signal, () => buffer!.appendBuffer(bytes));
        }
      }
    } catch (error) {
      if (!abort.signal.aborted) this.error(error instanceof Error ? error.message : String(error));
    } finally { await reader?.cancel().catch(() => {}); }
  }
  destroy() {
    this.abort?.abort(); this.video.onerror = null; this.video.pause(); this.video.removeAttribute("src"); this.video.load();
    if (this.url) URL.revokeObjectURL(this.url); this.url = undefined;
  }
}
