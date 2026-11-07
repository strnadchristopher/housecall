import { ApiError, type Api } from "./api";
import type { ActivitySnapshot } from "../data/activities";

/** Authenticated bounded audio binding; the server clock controls shared playback. */
export class DjPlayer {
  private abort?: AbortController;
  private objectUrl?: string;
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
    this.audio.onloadedmetadata = () => this.sync();
    this.audio.onerror = () => this.error("DJ audio cannot be decoded on this device");
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
    try {
      const response = await fetch(this.api.mediaRequest(path, { signal: abort.signal }));
      if (!response.ok) throw new Error(`DJ audio unavailable (${response.status})`);
      const reader = response.body?.getReader();
      if (!reader) throw new Error("DJ audio is empty");
      let length = 0;
      const parts: Uint8Array<ArrayBuffer>[] = [];
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          length += value.length;
          if (length > 64 * 1024 * 1024) throw new Error("DJ audio exceeds the bounded track cache");
          parts.push(new Uint8Array(value));
        }
      } finally { await reader.cancel(); }
      if (abort.signal.aborted) return;
      this.objectUrl = URL.createObjectURL(new Blob(parts, { type: "audio/ogg" }));
      this.audio.src = this.objectUrl;
      this.audio.load();
    } catch (error) {
      if (!abort.signal.aborted) this.error(error instanceof Error ? error.message : String(error));
    }
  }
  update(snapshot: ActivitySnapshot) {
    if (this.snapshot && snapshot.revision < this.snapshot.revision) return;
    this.snapshot = snapshot;
    this.receivedAt = performance.now();
    this.sync();
  }
  private sync() {
    if (!this.snapshot || !this.audio.readyState || this.abort?.signal.aborted) return;
    if (!this.clockHealthy || this.snapshot.playback.media_id !== this.trackId) { this.audio.pause(); return; }
    const state = this.snapshot.playback;
    const now = this.offset === undefined ? this.snapshot.server_time_ms + performance.now() - this.receivedAt : Date.now() + this.offset;
    const elapsed = state.playing ? Math.max(0, now - state.anchored_at_ms) : 0;
    const target = (state.position_ms + elapsed) / 1000;
    if (Math.abs(this.audio.currentTime - target) > (state.playing ? 0.35 : 0.02)) this.audio.currentTime = target;
    if (state.playing && this.audio.paused) void this.audio.play().catch(() => this.error("Tap the DJ audio play control to enable sound on this device"));
    if (!state.playing) this.audio.pause();
  }
  destroy() {
    this.abort?.abort();
    clearInterval(this.timer);
    clearInterval(this.clockTimer);
    this.audio.onloadedmetadata = null;
    this.audio.onerror = null;
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = undefined;
    this.snapshot = undefined;
    this.offset = undefined;
  }
}
