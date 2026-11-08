import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Api, ApiError } from "../src/transport/api";
import { UploadedVideo } from "../src/transport/video";
import { DjPlayer } from "../src/transport/dj";
import type { ActivitySnapshot } from "../src/data/activities";

function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (v: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
const ranges = (values: number[][]): TimeRanges => ({ length: values.length, start: i => values[i][0], end: i => values[i][1] });
const initialization = new Uint8Array([0, 0, 0, 20, 109, 111, 111, 118, 97, 118, 99, 67, 1, 100, 0, 31, 0, 0, 0, 0]);
class Media extends EventTarget {
  src = ""; disableRemotePlayback = false; paused = true; readyState = 0; seeking = false;
  onloadedmetadata: (() => void) | null = null; onerror = null;
  private time = 0;
  get currentTime() { return this.time; }
  set currentTime(t: number) { this.time = t; this.seeking = true; this.dispatchEvent(new Event("seeking")); }
  load = vi.fn(() => { this.readyState = 0; this.time = 0; this.seeking = false; });
  pause = vi.fn(() => { this.paused = true; });
  play = vi.fn(async () => { this.paused = false; });
  removeAttribute(name: string) { if (name === "src") this.src = ""; }
}
class Buffer extends EventTarget {
  updating = false; values: number[][] = []; appended: number[] = [];
  holdRemoval = false; holdAppend = false; active?: "append" | "remove";
  pendingUpdate?: () => void;
  private finish() { this.updating = false; this.active = undefined; this.pendingUpdate = undefined; this.dispatchEvent(new Event("updateend")); }
  complete() { this.pendingUpdate?.(); }
  constructor(readonly media: Media) { super(); }
  get buffered() { return ranges(this.values); }
  abort = vi.fn(() => {
    if (this.active === "remove") throw new DOMException("Cannot abort an active removal", "InvalidStateError");
    if (this.updating) {
      this.updating = false; this.active = undefined; this.pendingUpdate = undefined;
      queueMicrotask(() => { this.dispatchEvent(new Event("abort")); this.dispatchEvent(new Event("updateend")); });
    }
  });
  appendBuffer(bytes: Uint8Array) {
    if (this.updating) throw new DOMException("SourceBuffer busy", "InvalidStateError");
    this.updating = true; this.active = "append";
    if (bytes.length === initialization.length) {
      this.media.readyState = 1; this.media.onloadedmetadata?.();
    } else {
      const index = bytes[0] - 1; this.appended.push(index);
      this.values.push([index * 2, index * 2 + 2]); this.values.sort((a, b) => a[0] - b[0]);
      this.media.readyState = 2;
      if (this.values.some(([a, b]) => a <= this.media.currentTime && b > this.media.currentTime)) this.media.seeking = false;
    }
    if (this.holdAppend && bytes.length !== initialization.length) this.pendingUpdate = () => this.finish();
    else queueMicrotask(() => this.finish());
  }
  remove(start: number, end: number) {
    if (this.updating) throw new DOMException("SourceBuffer busy", "InvalidStateError");
    this.updating = true; this.active = "remove";
    this.values = this.values.flatMap(([a, b]) => b <= start || a >= end ? [[a, b]] : b > end ? [[end, b]] : []);
    if (this.holdRemoval) this.pendingUpdate = () => this.finish();
    else queueMicrotask(() => this.finish());
  }
}
class Source extends EventTarget {
  static instances: Source[] = []; static media: Media;
  static isTypeSupported = vi.fn(() => true);
  readyState = "closed"; duration = 0; buffer: Buffer;
  constructor() { super(); this.buffer = new Buffer(Source.media); Source.instances.push(this); queueMicrotask(() => { this.readyState = "open"; this.dispatchEvent(new Event("sourceopen")); }); }
  addSourceBuffer() { return this.buffer; }
  endOfStream() { this.readyState = "ended"; }
}
const disposables: { destroy(): void }[] = [];
function index(query: string) {
  const u = new URL(query, "https://fixture.invalid");
  const first = u.searchParams.has("fragment") ? Number(u.searchParams.get("fragment")) : Math.min(59, Math.floor(Number(u.searchParams.get("time") ?? 0) / 2));
  const until = Math.min(60, first + 8);
  return { duration: 120, init_end: "20", fragments: Array.from({ length: until - first }, (_, n) => ({ index: first + n, start: (first + n) * 2, offset: String(100 + (first + n) * 2), end: String(102 + (first + n) * 2) })), next: until < 60 ? until : null };
}
function fixture(kind: "upload" | "dj" = "upload") {
  const media = new Media(); Source.media = media;
  const api = new Api("https://fixture.invalid"); api.authenticate({ token: "fixture-token", device_key: "fixture-device" });
  const snapshot: ActivitySnapshot = { kind: "dj", revision: 1, server_time_ms: Date.now(), host: "host", members: [], queue: [], skip_votes: [], controller: null, control_requests: [], playback: { media_id: "track", position_ms: 0, duration_ms: 120000, anchored_at_ms: Date.now(), playing: true } };
  const get = vi.spyOn(api, "get").mockImplementation(async (path) => path.includes("/seek?") ? index(path) : snapshot as never);
  const requests: Request[] = [];
  const fetcher = vi.fn(async (input: Request) => {
    requests.push(input);
    const range = input.headers.get("range")!;
    if (range === "bytes=0-19") return new Response(initialization, { status: 206 });
    const start = Number(range.match(/bytes=(\d+)/)![1]);
    return new Response(new Uint8Array([(start - 100) / 2 + 1, 0]), { status: 206 });
  });
  vi.stubGlobal("fetch", fetcher);
  const error = vi.fn();
  const player = kind === "upload" ? new UploadedVideo(media as unknown as HTMLVideoElement, api, error) : new DjPlayer(media as unknown as HTMLAudioElement, api, error);
  disposables.push(player);
  const load = () => kind === "upload" ? (player as UploadedVideo).load("/api/media-jobs/video/video") : (player as DjPlayer).load("/api/channels/room/dj/audio/track", "room");
  return { media, api, get, requests, fetcher, player, error, load, snapshot };
}
beforeEach(() => {
  Source.instances = []; vi.stubGlobal("MediaSource", Source); vi.stubGlobal("ManagedMediaSource", undefined);
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:fixture-${Source.instances.length}`);
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});
afterEach(() => { for (const d of disposables.splice(0)) d.destroy(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("streams uploads progressively, seeks forward beyond the retained window, then returns to an evicted fragment", async () => {
  const f = fixture(); await f.load();
  await vi.waitFor(() => expect(Source.instances[0].buffer.appended).toContain(15));
  expect(f.requests.length).toBeLessThan(30);
  for (const request of f.requests) {
    expect(request.headers.get("authorization")).toBe("Bearer fixture-token");
    expect(request.headers.get("x-device-key")).toBe("fixture-device");
    expect(request.url).not.toContain("fixture-token");
  }
  f.media.currentTime = 90;
  await vi.waitFor(() => expect(Source.instances[0].buffer.appended).toContain(45));
  expect(f.get).toHaveBeenCalledWith(expect.stringContaining("/seek?time=90"), expect.any(AbortSignal));
  f.media.currentTime = 4;
  await vi.waitFor(() => expect(Source.instances[0].buffer.appended.at(-1)).toBeLessThan(45));
  expect(f.get).toHaveBeenCalledWith(expect.stringContaining("/seek?time=4"), expect.any(AbortSignal));
  expect(f.error).not.toHaveBeenCalled();
});

it("starts synchronized DJ audio while most of the track has not been requested", async () => {
  const f = fixture("dj"); await f.load();
  await vi.waitFor(() => expect(Source.instances[0].buffer.appended).toContain(2));
  expect(f.media.play).toHaveBeenCalled(); expect(f.requests.length).toBeLessThan(30);
  expect(f.media.src).toMatch(/^blob:/); expect(f.error).not.toHaveBeenCalled();
});

it("uses ManagedMediaSource when ordinary MSE is absent and restores the element on exit", async () => {
  vi.stubGlobal("MediaSource", undefined); vi.stubGlobal("ManagedMediaSource", Source);
  const f = fixture(); await f.load();
  expect(f.media.disableRemotePlayback).toBe(true);
  f.player.destroy(); expect(f.media.disableRemotePlayback).toBe(false); expect(f.media.src).toBe("");
});

it("ignores a late initialization response after account exit without restoring source or error", async () => {
  const f = fixture(); const delayed = deferred<Response>(); f.fetcher.mockImplementationOnce(() => delayed.promise);
  const loading = f.load(); await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce());
  f.player.destroy(); delayed.resolve(new Response(initialization, { status: 206 })); await loading;
  expect(f.media.src).toBe(""); expect(URL.createObjectURL).not.toHaveBeenCalled(); expect(f.error).not.toHaveBeenCalled();
});

it("does not let an old seek response overwrite a newer seek", async () => {
  const f = fixture(); await f.load();
  await vi.waitFor(() => expect(Source.instances[0].buffer.appended.length).toBeGreaterThan(1));
  const delayed = deferred<ReturnType<typeof index>>();
  f.get.mockImplementation(async path => path.endsWith("time=90") ? delayed.promise : index(path));
  const previous = Source.instances[0].buffer.appended.length;
  f.media.currentTime = 90; await vi.waitFor(() => expect(f.get).toHaveBeenCalledWith(expect.stringContaining("time=90"), expect.anything()));
  f.media.currentTime = 80;
  delayed.resolve(index("/seek?time=90"));
  await vi.waitFor(() => expect(Source.instances[0].buffer.appended).toContain(40));
  expect(Source.instances[0].buffer.appended[previous]).toBe(40); expect(f.error).not.toHaveBeenCalled();
});

it("fails closed on a truncated range and can recover by reopening the same media", async () => {
  const f = fixture();
  f.fetcher.mockImplementationOnce(async () => new Response(initialization, { status: 206 }));
  f.fetcher.mockImplementationOnce(async () => new Response(new Uint8Array([1]), { status: 206 }));
  await f.load(); await vi.waitFor(() => expect(f.error).toHaveBeenCalledWith("Media range was interrupted")); expect(f.media.src).toBe("");
  await f.load(); await vi.waitFor(() => expect(f.media.readyState).toBe(2)); expect(f.error).toHaveBeenCalledOnce();
});

it("stops on revoked seek authorization and rejects stale DJ play failure after teardown", async () => {
  const f = fixture("dj"); const playing = deferred<void>(); f.media.play.mockImplementation(() => playing.promise);
  await f.load(); await vi.waitFor(() => expect(f.media.play).toHaveBeenCalled());
  f.get.mockRejectedValue(new ApiError(401, "session revoked"));
  f.media.currentTime = 90;
  await vi.waitFor(() => expect(f.error).toHaveBeenCalledWith("session revoked"));
  expect(f.media.src).toBe(""); playing.reject(new Error("late autoplay rejection"));
  await Promise.resolve(); expect(f.error).toHaveBeenCalledOnce();
});

it("rejects a server that ignores Range instead of downloading the whole object", async () => {
  const f = fixture(); const cancelled = vi.fn();
  f.fetcher.mockImplementationOnce(async () => new Response(new ReadableStream({ cancel: cancelled }), { status: 200 }));
  await f.load(); expect(f.error).toHaveBeenCalledWith("Media range unavailable (200)");
  expect(cancelled).toHaveBeenCalledOnce(); expect(URL.createObjectURL).not.toHaveBeenCalled();
});

it("drains an active removal before applying a superseding seek", async () => {
  const f = fixture(); await f.load();
  const buffer = Source.instances[0].buffer;
  await vi.waitFor(() => expect(buffer.appended).toContain(15));
  buffer.holdRemoval = true;
  f.media.currentTime = 90;
  await vi.waitFor(() => expect(buffer.pendingUpdate).toBeDefined());
  f.media.currentTime = 80;
  await new Promise(resolve => setTimeout(resolve, 5));
  expect(f.error).not.toHaveBeenCalled();
  buffer.holdRemoval = false; buffer.complete();
  await vi.waitFor(() => expect(buffer.appended).toContain(40));
  expect(f.error).not.toHaveBeenCalled();
});

it("drains an active append before resetting for a seek", async () => {
  const f = fixture(); await f.load();
  const buffer = Source.instances[0].buffer;
  await vi.waitFor(() => expect(buffer.appended).toContain(15));
  buffer.holdAppend = true;
  f.media.currentTime = 90;
  await vi.waitFor(() => expect(buffer.pendingUpdate).toBeDefined());
  buffer.holdRemoval = true;
  f.media.currentTime = 80;
  await new Promise(resolve => setTimeout(resolve, 5));
  expect(f.error).not.toHaveBeenCalled();
  buffer.holdAppend = false; buffer.complete();
  await vi.waitFor(() => expect(buffer.active).toBe("remove"));
  buffer.holdRemoval = false; buffer.complete();
  await vi.waitFor(() => expect(buffer.appended).toContain(40));
  expect(f.error).not.toHaveBeenCalled();
});

it("refetches the current fragment when ManagedMediaSource evicts while the producer waits ahead", async () => {
  vi.stubGlobal("ManagedMediaSource", Source);
  const f = fixture(); await f.load(); const buffer = Source.instances[0].buffer;
  await vi.waitFor(() => expect(buffer.appended).toContain(15));
  const previous = buffer.appended.length;
  buffer.values = []; buffer.dispatchEvent(new Event("bufferedchange")); f.media.dispatchEvent(new Event("waiting"));
  await vi.waitFor(() => expect(buffer.appended.length).toBeGreaterThan(previous));
  expect(buffer.appended[previous]).toBe(0); expect(f.error).not.toHaveBeenCalled();
});

it("completes a slow DJ late-join seek without clock ticks repeatedly cancelling it", async () => {
  const f = fixture("dj"); f.snapshot.playback.position_ms = 90000;
  let cancelled = 0;
  f.get.mockImplementation(async (path, signal) => {
    if (!path.includes("/seek?")) return f.snapshot as never;
    if (!path.endsWith("time=0")) {
      signal?.addEventListener("abort", () => { cancelled++; }, { once: true });
      await new Promise(resolve => setTimeout(resolve, 800));
    }
    return index(path);
  });
  await f.load();
  await vi.waitFor(() => expect(Source.instances[0].buffer.appended).toContain(45), { timeout: 2000 });
  expect(cancelled).toBe(0); expect(f.error).not.toHaveBeenCalled();
  // A deliberate shared seek still supersedes the old playback revision.
  (f.player as DjPlayer).update({ ...f.snapshot, revision: 2, playback: { ...f.snapshot.playback, position_ms: 7000, anchored_at_ms: Date.now(), playing: false } });
  await vi.waitFor(() => expect(Source.instances[0].buffer.appended).toContain(3), { timeout: 2000 });
});

it("keeps an existing ready Ogg queue playable through the explicit legacy-only path", async () => {
  const f = fixture("dj");
  f.get.mockImplementation(async path => { if (path.includes("/seek?")) throw new ApiError(409, "legacy_dj_ogg"); return f.snapshot as never; });
  f.fetcher.mockImplementation(async request => {
    expect(request.headers.get("authorization")).toBe("Bearer fixture-token");
    return new Response(new Uint8Array([79, 103, 103, 83]), { status: 200 });
  });
  await f.load(); await vi.waitFor(() => expect(f.media.src).toMatch(/^blob:/));
  expect(URL.createObjectURL).toHaveBeenCalledWith(expect.any(Blob)); expect(f.error).not.toHaveBeenCalled();
  f.player.destroy(); expect(f.media.src).toBe(""); expect(URL.revokeObjectURL).toHaveBeenCalled();
});

it("reports a legacy Ogg decoder failure once and clears playback and late handlers", async () => {
  const f = fixture("dj");
  f.get.mockImplementation(async path => { if (path.includes("/seek?")) throw new ApiError(409, "legacy_dj_ogg"); return f.snapshot as never; });
  f.fetcher.mockImplementation(async () => new Response(new Uint8Array([79, 103, 103, 83]), { status: 200 }));
  await f.load(); await vi.waitFor(() => expect(f.media.src).toMatch(/^blob:/));
  f.media.dispatchEvent(new Event("error"));
  expect(f.error).toHaveBeenCalledWith("DJ audio cannot be decoded on this device");
  expect(f.media.src).toBe(""); expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
  f.media.dispatchEvent(new Event("error")); expect(f.error).toHaveBeenCalledOnce();
});
