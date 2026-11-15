import { canControlLocalAudio, type CallMedia } from "../src/core/call";
import { splitStageMedia } from "../src/ui/call/stageMedia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stageGrid } from "../src/ui/call/stageGrid";
import { personCardPosition } from "../src/ui/people/position";
import { LivePress } from "../src/ui/people/livePress";

describe("stage geometry in the actual available viewport", () => {
  it("caps one tile, stacks two in a narrow center, and fits four in two columns", () => {
    expect(stageGrid(1, 1200, 700)).toEqual({ cols: 1, tile: 640 });
    expect(stageGrid(2, 680, 650)).toEqual({ cols: 1, tile: 567 });
    expect(stageGrid(4, 680, 650)).toEqual({ cols: 2, tile: 334 });
  });
  it("never invents unavailable width or height at any count or resize", () => {
    for (const width of [100, 358, 540, 640, 680, 1200]) for (const height of [120, 320, 540, 650]) for (let count = 1; count <= 12; count++) {
      const { cols, tile } = stageGrid(count, width, height);
      const rows = Math.ceil(count / cols);
      expect(tile).toBeLessThanOrEqual(640);
      expect(cols * tile + (cols - 1) * 12).toBeLessThanOrEqual(width);
      expect(rows * tile * 9 / 16 + (rows - 1) * 12).toBeLessThanOrEqual(height);
    }
    expect(stageGrid(0, 0, 0)).toEqual({ cols: 1, tile: 0 });
    expect(stageGrid(9, 1, 1).tile).toBeGreaterThanOrEqual(0);
  });
});

describe("person popover placement", () => {
  it("opens beside either source column and clamps both axes inside eight pixels", () => {
    expect(personCardPosition({ left: 30, right: 240, top: 100 }, 300, 1280, 800, false)).toEqual({ left: 248, top: 100 });
    expect(personCardPosition({ left: 980, right: 1240, top: 700 }, 300, 1280, 800, true)).toEqual({ left: 692, top: 492 });
    expect(personCardPosition({ left: -40, right: 2000, top: -50 }, 300, 390, 844, false)).toEqual({ left: 102, top: 8 });
  });
});

describe("live touch hold", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it("opens at 450ms, then swallows exactly the following click", () => {
    const press = new LivePress(), open = vi.fn();
    press.start(10, 20, open); vi.advanceTimersByTime(449); expect(open).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(open).toHaveBeenCalledTimes(1); press.cancel();
    expect(press.consumeClick()).toBe(true); expect(press.consumeClick()).toBe(false);
  });
  it("leaves short taps alone and cancels at eight pixels, pointer cancellation, or unmount", () => {
    const press = new LivePress(), open = vi.fn();
    press.start(10, 20, open); vi.advanceTimersByTime(449); press.cancel(); vi.advanceTimersByTime(100);
    expect(open).not.toHaveBeenCalled(); expect(press.consumeClick()).toBe(false);
    press.start(10, 20, open); press.move(18, 20); vi.advanceTimersByTime(500); expect(open).not.toHaveBeenCalled();
    press.start(10, 20, open); press.move(10, 28); vi.advanceTimersByTime(500); expect(open).not.toHaveBeenCalled();
    press.start(10, 20, open); press.cancel(); vi.advanceTimersByTime(500); expect(open).not.toHaveBeenCalled();
  });
  it("permits sub-threshold movement and replaces an earlier pending hold", () => {
    const press = new LivePress(), first = vi.fn(), second = vi.fn();
    press.start(0, 0, first); vi.advanceTimersByTime(300); press.start(0, 0, second); press.move(3, 4);
    vi.advanceTimersByTime(450); expect(first).not.toHaveBeenCalled(); expect(second).toHaveBeenCalledTimes(1);
  });
});


