import { afterEach, expect, it, vi } from "vitest";
import type { Api } from "../src/transport/api";
import { availableVoiceInputs, VoiceSession, type VoiceStatus } from "../src/transport/voice";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function track(kind: string) {
  return { kind, readyState: "live", enabled: true, onended: null,
    stop: vi.fn(), applyConstraints: vi.fn(async () => {}) } as unknown as MediaStreamTrack;
}
function stream(tracks: MediaStreamTrack[]) {
  return { getTracks: () => tracks, getAudioTracks: () => tracks.filter(t => t.kind === "audio"),
    getVideoTracks: () => tracks.filter(t => t.kind === "video") } as MediaStream;
}
class Peer extends EventTarget {
  static created: Peer[] = [];
  connectionState = "connected";
  iceGatheringState = "complete";
  localDescription: RTCSessionDescriptionInit | null = null;
  ontrack = null;
  onconnectionstatechange = null;
  close = vi.fn();
  senders: { track: MediaStreamTrack | null; replaceTrack: ReturnType<typeof vi.fn>;
    getParameters: () => { encodings: {}[] }; setParameters: ReturnType<typeof vi.fn> }[] = [];
  constructor() { super(); Peer.created.push(this); }
  addTransceiver(value: MediaStreamTrack | string) {
    const sender = { track: typeof value === "string" ? null : value,
      replaceTrack: vi.fn(async () => {}), getParameters: () => ({ encodings: [{}] }), setParameters: vi.fn(async () => {}) };
    this.senders.push(sender);
  }
  getSenders() { return this.senders; }
  getTransceivers() { return this.senders.map(sender => ({ sender, receiver: { track: { kind: sender.track?.kind ?? "video" } } })); }
  createDataChannel() { return { onmessage: null, close: vi.fn(), send: vi.fn() }; }
  async createOffer() { return { type: "offer", sdp: "v=0\r\n" }; }
  async setLocalDescription(value: RTCSessionDescriptionInit) { this.localDescription = value; }
  async setRemoteDescription() {}
  getStats = vi.fn(async () => new Map());
}
const sessions: VoiceSession[] = [];
function fixture(capture: () => Promise<MediaStream>, post = vi.fn(async () => ({ peer_id: "1" as string | number, answer: { type: "answer", sdp: "v=0" } }))) {
  Peer.created = [];
  vi.stubGlobal("RTCPeerConnection", Peer);
  const media = { getUserMedia: vi.fn(capture), getDisplayMedia: vi.fn(capture), enumerateDevices: vi.fn(async () => []) };
  vi.stubGlobal("navigator", { mediaDevices: media });
  const updates: VoiceStatus[] = [];
  const remove = vi.fn(async () => {});
  const session = new VoiceSession({ post, delete: remove } as unknown as Api, value => updates.push(value));
  sessions.push(session);
  return { session, media, updates, post, remove };
}
afterEach(() => { for (const session of sessions.splice(0)) session.close(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it("stops delayed capture after account teardown without opening a peer", async () => {
  const pending = deferred<MediaStream>();
  const audio = track("audio");
  const { session, updates, post } = fixture(() => pending.promise);
  const joining = session.join("room", false);
  session.close();
  pending.resolve(stream([audio]));
  await joining;
  expect(audio.stop).toHaveBeenCalledOnce();
  expect(Peer.created).toHaveLength(0);
  expect(post).not.toHaveBeenCalled();
  expect(updates.at(-1)?.phase).toBe("idle");
});

it("joins audio-only with selected microphone and retains a video slot for explicit screen sharing", async () => {
  const { session, media } = fixture(async () => stream([track("audio")]));
  await session.join("room", false, { microphone: "chosen-mic", camera: "unused-camera" });
  expect(media.getUserMedia).toHaveBeenCalledWith({ audio: expect.objectContaining({ deviceId: { exact: "chosen-mic" }, noiseSuppression: false }), video: false });
  expect(Peer.created[0].senders).toHaveLength(2);
  expect(Peer.created[0].senders[1].track).toBeNull();
});

it("does not publish a screen selected after leaving the call", async () => {
  const { session, media, updates } = fixture(async () => stream([track("audio")]));
  await session.join("room", false);
  const pending = deferred<MediaStream>();
  media.getDisplayMedia.mockImplementation(() => pending.promise);
  const screen = track("video");
  const sharing = session.screenShare();
  const sender = Peer.created[0].senders[1];
  session.close();
  pending.resolve(stream([screen]));
  await sharing;
  expect(screen.stop).toHaveBeenCalledOnce();
  expect(sender.replaceTrack).not.toHaveBeenCalled();
  expect(updates.at(-1)?.phase).toBe("idle");
});

it("ignores a delayed server join after teardown", async () => {
  const pending = deferred<{ peer_id: string; answer: { type: string; sdp: string } }>();
  const { session, updates, post } = fixture(async () => stream([track("audio")]), vi.fn(() => pending.promise));
  const joining = session.join("room", false);
  await vi.waitFor(() => expect(post).toHaveBeenCalledOnce());
  session.close();
  pending.resolve({ peer_id: "old-peer", answer: { type: "answer", sdp: "v=0" } });
  await joining;
  expect(updates.at(-1)?.phase).toBe("idle");
  expect(updates.at(-1)?.peerId).toBeUndefined();
});

it("drops stale statistics and rejects nonfinite bitrate", async () => {
  vi.useFakeTimers();
  const { session, updates } = fixture(async () => stream([track("audio")]));
  await session.join("room", false);
  const pending = deferred<Map<string, unknown>>();
  Peer.created[0].getStats.mockImplementation(() => pending.promise);
  await vi.advanceTimersByTimeAsync(1000);
  session.close();
  pending.resolve(new Map([["inbound", { type: "inbound-rtp", bytesReceived: 999 }]]));
  await Promise.resolve();
  expect(updates.at(-1)?.receivedBytes).toBe(0);
  await expect(session.setAudio(Number.NaN, false)).rejects.toThrow("Opus bitrate");
});

it("enumerates input devices without starting capture", async () => {
  const { media } = fixture(async () => stream([]));
  media.enumerateDevices.mockResolvedValue([
    { deviceId: "mic", label: "", kind: "audioinput" },
    { deviceId: "speaker", label: "speaker", kind: "audiooutput" },
  ] as never);
  expect(await availableVoiceInputs()).toEqual([{ id: "mic", label: "", kind: "audioinput" }]);
  expect(media.getUserMedia).not.toHaveBeenCalled();
});

it("preserves SFU source peer identity for VM media and clears it on teardown", async () => {
  const { session, updates } = fixture(async () => stream([track("audio")]));
  vi.stubGlobal("MediaStream", class {
    id = "received-stream";
    constructor(private tracks: MediaStreamTrack[]) {}
    getTracks() { return this.tracks; }
    getVideoTracks() { return this.tracks.filter(t => t.kind === "video"); }
  });
  await session.join("room", false);
  const incoming = track("video");
  (Peer.created[0].ontrack as unknown as (event: unknown) => void)({ track: incoming, streams: [{ id: "7" }] });
  expect(updates.at(-1)?.sourcePeers?.["received-stream"]).toBe("7");
  expect(updates.at(-1)?.streams).toHaveLength(1);
  session.close();
  expect(updates.at(-1)?.streams).toEqual([]);
  expect(updates.at(-1)?.sourcePeers).toBeUndefined();
});

it("deletes numeric peer zero when leaving the first server call", async () => {
  const { session, updates, remove } = fixture(async () => stream([track("audio")]),
    vi.fn(async () => ({ peer_id: 0, answer: { type: "answer", sdp: "v=0" } })));
  await session.join("room", false);
  expect(updates.at(-1)?.peerId).toBe("0");
  await session.leave();
  expect(remove).toHaveBeenCalledExactlyOnceWith("/api/channels/room/voice/0");
  expect(updates.at(-1)?.phase).toBe("idle");
});
