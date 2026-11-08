import { ApiError, type Api } from "./api";

type Fragment = { index: number; start: number; offset: string; end: string };
type Window = { duration: number; init_end: string; fragments: Fragment[]; next: number | null };
type Source = MediaSource & { streaming?: boolean };
type SourceConstructor = typeof MediaSource;
const abortError = () => new DOMException("Playback stopped", "AbortError");

function event(target: EventTarget, name: string, signal: AbortSignal, action?: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: unknown) => {
      target.removeEventListener(name, done); target.removeEventListener("error", failed); signal.removeEventListener("abort", aborted);
      if (error) reject(error); else resolve();
    };
    const done = () => finish();
    const failed = () => finish(new Error("Media decoding failed"));
    const aborted = () => finish(abortError());
    target.addEventListener(name, done, { once: true }); target.addEventListener("error", failed, { once: true }); signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) { aborted(); return; }
    try { action?.(); } catch (error) { finish(error); }
  });
}
async function pause(signal: AbortSignal) {
  await new Promise<void>((resolve, reject) => {
    const stop = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, 100);
    if (signal.aborted) stop(); else signal.addEventListener("abort", stop, { once: true });
  });
}
function contains(ranges: TimeRanges, time: number): boolean {
  for (let i = 0; i < ranges.length; i++) if (ranges.start(i) <= time && time < ranges.end(i) - 0.05) return true;
  return false;
}
function byteOffset(text: string): bigint {
  if (!/^\d+$/.test(text)) throw new Error("Invalid media seek response");
  return BigInt(text);
}

/** Authenticated sparse ranges with a bounded playback window. Each load owns
 * its callbacks, network work and URL, including after replacement/account exit. */
export class FragmentedMedia {
  private session?: StreamSession;
  constructor(private media: HTMLMediaElement, private api: Api, private mime: (bytes: Uint8Array) => string | undefined, private error: (message: string) => void) {}
  async load(path: string) {
    this.destroy();
    const session = new StreamSession(this.media, this.api, path, this.mime, this.error);
    this.session = session;
    await session.start();
  }
  destroy() { this.session?.destroy(); this.session = undefined; }
}

