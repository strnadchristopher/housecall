import { useEffect, useMemo, useState } from "react";
import type { CallTransport } from "../../core/call";
import { VoiceSession, availableVoiceInputs, type VoiceDevice, type VoiceInputs, type VoiceStatus } from "../../transport/voice";
import type { Housecall } from "./chat";

interface Peer {
  peer_id: number;
  user_id: string;
  connected: boolean;
  publisher: boolean;
  current_session: boolean;
}

const idle: VoiceStatus = { phase: "idle", streams: [], receivedBytes: 0, decodedFrames: 0 };

/** CallTransport over the current SFU (transport/voice.ts). Replaced by adapters/livekit in Phase 3. */
export function useLegacyCall(c: Housecall) {
  const [status, setStatus] = useState<VoiceStatus>(idle);
  const voice = useMemo(() => new VoiceSession(c.api, setStatus), [c.api]);
  const [channelId, setChannelId] = useState<string>();
  const [joinedAt, setJoinedAt] = useState<number>();
  const [muted, setMuted] = useState(false);
  const [deafened, setDeafened] = useState(false);
  const [camera, setCamera] = useState(false);
  const [error, setError] = useState("");
  const [devices, setDevices] = useState<VoiceDevice[]>([]);
  const [selected, setSelected] = useState<VoiceInputs>({});
  const [bitrate, setBitrate] = useState(510000);
  const [noiseSuppression, setNoiseSuppression] = useState(false);
  const [peers, setPeers] = useState<Peer[]>([]);

  const reset = () => { setMuted(false); setDeafened(false); setCamera(false); setChannelId(undefined); setJoinedAt(undefined); setPeers([]); };
  useEffect(() => () => voice.close(), [voice]);
  useEffect(() => {
    if (!c.auth) { voice.close(); reset(); setSelected({}); setDevices([]); setError(""); }
  }, [c.auth, voice]);

  // The server reports who is in a call only to a session that is in it.
  useEffect(() => {
    if (status.phase !== "live" || !channelId) { setPeers([]); return; }
    let stopped = false;
    const tick = async () => {
      try {
        const result = await c.api.get<{ peers: Peer[] }>(`/api/channels/${channelId}/voice/stats`);
        if (!stopped) setPeers(result.peers);
      } catch { /* keep the last roster; the next tick retries */ }
    };
    void tick();
    const timer = setInterval(() => void tick(), 2000);
    return () => { stopped = true; clearInterval(timer); };
  }, [status.phase, channelId, c.api]);

  const fail = (reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason));
  const nameOf = (id: string) => c.members.find(member => member.id === id)?.username ?? id;
  const publishers = new Set(peers.filter(peer => peer.publisher).map(peer => String(peer.peer_id)));
  const members = peers.filter(peer => !peer.publisher);
  const active = status.phase !== "idle";

  const transport: CallTransport = {
    available: c.capabilities.voice === true,
    phase: status.phase,
    conversationId: active ? channelId : undefined,
    conversationName: active ? c.channels.find(channel => channel.id === channelId)?.name : undefined,
    participants: status.phase !== "live" ? []
      : members.length ? members.map(peer => ({ id: String(peer.peer_id), personId: peer.user_id, name: nameOf(peer.user_id), me: peer.current_session, connected: peer.connected }))
      : c.auth ? [{ id: status.peerId ?? "self", personId: c.auth.user.id, name: c.auth.user.username, me: true, connected: true }] : [],
    media: status.streams
      .filter(stream => !publishers.has(status.sourcePeers?.[stream.id] ?? ""))
      .map(stream => ({ id: stream.id, stream, participantId: status.sourcePeers?.[stream.id] || undefined, video: stream.getVideoTracks().length > 0 })),
    joinedAt: status.phase === "live" ? joinedAt : undefined,
    muted, deafened, camera,
    sharing: voice.sharing,
    error: error || (status.phase === "failed" ? status.error ?? "" : ""),
    devices: devices.map(device => ({ id: device.id, label: device.label, kind: device.kind === "audioinput" ? "microphone" as const : "camera" as const })),
    selected, bitrate, noiseSuppression,
    stats: { receivedBytes: status.receivedBytes, decodedFrames: status.decodedFrames },

    join: async conversationId => {
      setError(""); setMuted(false); setDeafened(false); setCamera(false); setPeers([]);
      setChannelId(conversationId);
      try {
        await voice.join(conversationId, false, selected);
        setJoinedAt(Date.now());
      } catch (reason) { fail(reason); }
    },
    leave: async () => {
      try { await voice.leave(); } catch (reason) { fail(reason); }
      reset();
    },
    setMuted: next => { voice.mute(next); setMuted(next); },
    setDeafened: next => setDeafened(next),
    setCamera: async on => {
      setError("");
      try { await voice.camera(on, selected.camera); setCamera(on); } catch (reason) { fail(reason); }
    },
    setSharing: async on => {
      setError("");
      try {
        if (on) await voice.screenShare(); else voice.stopScreenShare();
        setStatus(current => ({ ...current }));
      } catch (reason) { if (!(reason instanceof DOMException && reason.name === "NotAllowedError")) fail(reason); }
    },
    refreshDevices: async () => { try { setDevices(await availableVoiceInputs()); } catch (reason) { fail(reason); } },
    selectDevices: next => setSelected(next),
    setAudio: async (nextBitrate, nextNoise) => {
      setError("");
      try {
        await voice.setAudio(nextBitrate, nextNoise);
        setBitrate(nextBitrate); setNoiseSuppression(nextNoise);
      } catch (reason) { fail(reason); }
    },
  };
  return { transport, status, live: status.phase === "live" && channelId === c.channel };
}
