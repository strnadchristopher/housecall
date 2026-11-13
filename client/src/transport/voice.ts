import type { Api } from "./api";
import { isSpeaking } from "../core/call";
import { SHARE_PRESETS, applyShareQuality, captureConstraints, clearShareQuality, readShareQuality, shareStreamId, writeShareQuality, type ShareQuality } from "./shareQuality";
export interface VoiceInputs { microphone?: string; camera?: string }
export interface VoiceDevice { id: string; label: string; kind: "audioinput" | "videoinput" }
/** Labels are blank until a capture grant (always so in WebKitGTK). When every label is blank, ask once for the
 *  microphone, release it at once, and list again so names appear. A refusal leaves the blank list as it was. */
export async function availableVoiceInputs(): Promise<VoiceDevice[]> {
  const list = async () => (await navigator.mediaDevices.enumerateDevices())
    .filter(device => device.kind === "audioinput" || device.kind === "videoinput")
    .map(device => ({ id: device.deviceId, label: device.label, kind: device.kind as VoiceDevice["kind"] }));
  let devices = await list();
  if (devices.length > 0 && devices.every(device => !device.label)) {
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
      probe.getTracks().forEach(track => track.stop());
      devices = await list();
    } catch { /* refused or no device: keep the unlabeled list */ }
  }
  return devices;
}
export interface VoiceStatus {
  phase: "idle" | "connecting" | "live" | "failed";
  peerId?: string;
  streams: MediaStream[];
  /** SFU msid is the originating peer ID; values contain no session credential. */
  sourcePeers?: Record<string, string>;
  /** Peer ids whose audio is above the speaking threshold (sampled at 4 Hz). */
  speaking?: string[];
  receivedBytes: number;
  decodedFrames: number;
  roundTripSeconds?: number;
  packetsLost?: number;
  packetsReceived?: number;
  error?: string;
  /** Non-fatal notice, e.g. a saved device was replaced by the default. */
  warning?: string;
  camera?: boolean;
  /** Your share is going out with sound of its own. */
  sharingSound?: boolean;
}
export function opusFullband(sdp: string, bitrate = 510000) {
  const payloads = [...sdp.matchAll(/a=rtpmap:(\d+) opus\/48000/gi)].map(
    (match) => match[1],
  );
  for (const payload of payloads) {
    const expression = new RegExp(`a=fmtp:${payload} ([^\\r\\n]*)`);
    const options = `stereo=1;sprop-stereo=1;maxaveragebitrate=${bitrate};maxplaybackrate=48000`;
    sdp = expression.test(sdp)
      ? sdp.replace(
          expression,
          (_line, existing: string) =>
            `a=fmtp:${payload} ${existing
              .split(";")
              .filter(
                (value) =>
                  !/^\s*(stereo|sprop-stereo|maxaveragebitrate|maxplaybackrate)=/.test(
                    value,
                  ),
              )
              .join(";")};${options}`,
        )
      : sdp.replace(
          new RegExp(`(a=rtpmap:${payload} [^\\r\\n]*\\r?\\n)`),
          `$1a=fmtp:${payload} ${options}\r\n`,
        );
  }
  return sdp;
}
async function gathered(pc: RTCPeerConnection, signal: AbortSignal) {
  signal.throwIfAborted();
  if (pc.iceGatheringState === "complete") return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      pc.removeEventListener("icegatheringstatechange", listener);
      signal.removeEventListener("abort", aborted);
      reject(new Error("ICE gathering timed out"));
    }, 10000);
    const listener = () => {
      if (pc.iceGatheringState === "complete") {
        clearTimeout(timer);
        signal.removeEventListener("abort", aborted);
        pc.removeEventListener("icegatheringstatechange", listener);
        resolve();
      }
    };
    const aborted = () => {
      clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", listener);
      reject(new DOMException("Call ended", "AbortError"));
    };
    signal.addEventListener("abort", aborted, { once: true });
    pc.addEventListener("icegatheringstatechange", listener);
  });
}
const MISSING = new Set(["NotFoundError", "OverconstrainedError", "NotReadableError"]);
const missing = (error: unknown) => error instanceof Error && MISSING.has(error.name);