class StreamSession {
  private life = new AbortController();
  private operation?: AbortController;
  private source?: Source;
  private buffer?: SourceBuffer;
  private url?: string;
  private running = false;
  private ready = false;
  private backpressured = false;
  private appended = false;
  private pending?: number;
  private fetchingFrom = 0;
  private duration = 0;
  private remotePlayback?: boolean;
  constructor(private media: HTMLMediaElement, private api: Api, private path: string, private mime: (bytes: Uint8Array) => string | undefined, private error: (message: string) => void) {}
  private get alive() { return !this.life.signal.aborted; }
  private failed = () => this.fail(new Error("This device could not decode the media"));
  private seeking = () => {
    if (!this.alive || !this.buffer || contains(this.buffer.buffered, this.media.currentTime)) return;
    // Setting currentTime during metadata loading can repeat a seeking event.
    if (this.running && Math.abs(this.media.currentTime - this.fetchingFrom) < 0.1) return;
    this.request(this.media.currentTime);
  };
  private missingCurrent() {
    if (!this.buffer) return false;
    const ranges = this.buffer.buffered, time = this.media.currentTime;
    // H.264's initial presentation timestamp can be slightly above zero.
    if (time < 0.25 && ranges.length && ranges.start(0) < 0.25) return false;
    return !contains(ranges, time);
  }
  private waiting = () => {
    if (this.missingCurrent() && (!this.running || (this.backpressured && this.appended))) this.request(this.media.currentTime);
  };
  private fail(error: unknown) {
    if (!this.alive) return;
    this.destroy();
    this.error(error instanceof Error ? error.message : String(error));
  }
  async start() {
    try {
      const window = await this.window("time=0", this.life.signal);
      const initialization = await this.bytes(0n, byteOffset(window.init_end), this.life.signal);
      if (!this.alive) return;
      const mime = this.mime(initialization);
      if (!mime) throw new Error("Media has no supported initialization segment");
      const managed = (globalThis as typeof globalThis & { ManagedMediaSource?: SourceConstructor }).ManagedMediaSource;
      const regular = globalThis.MediaSource;
      const Constructor = [managed, regular].find(candidate => candidate?.isTypeSupported(mime));
      if (!Constructor) throw new Error("This device cannot stream this media codec");
      this.remotePlayback = this.media.disableRemotePlayback;
      // WebKit exposes ManagedMediaSource on iPhone when remote playback is disabled.
      if (Constructor === managed) this.media.disableRemotePlayback = true;
      const source: Source = new Constructor(); this.source = source;
      this.media.addEventListener("error", this.failed);
      this.media.addEventListener("seeking", this.seeking);
      this.media.addEventListener("waiting", this.waiting);
      const opened = event(source, "sourceopen", this.life.signal);
      this.url = URL.createObjectURL(source); this.media.src = this.url;
      await opened;
      if (!this.alive) return;
      const buffer = source.addSourceBuffer(mime); this.buffer = buffer;
      buffer.addEventListener("bufferedchange", this.waiting);
      this.duration = window.duration; source.duration = this.duration;
      await event(buffer, "updateend", this.life.signal, () => buffer.appendBuffer(new Uint8Array(initialization)));
      if (!this.alive) return;
      // A synchronized DJ may already have set currentTime from loadedmetadata.
      this.ready = true;
      this.request(this.pending ?? this.media.currentTime, window);
    } catch (error) { this.fail(error); }
  }
  private async window(query: string, signal: AbortSignal): Promise<Window> {
    const value = await this.api.get<Window>(`${this.path}/seek?${query}`, signal);
    if (signal.aborted) throw abortError();
    if (!Number.isFinite(value.duration) || value.duration <= 0 || !Array.isArray(value.fragments) || !value.fragments.length || value.fragments.length > 8 || byteOffset(value.init_end) > 1024n * 1024n)
      throw new Error("Invalid media seek response");
    for (const f of value.fragments) {
      if (!Number.isFinite(f.start) || !Number.isSafeInteger(f.index) || f.index < 0 || byteOffset(f.offset) >= byteOffset(f.end)) throw new Error("Invalid media fragment");
    }
    return value;
  }
  private async response(start: bigint, end: bigint, signal: AbortSignal): Promise<Response> {
    const response = await fetch(this.api.mediaRequest(this.path, { signal, headers: { Range: `bytes=${start}-${end - 1n}` } }));
    if (signal.aborted) { await response.body?.cancel().catch(() => {}); throw abortError(); }
    // Reject servers/proxies that ignore Range, avoiding an accidental whole-object read.
    if (response.status !== 206) {
      await response.body?.cancel().catch(() => {});
      throw new ApiError(response.status, `Media range unavailable (${response.status})`);
    }
    return response;
  }
  private async bytes(start: bigint, end: bigint, signal: AbortSignal): Promise<Uint8Array> {
    const response = await this.response(start, end, signal);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Media response is empty");
    const expected = Number(end - start);
    const bytes = new Uint8Array(expected); let length = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (signal.aborted) throw abortError();
        if (done) break;
        if (length + value.length > expected) throw new Error("Media range exceeded its requested size");
        bytes.set(value, length); length += value.length;
      }
      if (length !== expected) throw new Error("Media range was interrupted");
      return bytes;
    } finally { await reader.cancel().catch(() => {}); }
  }
  private request(time: number, first?: Window) {
    if (!this.alive || !Number.isFinite(time)) return;
    this.pending = Math.max(0, Math.min(time, Math.max(0, this.duration - 0.001)));
    this.operation?.abort();
    if (!this.running && this.ready) void this.run(first);
  }
  private async run(first?: Window) {
    if (!this.buffer || !this.source) return;
    this.running = true;
    while (this.alive && this.pending !== undefined) {
      const target = this.pending; this.pending = undefined; this.fetchingFrom = target;
      this.backpressured = false; this.appended = false;
      const operation = new AbortController(); this.operation = operation;
      const stop = () => operation.abort(); this.life.signal.addEventListener("abort", stop, { once: true });
      try {
        const buffer = this.buffer, source = this.source;
        // Cancelling our waiter does not cancel SourceBuffer work. Drain the
        // previous append/remove before resetting the parser. abort() while
        // removing throws; abort() while appending queues a stale updateend.
        if (buffer.updating) await event(buffer, "updateend", operation.signal);
        if (source.readyState === "open") buffer.abort();
        if (buffer.buffered.length || source.readyState === "ended") await event(buffer, "updateend", operation.signal, () => buffer.remove(0, Math.max(source.duration, buffer.buffered.length ? buffer.buffered.end(buffer.buffered.length - 1) : 0)));
        let window = first && target < 0.1 ? first : await this.window(`time=${target}`, operation.signal);
        first = undefined;
        for (;;) {
          for (const fragment of window.fragments) {
            while (source.streaming === false || fragment.start > this.media.currentTime + 30) {
              this.backpressured = true;
              // ManagedMediaSource can evict the playhead while this producer
              // waits on a future fragment. Rearm at the missing playhead.
              if (this.appended && this.missingCurrent()) this.request(this.media.currentTime);
              await pause(operation.signal);
            }
            this.backpressured = false;
            const removeBefore = this.media.currentTime - 10;
            if (removeBefore > 0 && buffer.buffered.length && buffer.buffered.start(0) < removeBefore)
              await event(buffer, "updateend", operation.signal, () => buffer.remove(0, removeBefore));
            await this.append(fragment, operation.signal); this.appended = true;
          }
          if (window.next === null) break;
          window = await this.window(`fragment=${window.next}`, operation.signal);
        }
        if (!operation.signal.aborted && source.readyState === "open") source.endOfStream();
      } catch (error) { if (!operation.signal.aborted) this.fail(error); }
      finally { this.backpressured = false; this.life.signal.removeEventListener("abort", stop); }
    }
    this.running = false;
  }
  private async append(fragment: Fragment, signal: AbortSignal) {
    const start = byteOffset(fragment.offset), end = byteOffset(fragment.end);
    const response = await this.response(start, end, signal);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Media response is empty");
    let received = 0n;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (signal.aborted) throw abortError();
        if (done) break;
        received += BigInt(value.length);
        if (received > end - start) throw new Error("Media range exceeded its requested size");
        for (let at = 0; at < value.length; at += 64 * 1024) {
          const bytes = new Uint8Array(value.subarray(at, at + 64 * 1024));
          await event(this.buffer!, "updateend", signal, () => this.buffer!.appendBuffer(bytes));
        }
      }
      if (received !== end - start) throw new Error("Media range was interrupted");
    } finally { await reader.cancel().catch(() => {}); }
  }
  destroy() {
    if (!this.alive) return;
    this.life.abort(); this.operation?.abort();
    this.buffer?.removeEventListener("bufferedchange", this.waiting);
    this.media.removeEventListener("error", this.failed);
    this.media.removeEventListener("seeking", this.seeking);
    this.media.removeEventListener("waiting", this.waiting);
    this.media.pause(); this.media.removeAttribute("src"); this.media.load();
    if (this.remotePlayback !== undefined) this.media.disableRemotePlayback = this.remotePlayback;
    if (this.url) URL.revokeObjectURL(this.url); this.url = undefined;
  }
}