describe("established call recovery", () => {
  it("allows local audio during recovery, but not initial connection or failure", () => {
    expect(canControlLocalAudio({ phase: "connecting" })).toBe(false);
    expect(canControlLocalAudio({ phase: "connecting", reconnecting: true })).toBe(true);
    expect(canControlLocalAudio({ phase: "live", reconnecting: true })).toBe(true);
    expect(canControlLocalAudio({ phase: "failed", reconnecting: true })).toBe(false);
    expect(canControlLocalAudio({ phase: "idle" })).toBe(false);
  });
});

describe("separate person and screen receivers", () => {
  const media = [{ id: "voice", video: false }, { id: "camera-slot", video: true },
    { id: "screen-audio-slot", video: false, share: true }] as CallMedia[];
  it("does not infer a screen from reserved audio or camera receivers", () => {
    expect(splitStageMedia(media, false)).toEqual({ person: media, stream: [] });
    expect(splitStageMedia(media.filter(item => !item.video), false).stream).toEqual([]);
  });
  it("assigns each receiver once: voice to the person, picture and screen audio to the screen", () => {
    const split = splitStageMedia(media, true);
    expect(split.person.map(item => item.id)).toEqual(["voice"]);
    expect(split.stream.map(item => item.id)).toEqual(["camera-slot", "screen-audio-slot"]);
    expect(new Set([...split.person, ...split.stream]).size).toBe(media.length);
  });
});

// Failure diagnostics may inspect real transport responses, but may persist only public fields.
describe("phase4 voice diagnostic allowlist", () => {
  it("retains peer identity, timeout/backpressure and worker evidence without response secrets", async () => {
    const { voiceSummary } = await import("./e2e/phase4Diagnostics");
    const secret = "do-not-persist-session-device-sdp-or-headers";
    const summary = voiceSummary("stats", { token: secret, peers: [{
      peer_id: 7, user_id: "synthetic-user", connected: false, session: secret, device_key: secret,
      diagnostics: { ice_state: "disconnected", pending_offer_ms: 15000, signaling_backpressure: 2, sdp: secret },
      recent_disconnects: [{ peer_id: 6, reason: "signaling_answer_timeout", age_ms: 30, session: secret, diagnostics: { outgoing_waiting: 4, headers: secret } }],
      worker: { max_iteration_us: 25000, ingress_dropped: 1, authorization: secret },
    }] }, "room");
    expect(summary).toMatchObject({ peers: [{ peer_id: 7, user_id: "synthetic-user", diagnostics: { pending_offer_ms: 15000, signaling_backpressure: 2 }, recent_disconnects: [{ peer_id: 6, reason: "signaling_answer_timeout", diagnostics: { outgoing_waiting: 4 } }], worker: { max_iteration_us: 25000, ingress_dropped: 1 } }] });
    expect(JSON.stringify(summary)).not.toContain(secret);
  });

  it("scopes room identity/state and strips the SDP answer from join diagnostics", async () => {
    const { voiceSummary } = await import("./e2e/phase4Diagnostics");
    expect(voiceSummary("rooms", { rooms: { room: ["one", "two"], other: ["unrelated"] }, states: { room: [{ user_id: "two", sharing: true, token: "secret" }] } }, "room"))
      .toEqual({ room: "room", users: ["one", "two"], states: [{ user_id: "two", sharing: true }] });
    expect(voiceSummary("join", { peer_id: 8, answer: { sdp: "secret" }, device_key: "secret" }, "room")).toEqual({ peer_id: 8 });
    expect(voiceSummary("stats", { error: "secret" }, "room")).toEqual({ peers: [] });
  });
});

