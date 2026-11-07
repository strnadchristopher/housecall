import Hls, { FetchLoader } from "hls.js";
import type { Api } from "./api";
import type { ActivitySnapshot } from "../data/activities";
/** Plain media binding. Opus controls presentation and transport controls. */
export class PlexPlayer {
  private hls?: Hls;
  private timer?: ReturnType<typeof setInterval>;
  private snapshot?: ActivitySnapshot;
  private receivedAt = 0;
  private clockTimer?: ReturnType<typeof setInterval>;
  private offset?: number;
  private active=false;
  constructor(
    private video: HTMLVideoElement,
    private api: Api,
    private error: (message: string) => void,
  ) {}
  load(manifestPath: string) {
    this.destroy();
    this.active=true;
    if (!Hls.isSupported())
      throw new Error(
        "Authenticated HLS playback needs MediaSource support on this device",
      );
    const hls = new Hls({
      loader: FetchLoader,
      enableWorker: false,
      maxBufferLength: 20,
      maxMaxBufferLength: 40,
      fetchSetup: (context, init) => this.api.mediaRequest(context.url, init),
    });
    this.hls = hls;
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (data.fatal) this.error(`Plex playback failed: ${data.details}`);
    });
    hls.on(Hls.Events.MANIFEST_PARSED, () => this.sync());
    hls.attachMedia(this.video);
    hls.loadSource(this.api.mediaRequest(manifestPath).url);
    this.timer = setInterval(() => this.sync(), 500);
    const channel = new URL(
      this.api.mediaRequest(manifestPath).url,
    ).pathname.match(/^\/api\/channels\/([^/]+)\/plex\//)?.[1];
    if (channel) {
      const clock = async () => {
        const started = Date.now();
        try {
          const snapshot = await this.api.get<ActivitySnapshot>(
            `/api/channels/${channel}/activity`,
          );
          if(!this.active)return;
          this.offset = snapshot.server_time_ms - (started + Date.now()) / 2;
          if (!this.snapshot || snapshot.revision >= this.snapshot.revision)
            this.update(snapshot);
        } catch (error) {
          this.error(error instanceof Error ? error.message : String(error));
        }
      };
      void clock();
      this.clockTimer = setInterval(() => void clock(), 5000);
    }
  }
  update(snapshot: ActivitySnapshot) {
    this.snapshot = snapshot;
    this.receivedAt = performance.now();
    this.sync();
  }
  private sync() {
    const snapshot = this.snapshot;
    if (!snapshot || !this.video.readyState) return;
    const state = snapshot.playback;
    const elapsed = state.playing
      ? Math.max(
          0,
          (this.offset === undefined
            ? snapshot.server_time_ms + performance.now() - this.receivedAt
            : Date.now() + this.offset) - state.anchored_at_ms,
        )
      : 0;
    const target = (state.position_ms + elapsed) / 1000;
    if (Math.abs(this.video.currentTime - target) > (state.playing ? 0.35 : 0.02))
      this.video.currentTime = target;
    if (state.playing) {
      if (this.video.paused)
        void this.video
          .play()
          .catch(() =>
            this.error("Playback needs a user gesture on this device"),
          );
    } else this.video.pause();
  }
  subtitles(enabled: boolean) {
    if (this.hls) {
      this.hls.subtitleDisplay = enabled;
      this.hls.subtitleTrack = enabled ? 0 : -1;
    }
  }
  destroy() {
    this.active=false;
    clearInterval(this.timer);
    clearInterval(this.clockTimer);
    this.hls?.destroy();
    this.hls = undefined;
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
  }
}
