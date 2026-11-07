import type { Api } from "./api";
export interface VoiceStatus {
  phase: "idle" | "connecting" | "live" | "failed";
  peerId?: string;
  streams: MediaStream[];
  receivedBytes: number;
  decodedFrames: number;
  roundTripSeconds?: number;
  error?: string;
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
async function gathered(pc: RTCPeerConnection) {
  if (pc.iceGatheringState === "complete") return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      pc.removeEventListener("icegatheringstatechange", listener);
      reject(new Error("ICE gathering timed out"));
    }, 10000);
    const listener = () => {
      if (pc.iceGatheringState === "complete") {
        clearTimeout(timer);
        pc.removeEventListener("icegatheringstatechange", listener);
        resolve();
      }
    };
    pc.addEventListener("icegatheringstatechange", listener);
  });
}
export class VoiceSession {
  private pc?: RTCPeerConnection;
  private dc?: RTCDataChannel;
  private local: MediaStream[] = [];
  private screenTrack?:MediaStreamTrack;
  private channelId?: string;
  private timer?: ReturnType<typeof setInterval>;
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
  private queue(work: () => Promise<void>) {
    this.serial = this.serial
      .then(work)
      .catch((error) => this.update({ phase: "failed", error: String(error) }));
  }
  async join(channelId: string, camera = true) {
    this.close();
    this.channelId = channelId;
    this.update({ phase: "connecting", error: undefined, streams: [] });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 2,
          sampleRate: 48000,
          noiseSuppression: false,
          echoCancellation: false,
          autoGainControl: false,
        },
        video: camera
          ? {
              width: { ideal: 1280 },
              height: { ideal: 720 },
              frameRate: { ideal: 30 },
            }
          : false,
      });
      this.local.push(stream);
      const pc = new RTCPeerConnection({
        iceServers: [],
        bundlePolicy: "max-bundle",
      });
      this.pc = pc;
      for (const track of stream.getTracks())
        pc.addTransceiver(track, { direction: "sendonly", streams: [stream] });
      if (!camera) pc.addTransceiver("video", { direction: "sendonly" });
      pc.ontrack = (event) => {
        const remote = new MediaStream([event.track]);
        this.update({ streams: [...this.state.streams, remote] });
        event.track.onended = () =>
          this.update({
            streams: this.state.streams.filter((s) => s !== remote),
          });
      };
      pc.onconnectionstatechange = () =>
        this.update({
          phase:
            pc.connectionState === "connected"
              ? "live"
              : pc.connectionState === "failed"
                ? "failed"
                : "connecting",
        });
      const dc = pc.createDataChannel("chriscord-signaling");
      this.dc = dc;
      dc.onmessage = (event) =>
        this.queue(async () => {
          const description = JSON.parse(
            String(event.data),
          ) as RTCSessionDescriptionInit;
          if (description.type === "offer") {
            await pc.setRemoteDescription(description);
            const answer = await pc.createAnswer();
            await pc.setLocalDescription({
              type: "answer",
              sdp: opusFullband(answer.sdp ?? ""),
            });
            await gathered(pc);
            dc.send(JSON.stringify(pc.localDescription));
          } else if (description.type === "answer")
            await pc.setRemoteDescription(description);
        });
      const offer = await pc.createOffer();
      await pc.setLocalDescription({
        type: "offer",
        sdp: opusFullband(offer.sdp ?? ""),
      });
      await gathered(pc);
      const result = await this.api.post<{
        peer_id: string;
        answer: RTCSessionDescriptionInit;
      }>(`/api/channels/${channelId}/voice/join`, pc.localDescription);
      await pc.setRemoteDescription(result.answer);
      this.update({ peerId: result.peer_id });
      for (const sender of pc.getSenders())
        if (sender.track?.kind === "audio") {
          const parameters = sender.getParameters();
          parameters.encodings = parameters.encodings.length
            ? parameters.encodings
            : [{}];
          for (const encoding of parameters.encodings)
            encoding.maxBitrate = 510000;
          await sender.setParameters(parameters);
        }
      this.timer = setInterval(() => void this.statistics(), 1000);
    } catch (error) {
      this.close();
      this.update({
        phase: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
  async screenShare() {
    if(this.screenTrack?.readyState==='live')throw new Error('Screen sharing is already active; stop it from the capture control first');
    if (!this.pc || this.pc.connectionState !== "connected")
      throw new Error("Join voice before sharing your screen");
    const sender = this.pc
      .getTransceivers()
      .find(
        (transceiver) => transceiver.receiver.track.kind === "video",
      )?.sender;
    if (!sender) throw new Error("A video transceiver is required");
    const original = sender.track;
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: false,
    });
    const track = stream.getVideoTracks()[0];
    try{await sender.replaceTrack(track);}catch(error){track.stop();throw error;}
    this.local.push(stream);this.screenTrack=track;
    track.onended = () => {
      this.screenTrack=undefined;this.local=this.local.filter(local=>local!==stream);
      if (this.pc) void sender.replaceTrack(original).catch(() => {});
    };
  }
  mute(muted: boolean) {
    for (const stream of this.local)
      for (const track of stream.getAudioTracks()) track.enabled = !muted;
  }
  async setAudio(bitrate: number, noiseSuppression: boolean) {
    if (bitrate < 6000 || bitrate > 510000)
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
  private async statistics() {
    if (!this.pc) return;
    let receivedBytes = 0,
      decodedFrames = 0,
      roundTripSeconds: number | undefined;
    for (const report of (await this.pc.getStats()).values()) {
      if (report.type === "inbound-rtp") {
        receivedBytes += report.bytesReceived ?? 0;
        decodedFrames += report.framesDecoded ?? 0;
      }
      if (report.type === "candidate-pair" && report.state === "succeeded")
        roundTripSeconds = report.currentRoundTripTime;
    }
    this.update({ receivedBytes, decodedFrames, roundTripSeconds });
  }
  async leave() {
    const peerId = this.state.peerId,
      channel = this.channelId;
    this.close();
    if (peerId && channel)
      await this.api.delete(`/api/channels/${channel}/voice/${peerId}`);
  }
  close() {
    this.screenTrack=undefined;
    clearInterval(this.timer);
    this.dc?.close();
    if (this.pc) {
      this.pc.onconnectionstatechange = null;
      this.pc.ontrack = null;
      this.pc.close();
    }
    this.pc = undefined;
    this.dc = undefined;
    for (const stream of this.local)
      for (const track of stream.getTracks()) track.stop();
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