/** getUserMedia that degrades instead of failing: saved device → default device → no camera. */
export async function acquireMedia(audio: MediaTrackConstraints, video: MediaTrackConstraints | false, inputs: VoiceInputs) {
  const pinned = (base: MediaTrackConstraints, id?: string) => (id ? { ...base, deviceId: { exact: id } } : base);
  const attempts: [MediaTrackConstraints, MediaTrackConstraints | false, string | undefined][] = [
    [pinned(audio, inputs.microphone), video && pinned(video, inputs.camera), undefined],
  ];
  if (inputs.microphone || (video && inputs.camera)) attempts.push([audio, video, "Saved device not found. Using the default device."]);
  if (video) attempts.push([audio, false, "No camera found. Joined with microphone only."]);
  let last: unknown;
  for (const [a, v, warning] of attempts) {
    try { return { stream: await navigator.mediaDevices.getUserMedia({ audio: a, video: v }), warning, camera: !!v }; }
    catch (error) { last = error; if (!missing(error)) throw error; }
  }
  if (missing(last)) throw new Error("No microphone found. Plug one in or allow microphone access, then try again.");
  throw last;
}

export class VoiceSession {
  private generation = 0;
  private cancellation = new AbortController();
  private pc?: RTCPeerConnection;
  private dc?: RTCDataChannel;
  private local: MediaStream[] = [];
  private screenTrack?:MediaStreamTrack;
  /** The capture stream of a share. Kept out of `local` so muting the microphone never mutes the screen's sound. */
  private shareStream?: MediaStream;
  private shareAudio?: RTCRtpSender;
  private shareQualityNow?: ShareQuality;
  private cameraTrack?: MediaStreamTrack;
  private channelId?: string;
  private timer?: ReturnType<typeof setInterval>;
  private levelTimer?: ReturnType<typeof setInterval>;
  private picture?: { track: MediaStreamTrack; stream: MediaStream };
  private serial = Promise.resolve();
  private state: VoiceStatus = {
    phase: "idle",
    streams: [],
    receivedBytes: 0,
    decodedFrames: 0,
  };
  constructor(
    private api: Api,
    private changed: (state: VoiceStatus) => void,
  ) {}
  private update(next: Partial<VoiceStatus>) {
    this.state = { ...this.state, ...next };
    this.changed(this.state);
  }
  private queue(pc: RTCPeerConnection, work: () => Promise<void>) {
    this.serial = this.serial
      .then(async () => { if (this.pc === pc) await work(); })
      .catch((error) => { if (this.pc === pc) { this.close(); this.update({ phase: "failed", error: String(error) }); } });
  }
  async join(channelId: string, camera = true, inputs: VoiceInputs = {}) {
    this.close();
    const generation = this.generation;
    const signal = this.cancellation.signal;
    const current = () => { if (generation !== this.generation) throw new DOMException("Call ended", "AbortError"); };
    this.channelId = channelId;
    this.update({ phase: "connecting", error: undefined, streams: [] });
    try {
      const { stream, warning, camera: cameraOn } = await acquireMedia(
        { channelCount: 2, sampleRate: 48000, noiseSuppression: false, echoCancellation: false, autoGainControl: false },
        camera ? { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } : false,
        inputs,
      );
      if (generation !== this.generation) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      this.local.push(stream);
      this.cameraTrack = stream.getVideoTracks()[0];
      this.update({ warning, camera: cameraOn });
      const pc = new RTCPeerConnection({
        iceServers: [],
        bundlePolicy: "max-bundle",
      });
      this.pc = pc;
      for (const track of stream.getTracks())
        pc.addTransceiver(track, { direction: "sendonly", streams: [stream] });
      if (!cameraOn) pc.addTransceiver("video", { direction: "sendonly" });
      // A third, empty m-line for the sound of a shared screen. It is created now, last, so sharing never
      // renegotiates (that would race the server's offers) and the SFU, which counts a publisher's second
      // audio m-line as share audio, sees it in a fixed place.
      this.shareAudio = pc.addTransceiver("audio", { direction: "sendonly" }).sender;
      pc.ontrack = (event) => {
        if (this.pc !== pc) return;
        const remote = new MediaStream([event.track]);
        this.update({ streams: [...this.state.streams, remote], sourcePeers: {
          ...this.state.sourcePeers, [remote.id]: event.streams[0]?.id ?? "",
        } });
        event.track.onended = () => { if (this.pc === pc) this.update({
            streams: this.state.streams.filter((s) => s !== remote),
            sourcePeers: Object.fromEntries(Object.entries(this.state.sourcePeers ?? {}).filter(([id]) => id !== remote.id)),
          }); };
      };
      pc.onconnectionstatechange = () => { if (this.pc !== pc) return;
        this.update({
          phase:
            pc.connectionState === "connected"
              ? "live"
              : pc.connectionState === "failed"
                ? "failed"
                : "connecting",
        }); };
      const dc = pc.createDataChannel("housecall-signaling");
      this.dc = dc;
      dc.onmessage = (event) =>
        this.queue(pc, async () => {
          const description = JSON.parse(
            String(event.data),
          ) as RTCSessionDescriptionInit;
          if (description.type === "offer") {
            await pc.setRemoteDescription(description);
            current();
            const answer = await pc.createAnswer();
            current();
            await pc.setLocalDescription({
              type: "answer",
              sdp: opusFullband(answer.sdp ?? ""),
            });
            await gathered(pc, signal);
            current();
            dc.send(JSON.stringify(pc.localDescription));
          } else if (description.type === "answer")
            await pc.setRemoteDescription(description);
        });
      const offer = await pc.createOffer();
      current();
      await pc.setLocalDescription({
        type: "offer",
        sdp: opusFullband(offer.sdp ?? ""),
      });
      await gathered(pc, signal);
      current();
      const result = await this.api.post<{
        peer_id: string | number;
        answer: RTCSessionDescriptionInit;
      }>(`/api/channels/${channelId}/voice/join`, pc.localDescription);
      current();
      await pc.setRemoteDescription(result.answer);
      current();
      this.update({ peerId: String(result.peer_id) });
      for (const sender of pc.getSenders())
        if (sender.track?.kind === "audio") {
          const parameters = sender.getParameters();
          parameters.encodings = parameters.encodings.length
            ? parameters.encodings
            : [{}];
          for (const encoding of parameters.encodings)
            encoding.maxBitrate = 510000;
          await sender.setParameters(parameters);
          current();
        }
      this.timer = setInterval(() => void this.statistics(), 1000);
      this.levelTimer = setInterval(() => void this.levels(), 250);
    } catch (error) {
      if (generation !== this.generation) return;
      this.close();
      this.update({
        phase: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
  /**
   * Shares a screen or window at the given preset. The picture goes out on the video sender (replacing the
   * camera for the time being); the sound the browser offers with it goes out on its own audio sender.
   */
  async screenShare(quality: ShareQuality = readShareQuality()) {
    if (this.screenTrack?.readyState === "live") throw new Error("Screen sharing is already active; stop it from the capture control first");
    const pc = this.pc;
    if (!pc || pc.connectionState !== "connected") throw new Error("Join voice before sharing your screen");
    const sender = pc.getTransceivers().find(t => t.receiver.track.kind === "video")?.sender;
    if (!sender) throw new Error("A video transceiver is required");
    const original = sender.track;
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: captureConstraints(quality),
      // Raw sound: no echo cancelling, noise suppression or gain, which would flatten music and games.
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const release = () => { for (const item of stream.getTracks()) item.stop(); };
    if (this.pc !== pc) { release(); return; }
    const track = stream.getVideoTracks()[0];
    if (!track) { release(); throw new Error("Screen capture returned no video"); }
    const sound = stream.getAudioTracks()[0];
    const soundSender = this.shareAudio;
    try {
      track.contentHint = SHARE_PRESETS[quality].contentHint;
      await sender.replaceTrack(track);
      await applyShareQuality(sender, track, quality);
      if (sound && soundSender) {
        await soundSender.replaceTrack(sound);
        const parameters = soundSender.getParameters();
        if (!parameters.encodings?.length) parameters.encodings = [{}];
        for (const encoding of parameters.encodings) encoding.maxBitrate = 192000;
        await soundSender.setParameters(parameters);
      }
    } catch (error) { release(); if (this.pc === pc) throw error; return; }
    if (this.pc !== pc) { release(); return; }
    this.shareStream = stream;
    this.screenTrack = track;
    this.shareQualityNow = quality;
    this.update({ sharingSound: !!sound });
    track.onended = () => {
      if (this.pc !== pc || this.screenTrack !== track) return;
      this.screenTrack = undefined;
      this.shareStream = undefined;
      release();
      void soundSender?.replaceTrack(null).catch(() => {});
      this.update({ sharingSound: false });
      const camera = this.cameraTrack?.readyState === "live" ? this.cameraTrack : original?.readyState === "live" ? original : null;
      void sender.replaceTrack(camera).then(() => clearShareQuality(sender)).catch(() => {});
    };
  }
  /** Changes the preset of a share that is already running. */
  async setShareQuality(quality: ShareQuality) {
    writeShareQuality(quality);
    this.shareQualityNow = quality;
    const track = this.screenTrack;
    const sender = this.pc?.getTransceivers().find(t => t.receiver.track.kind === "video")?.sender;
    if (track?.readyState === "live" && sender) await applyShareQuality(sender, track, quality);
  }
  /** Ends a share started by this session and restores the camera, if one is on. */
  stopScreenShare() {
    const track = this.screenTrack;
    if (!track) return;
    track.stop();
    track.onended?.call(track, new Event("ended"));
  }
  get sharing() {
    return this.screenTrack?.readyState === "live";
  }
  get shareQuality(): ShareQuality {
    return this.shareQualityNow ?? readShareQuality();
  }
  /** Turns the camera on or off inside a live call by swapping the outgoing video track. */
  async camera(on: boolean, deviceId?: string) {
    const pc = this.pc;
    if (!pc || pc.connectionState !== "connected") throw new Error("Join the call before turning the camera on");
    const sender = pc.getTransceivers().find(t => t.receiver.track.kind === "video")?.sender;
    if (!sender) throw new Error("A video transceiver is required");
    if (!on) {
      const track = this.cameraTrack ?? (sender.track !== this.screenTrack ? sender.track : null);
      this.cameraTrack = undefined;
      if (track) {
        if (sender.track === track) await sender.replaceTrack(null);
        track.stop();
      }
      return;
    }
    if (this.cameraTrack?.readyState === "live") return;
    const base = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } };
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: deviceId ? { ...base, deviceId: { exact: deviceId } } : base });
    } catch (error) {
      if (!deviceId || !missing(error)) throw error;
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: base });
      this.update({ warning: "Saved camera not found. Using the default camera." });
    }
    const track = stream.getVideoTracks()[0];
    if (this.pc !== pc || !track) { for (const item of stream.getTracks()) item.stop(); return; }
    this.local.push(stream);
    this.cameraTrack = track;
    if (!this.sharing) await sender.replaceTrack(track);
  }
  mute(muted: boolean) {
    for (const stream of this.local)
      for (const track of stream.getAudioTracks()) track.enabled = !muted;
  }
  async setAudio(bitrate: number, noiseSuppression: boolean) {
    if (!Number.isInteger(bitrate) || bitrate < 6000 || bitrate > 510000)
      throw new Error("Opus bitrate must be 6000–510000");
    for (const sender of this.pc?.getSenders() ?? [])
      if (sender.track?.kind === "audio") {
        await sender.track.applyConstraints({
          noiseSuppression,
          channelCount: 2,
          sampleRate: 48000,
        });
        const parameters = sender.getParameters();
        for (const encoding of parameters.encodings)
          encoding.maxBitrate = bitrate;
        await sender.setParameters(parameters);
      }
  }
  /** Your outgoing picture: the screen while sharing, otherwise the camera. The stream is reused while the track is. */
  localPicture(): MediaStream | undefined {
    const track = this.screenTrack?.readyState === "live" ? this.screenTrack : this.cameraTrack?.readyState === "live" ? this.cameraTrack : undefined;
    if (!track) { this.picture = undefined; return undefined; }
    if (this.picture?.track !== track) this.picture = { track, stream: new MediaStream([track]) };
    return this.picture.stream;
  }
  /** Who is speaking, sampled at 4 Hz from audio levels. Only a change notifies the UI. */
  private async levels() {
    const pc = this.pc;
    if (!pc) return;
    let reports: RTCStatsReport;
    try { reports = await pc.getStats(); } catch { return; }
    if (this.pc !== pc) return;
    const owner = new Map<string, string>();
    for (const stream of this.state.streams) {
      const { peer, share } = shareStreamId(this.state.sourcePeers?.[stream.id] ?? "");
      const track = stream.getAudioTracks()[0];
      // A screen's sound is not someone speaking.
      if (peer && track && !share) owner.set(track.id, peer);
    }
    const microphoneOpen = this.local.some(stream => stream.getAudioTracks().some(track => track.enabled));
    const speaking = new Set<string>();
    for (const report of reports.values()) {
      if (report.kind !== "audio" || !isSpeaking(report.audioLevel)) continue;
      if (report.type === "inbound-rtp") { const peer = owner.get(report.trackIdentifier); if (peer) speaking.add(peer); }
      else if (report.type === "media-source" && microphoneOpen && this.state.peerId) speaking.add(this.state.peerId);
    }
    const next = [...speaking].sort();
    const before = this.state.speaking ?? [];
    if (next.length !== before.length || next.some((id, index) => id !== before[index])) this.update({ speaking: next });
  }
  private async statistics() {
    const pc = this.pc;
    if (!pc) return;
    let reports: RTCStatsReport;
    try { reports = await pc.getStats(); } catch { return; }
    if (this.pc !== pc) return;
    let receivedBytes = 0,
      decodedFrames = 0,
      roundTripSeconds: number | undefined,
      packetsLost = 0,
      packetsReceived = 0;
    for (const report of reports.values()) {
      if (report.type === "inbound-rtp") {
        receivedBytes += report.bytesReceived ?? 0;
        decodedFrames += report.framesDecoded ?? 0;
        packetsLost += report.packetsLost ?? 0;
        packetsReceived += report.packetsReceived ?? 0;
      }
      if (report.type === "candidate-pair" && report.state === "succeeded")
        roundTripSeconds = report.currentRoundTripTime;
    }
    this.update({ receivedBytes, decodedFrames, roundTripSeconds, packetsLost, packetsReceived });
  }
  async leave() {
    const peerId = this.state.peerId,
      channel = this.channelId;
    this.close();
    if (peerId && channel)
      await this.api.delete(`/api/channels/${channel}/voice/${peerId}`);
  }
  close() {
    this.generation++;
    this.cancellation.abort();
    this.cancellation = new AbortController();
    this.screenTrack=undefined;
    this.shareStream?.getTracks().forEach(track => { track.onended = null; track.stop(); });
    this.shareStream = undefined;
    this.shareAudio = undefined;
    this.cameraTrack = undefined;
    clearInterval(this.timer);
    clearInterval(this.levelTimer);
    this.picture = undefined;
    if (this.dc) { this.dc.onmessage = null; this.dc.close(); }
    if (this.pc) {
      this.pc.onconnectionstatechange = null;
      this.pc.ontrack = null;
      this.pc.close();
    }
    this.pc = undefined;
    this.dc = undefined;
    for (const stream of this.local)
      for (const track of stream.getTracks()) { track.onended = null; track.stop(); }
    this.local = [];
    this.serial = Promise.resolve();
    this.state = {
      phase: "idle",
      streams: [],
      receivedBytes: 0,
      decodedFrames: 0,
    };
    this.changed(this.state);
  }
}