it("bounds and sanitizes native signaling probes while preserving calls, promises and cleanup", async () => {
  const { installPhase4PcProbe } = await import("./e2e/phase4Diagnostics");
  const secret = "never-persist-SDP-payload-error-details";
  const failure = new DOMException(secret, "OperationError");
  let result = Promise.resolve({ type: "answer", sdp: secret });
  let sendFailure: Error | null = null;
  const nativeSend = vi.fn(function (this: Channel, _data: unknown) {
    if (sendFailure) throw sendFailure;
    this.bufferedAmount = 42;
  });
  class Channel extends EventTarget {
    bufferedAmount = 0;
    readyState = "open";
    send = nativeSend;
    constructor(public label: string) { super(); }
  }
  const nativeSdp = vi.fn(function (this: Peer, ..._args: unknown[]) { return result; });
  class Peer extends EventTarget {
    connectionState = "connected"; iceConnectionState = "connected";
    iceGatheringState = "complete"; signalingState = "stable";
    localDescription = { type: "answer", sdp: secret }; remoteDescription = this.localDescription;
    createOffer = nativeSdp; createAnswer = nativeSdp;
    setLocalDescription = nativeSdp; setRemoteDescription = nativeSdp;
    createDataChannel(label: string) { return new Channel(label); }
    close() { this.signalingState = "closed"; }
  }
  const scope = Object.assign(new EventTarget(), { RTCPeerConnection: Peer, __phase4PcEvents: [] as Record<string, unknown>[], __phase4Channels: [] as Record<string, unknown>[] });
  vi.stubGlobal("window", scope);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    installPhase4PcProbe();
    const pc = new scope.RTCPeerConnection();
    const input = { type: "offer", sdp: secret }, options = { iceRestart: true };
    expect(pc.setRemoteDescription(input)).toBe(result);
    expect(nativeSdp).toHaveBeenLastCalledWith(input);
    expect(nativeSdp.mock.contexts.at(-1)).toBe(pc);
    await result;
    expect(pc.createOffer(options)).toBe(result); await result;
    expect(nativeSdp).toHaveBeenLastCalledWith(options);
    result = Promise.reject(failure);
    const rejected = pc.createAnswer(); expect(rejected).toBe(result);
    await expect(rejected).rejects.toBe(failure);
    const dc = pc.createDataChannel("housecall-signaling"), other = pc.createDataChannel("other");
    expect(other.send).toBe(nativeSend);
    expect(dc.send(secret)).toBeUndefined();
    expect(nativeSend.mock.contexts.at(-1)).toBe(dc);
    expect(nativeSend).toHaveBeenLastCalledWith(secret);
    dc.dispatchEvent(new MessageEvent("message", { data: secret }));
    sendFailure = failure;
    expect(() => dc.send(secret)).toThrow(failure);
    expect(scope.__phase4Channels).toMatchObject([{ sent: 1, received: 1, throws: 1, sentBytes: secret.length, receivedBytes: secret.length }]);
    await vi.advanceTimersByTimeAsync(10000);
    expect(scope.__phase4PcEvents.filter(event => event.event === "buffer-drain")).toHaveLength(3);
    expect(scope.__phase4PcEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "sdp-complete", operation: "setRemoteDescription", bytes: secret.length }),
      expect.objectContaining({ event: "sdp-reject", error: "OperationError" }),
      expect.objectContaining({ event: "send-entry", bufferedAmount: 0 }),
      expect.objectContaining({ event: "send-return", bufferedAmount: 42 }),
      expect.objectContaining({ event: "send-throw", error: "OperationError" }),
    ]));
    expect(scope.__phase4PcEvents.every(event => Number(event.at) > 1e12)).toBe(true);
    expect(JSON.stringify([scope.__phase4PcEvents, scope.__phase4Channels])).not.toContain(secret);
    sendFailure = null; dc.send(secret); expect(vi.getTimerCount()).toBe(1);
    pc.close(); expect(vi.getTimerCount()).toBe(0);
    for (let index = 0; index < 600; index++) pc.dispatchEvent(new Event("icegatheringstatechange"));
    expect(scope.__phase4PcEvents).toHaveLength(512);
    expect(scope.__phase4PcEvents.at(-1)).toMatchObject({ event: "icegatheringstatechange", peer: 0, gathering: "complete" });
    expect(JSON.stringify(scope.__phase4PcEvents)).not.toContain(secret);
  } finally { vi.useRealTimers(); vi.unstubAllGlobals(); }
});
