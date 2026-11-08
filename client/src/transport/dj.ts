import { ApiError, type Api } from "./api";
import type { ActivitySnapshot } from "../data/activities";
import { FragmentedMedia } from "./fragmentedMedia";

/** Authenticated bounded audio binding; the server clock controls shared playback. */
export class DjPlayer {
  private abort?: AbortController;
  private stream?: FragmentedMedia;
  private legacyUrl?: string;
  private legacyError?: () => void;
  private timer?: ReturnType<typeof setInterval>;
  private clockTimer?: ReturnType<typeof setInterval>;
  private snapshot?: ActivitySnapshot;
  private receivedAt = 0;
  private offset?: number;
  private trackId?: string;
  private clockHealthy = true;
  constructor(private audio: HTMLAudioElement, private api: Api, private error: (message: string) => void) {}
  async load(path: string, channel: string) {
    this.destroy();
    this.trackId = path.split("/").at(-1);
    this.clockHealthy = true;
    const abort = new AbortController();
    this.abort = abort;
    this.audio.onloadedmetadata = () => { if (!abort.signal.aborted) this.sync(); };
    const clock = async () => {
      const started = Date.now();
      try {
        const snapshot = await this.api.get<ActivitySnapshot>(`/api/channels/${encodeURIComponent(channel)}/activity`, abort.signal);
        if (abort.signal.aborted) return;
        this.clockHealthy = true;
        this.offset = snapshot.server_time_ms - (started + Date.now()) / 2;
        if (!this.snapshot || snapshot.revision >= this.snapshot.revision) this.update(snapshot);
      } catch (error) {
        if (!abort.signal.aborted) {
          this.clockHealthy = false;
          this.audio.pause();
          if (error instanceof ApiError && [401, 403, 404].includes(error.status)) this.destroy();
          this.error(error instanceof Error ? error.message : String(error));
        }
      }
    };
    this.clockTimer = setInterval(() => void clock(), 5000);
    this.timer = setInterval(() => this.sync(), 250);
    void clock();
    const stream = new FragmentedMedia(this.audio, this.api, () => 'audio/mp4; codecs="opus"', message => {
      if (abort.signal.aborted) return;
      if (message === "legacy_dj_ogg") void this.loadLegacy(path, abort);
      else { this.destroy(); this.error(message); }
    });
    this.stream = stream;
    await stream.load(path);
  }

  /** Upgrade compatibility for existing scanned Ogg cache entries only. New
   * tracks always use progressive MP4; preserve the old cache's64MiB bound. */
  private async loadLegacy(path: string, abort: AbortController) {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await fetch(this.api.mediaRequest(path, { signal: abort.signal }));
      if (abort.signal.aborted) { await response.body?.cancel().catch(() => {}); return; }
      if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error(`DJ audio unavailable (${response.status})`); }
      reader = response.body?.getReader();
      if (!reader) throw new Error("DJ audio is empty");
      let length = 0;
      const parts: Uint8Array<ArrayBuffer>[] = [];
      for (;;) {
        const { value, done } = await reader.read();
        if (abort.signal.aborted) return;
        if (done) break;
        length += value.length;
        if (length > 64 * 1024 * 1024) throw new Error("Legacy DJ audio exceeds the bounded cache");
        parts.push(new Uint8Array(value));
      }
      if (!length) throw new Error("DJ audio is empty");
      this.legacyError = () => {
        if (!abort.signal.aborted) { this.destroy(); this.error("DJ audio cannot be decoded on this device"); }
      };
      this.audio.addEventListener("error", this.legacyError);
      this.legacyUrl = URL.createObjectURL(new Blob(parts, { type: "audio/ogg" }));
      this.audio.src = this.legacyUrl; this.audio.load();
    } catch (error) {
      if (!abort.signal.aborted) { this.destroy(); this.error(error instanceof Error ? error.message : String(error)); }
    } finally { await reader?.cancel().catch(() => {}); }
  }

  update(snapshot: ActivitySnapshot) {
    if (!this.abort || this.abort.signal.aborted || snapshot.kind !== "dj" || (this.snapshot && snapshot.revision < this.snapshot.revision)) return;
    const changed = this.snapshot?.revision !== snapshot.revision;
    this.snapshot = snapshot;
    this.receivedAt = performance.now();
    this.sync(changed);
  }
  private sync(authorityChanged = false) {
    if (!this.abort || !this.snapshot || !this.audio.readyState || this.abort.signal.aborted) return;
    if (!this.clockHealthy || this.snapshot.playback.media_id !== this.trackId) { this.audio.pause(); return; }
    const state = this.snapshot.playback;
    const now = this.offset === undefined ? this.snapshot.server_time_ms + performance.now() - this.receivedAt : Date.now() + this.offset;
    const elapsed = state.playing ? Math.max(0, now - state.anchored_at_ms) : 0;
    const target = (state.position_ms + elapsed) / 1000;
    // A late join may still be fetching the seek fragment. Chasing the clock
    // every tick would cancel that fetch indefinitely on a slow connection.
    // A new authoritative revision can still supersede an in-flight seek.
    if ((!this.audio.seeking || authorityChanged) && Math.abs(this.audio.currentTime - target) > (state.playing ? 0.35 : 0.02)) this.audio.currentTime = target;
    const current = this.abort;
    if (state.playing && this.audio.paused) void this.audio.play().catch(() => {
      if (!current.signal.aborted) this.error("Tap the DJ audio play control to enable sound on this device");
    });
    if (!state.playing) this.audio.pause();
  }
  destroy() {
    this.abort?.abort();
    clearInterval(this.timer);
    clearInterval(this.clockTimer);
    this.audio.onloadedmetadata = null;
    this.audio.onerror = null;
    this.stream?.destroy(); this.stream = undefined;
    if (this.legacyError) this.audio.removeEventListener("error", this.legacyError); this.legacyError = undefined;
    if (this.legacyUrl) URL.revokeObjectURL(this.legacyUrl); this.legacyUrl = undefined;
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
    this.snapshot = undefined;
    this.offset = undefined;
  }
}
