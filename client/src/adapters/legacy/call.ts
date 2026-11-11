import { useEffect, useMemo, useRef, useState } from "react";
import type { CallTransport, IncomingCall } from "../../core/call";
import { ApiError } from "../../transport/api";
import { RING_FRESH_MS } from "../../state/callEvents";
import { callKit, isCallKit, onCallKit } from "../../transport/callkit";
import { VoiceSession, availableVoiceInputs, type VoiceDevice, type VoiceInputs, type VoiceStatus } from "../../transport/voice";
import { avatarPath, userName } from "../../data/people";
import { currentUser, type Housecall } from "./chat";

interface Peer {
  peer_id: number;
  user_id: string;
  connected: boolean;
  publisher: boolean;
  current_session: boolean;
}

const idle: VoiceStatus = { phase: "idle", streams: [], receivedBytes: 0, decodedFrames: 0 };
/** The caller gives up this long after ringing, and a decline is shown this long before leaving. */
const UNANSWERED_MS = 45000;
const DECLINED_MS = 4000;

/** CallTransport over the current SFU (transport/voice.ts). Replaced by adapters/livekit in Phase 3. */
export function useLegacyCall(c: Housecall) {
  const [status, setStatus] = useState<VoiceStatus>(idle);
  const voice = useMemo(() => new VoiceSession(c.api, setStatus), [c.api]);
  const [channelId, setChannelId] = useState<string>();
  const [joinedAt, setJoinedAt] = useState<number>();
  const [muted, setMuted] = useState(false);
  const [deafened, setDeafened] = useState(false);
  const mutedBeforeDeafen = useRef(false);
  const [camera, setCamera] = useState(false);
  const [error, setError] = useState("");
  const [devices, setDevices] = useState<VoiceDevice[]>([]);
  const [selected, setSelected] = useState<VoiceInputs>({});
  const [bitrate, setBitrate] = useState(510000);
  const [noiseSuppression, setNoiseSuppression] = useState(false);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [rooms, setRooms] = useState<Record<string, string[]>>({});
  const [incoming, setIncoming] = useState<IncomingCall>();
  const [ringing, setRinging] = useState<{ channelId: string; declined: boolean }>();

  const reset = () => { setMuted(false); setDeafened(false); setCamera(false); setChannelId(undefined); setJoinedAt(undefined); setPeers([]); setRinging(undefined); };
  useEffect(() => () => voice.close(), [voice]);
  useEffect(() => {
    if (!c.auth) { voice.close(); reset(); setSelected({}); setDevices([]); setError(""); }
  }, [c.auth, voice]);

  // Who is in which call, for the list and the call bar before anyone joins.
  const voiceAvailable = c.capabilities.voice === true && !!c.auth;
  useEffect(() => {
    if (!voiceAvailable) { setRooms({}); return; }
    let stopped = false;
    const tick = async () => {
      try {
        const result = await c.api.get<{ rooms: Record<string, string[]> }>("/api/voice/rooms");
        if (!stopped) setRooms(result.rooms);
      } catch { /* keep the last answer; the next tick retries */ }
    };
    void tick();
    const timer = setInterval(() => void tick(), 4000);
    return () => { stopped = true; clearInterval(timer); };
  }, [voiceAvailable, c.api]);

  // The per-peer roster is reported only to a session that is in the call.
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
  const nameOf = (id: string) => { const member = c.members.find(candidate => candidate.id === id); return member ? userName(member) : id; };
  const avatarOf = (id: string) => { const member = c.members.find(candidate => candidate.id === id); return member ? avatarPath(member) : undefined; };
  const publishers = new Set(peers.filter(peer => peer.publisher).map(peer => String(peer.peer_id)));
  const members = peers.filter(peer => !peer.publisher);
  const active = status.phase !== "idle";

  // Rings and declines come from the event poll. Read the latest names and ids at the moment they arrive.
  const latest = useRef({ nameOf, avatarOf, me: c.auth?.user.id, joined: active ? channelId : undefined });
  latest.current = { nameOf, avatarOf, me: c.auth?.user.id, joined: active ? channelId : undefined };
  // iOS: the system call screen rings instead of the in-app toast. `systemRing` is what it is ringing now,
  // `systemCall` the call it shows as connected, and `handled` rings already answered or declined there.
  const systemRing = useRef(new Set<string>());
  const systemCall = useRef<{ channelId: string; connected: boolean } | undefined>(undefined);
  const handled = useRef(new Map<string, number>());
  const declinedByPeer = useRef(false);
  useEffect(() => c.callEvents.subscribe(event => {
    if (!event.fresh || event.fromId === latest.current.me) return;
    if (event.kind === "call.ring") {
      const toast = { conversationId: event.channelId, personId: event.fromId, name: event.fromName || latest.current.nameOf(event.fromId), avatarUrl: latest.current.avatarOf(event.fromId) };
      if (!isCallKit()) { setIncoming(toast); return; }
      // The same ring may also have arrived as a VoIP push, been answered and be over already.
      if (latest.current.joined === event.channelId || Date.now() - (handled.current.get(event.channelId) ?? 0) < RING_FRESH_MS) return;
      void callKit.reportIncoming(event.channelId, toast.name).then(shown => {
        if (shown) systemRing.current.add(event.channelId);
        else setIncoming(toast);
      });
    } else {
      // The same event serves both sides: the callee declining, or the caller cancelling before an answer.
      setIncoming(current => current?.conversationId === event.channelId ? undefined : current);
      setRinging(current => current?.channelId === event.channelId ? { ...current, declined: true } : current);
      if (systemRing.current.delete(event.channelId)) void callKit.end(event.channelId, { remote: true }).catch(() => {});
    }
  }), [c.callEvents]);
  useEffect(() => {
    if (!c.auth) { setIncoming(undefined); setRinging(undefined); }
  }, [c.auth]);
  // A ring stops ringing after 30 s, or once you are in that call.
  useEffect(() => {
    if (!incoming) return;
    const timer = setTimeout(() => setIncoming(undefined), RING_FRESH_MS);
    return () => clearTimeout(timer);
  }, [incoming]);
  useEffect(() => {
    if (incoming && status.phase !== "idle" && channelId === incoming.conversationId) setIncoming(undefined);
  }, [incoming, status.phase, channelId]);

  const cancelRing = (id: string) => { void c.api.post(`/api/channels/${encodeURIComponent(id)}/ring/decline`, {}).catch(() => {}); };
  // Ringing ends when the other person joins, the call fails or ends, or nobody answers.
  const others = status.phase === "live" ? Math.max(0, (members.length || 1) - 1) : 0;
  useEffect(() => {
    if (!ringing || ringing.declined) return;
    if (others > 0 || status.phase === "idle" || status.phase === "failed") { setRinging(undefined); return; }
    const timer = setTimeout(() => {
      cancelRing(ringing.channelId);
      void transport.leave();
      void c.attempt(async () => { throw new Error("No answer"); });
    }, UNANSWERED_MS);
    return () => clearTimeout(timer);
  }, [ringing, others, status.phase]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!ringing?.declined) return;
    declinedByPeer.current = true;
    const timer = setTimeout(() => void transport.leave(), DECLINED_MS);
    return () => clearTimeout(timer);
  }, [ringing?.declined]); // eslint-disable-line react-hooks/exhaustive-deps

  // iOS: the system call ends with the call (however it ended), and shows connected once the other person is in.
  useEffect(() => {
    const call = systemCall.current;
    if (!call || (status.phase !== "idle" && status.phase !== "failed")) return;
    systemCall.current = undefined;
    const declined = declinedByPeer.current;
    declinedByPeer.current = false;
    void callKit.end(call.channelId, declined ? { remote: true, declined: true } : {}).catch(() => {});
  }, [status.phase]);
  useEffect(() => {
    const call = systemCall.current;
    if (!call || call.connected || others === 0 || call.channelId !== channelId) return;
    call.connected = true;
    void callKit.connected(call.channelId).catch(() => {});
  }, [others, channelId]);

  // iOS: register for VoIP pushes, listen to the system call screen, and catch up on an answer made
  // from the lock screen before this webview existed. Sign-out deletes the device, and with it the token.
  const system = useRef<{ answer(id: string): Promise<void>; end(id: string): Promise<void>; mute(id: string, muted: boolean): void } | undefined>(undefined);
  system.current = {
    answer: async id => {
      handled.current.set(id, Date.now());
      systemRing.current.delete(id);
      setIncoming(undefined);
      if (latest.current.joined === id) return;
      void c.select(id).catch(() => {});
      if (await joinCall(id)) systemCall.current = { channelId: id, connected: true };
      else void callKit.end(id, { remote: true }).catch(() => {});
    },
    end: async id => {
      handled.current.set(id, Date.now());
      const call = systemCall.current?.channelId === id;
      if (call) systemCall.current = undefined; // the system already ended it; do not ask it again
      if (latest.current.joined === id) await transport.leave();
      else if (systemRing.current.delete(id)) cancelRing(id); // declined on the system screen
    },
    mute: (id, next) => { if (latest.current.joined === id) transport.setMuted(next); },
  };
  useEffect(() => {
    if (!c.auth || !isCallKit()) return;
    let live = true;
    const send = (token: unknown) => { if (typeof token === "string" && token) void c.api.put("/api/push/voip", { token }).catch(() => {}); };
    const channelOf = (data: Record<string, unknown>) => typeof data.channelId === "string" ? data.channelId : undefined;
    const stops = [
      onCallKit("voipToken", data => send(data.token)),
      onCallKit("answer", data => { const id = channelOf(data); if (id) void system.current?.answer(id); }),
      onCallKit("end", data => { const id = channelOf(data); if (id) void system.current?.end(id); }),
      onCallKit("mute", data => { const id = channelOf(data); if (id && typeof data.muted === "boolean") system.current?.mute(id, data.muted); }),
    ];
    void (async () => {
      try { const registered = await callKit.register(); if (live && registered.supported && registered.token) send(registered.token); } catch { /* no VoIP push; in-app rings still work */ }
      try { const pending = await callKit.pending(); if (live && pending?.answered) await system.current?.answer(pending.channelId); } catch { /* nothing to catch up on */ }
    })();
    return () => { live = false; stops.forEach(stop => stop()); };
  }, [c.auth?.token, c.api]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Joins the conversation's call; resolves to whether the join worked. */
  const joinCall = async (conversationId: string): Promise<boolean> => {
    // Leave the current call properly (server DELETE) before joining another.
    if (status.phase !== "idle" && channelId && channelId !== conversationId) {
      try { await voice.leave(); } catch { /* the join below closes any remainder */ }
    }
    setError(""); setMuted(false); setDeafened(false); setCamera(false); setPeers([]); setRinging(undefined);
    setChannelId(conversationId);
    try {
      await voice.join(conversationId, false, selected);
      setJoinedAt(Date.now());
      return true;
    } catch (reason) { fail(reason); return false; }
  };

  const transport: CallTransport = {
    incoming,
    outgoing: active && ringing && ringing.channelId === channelId ? (ringing.declined ? "declined" : "ringing") : undefined,
    available: c.capabilities.voice === true,
    phase: status.phase,
    conversationId: active ? channelId : undefined,
    conversationName: active ? c.channels.find(channel => channel.id === channelId)?.name : undefined,
    participants: status.phase !== "live" ? []
      : members.length ? members.map(peer => ({ id: String(peer.peer_id), personId: peer.user_id, name: nameOf(peer.user_id), avatarUrl: avatarOf(peer.user_id), me: peer.current_session, connected: peer.connected }))
      : c.auth ? [{ id: status.peerId ?? "self", personId: c.auth.user.id, name: userName(currentUser(c) ?? c.auth.user), avatarUrl: avatarOf(c.auth.user.id), me: true, connected: true }] : [],
    active: Object.fromEntries(Object.entries(rooms).map(([room, ids]) => [room, ids.map(id => ({ personId: id, name: nameOf(id), avatarUrl: avatarOf(id) }))])),
    media: status.streams
      .filter(stream => !publishers.has(status.sourcePeers?.[stream.id] ?? ""))
      .map(stream => ({ id: stream.id, stream, participantId: status.sourcePeers?.[stream.id] || undefined, video: stream.getVideoTracks().length > 0 })),
    speaking: status.phase === "live" ? status.speaking ?? [] : [],
    localVideo: status.phase === "live" ? voice.localPicture() : undefined,
    joinedAt: status.phase === "live" ? joinedAt : undefined,
    muted, deafened, camera,
    sharing: voice.sharing,
    error: error || (status.phase === "failed" ? status.error ?? "" : ""),
    warning: active ? status.warning ?? "" : "",
    devices: devices.map(device => ({ id: device.id, label: device.label, kind: device.kind === "audioinput" ? "microphone" as const : "camera" as const })),
    selected, bitrate, noiseSuppression,
    stats: { receivedBytes: status.receivedBytes, decodedFrames: status.decodedFrames },

    join: async conversationId => { await joinCall(conversationId); },
    callPerson: async personId => {
      if (!c.auth || personId === c.auth.user.id) return;
      setError("");
      let id = c.channels.find(channel => channel.kind === "dm" && channel.peer_id === personId)?.id;
      try {
        if (!id) {
          const created = await c.api.post<{ id: string }>("/api/channels", { name: nameOf(personId), kind: "dm", member_ids: [personId] });
          id = created.id;
          await c.refresh();
        }
        await c.select(id);
      } catch (reason) { fail(reason); return; }
      if (!(await joinCall(id))) return;
      try {
        await c.api.post(`/api/channels/${encodeURIComponent(id)}/ring`, {});
        setRinging({ channelId: id, declined: false });
      } catch (reason) {
        // Rung a moment ago by either side: they are still being rung, so keep waiting.
        if (reason instanceof ApiError && reason.status === 429) setRinging({ channelId: id, declined: false });
        else { fail(reason); return; }
      }
      // iOS: show the outgoing call in the system UI (Recents, audio routing); connected once they join.
      if (isCallKit()) {
        systemCall.current = { channelId: id, connected: false };
        void callKit.startOutgoing(id, nameOf(personId)).catch(() => { systemCall.current = undefined; });
      }
    },
    accept: async () => {
      const call = incoming;
      if (!call) return;
      setIncoming(undefined);
      await joinCall(call.conversationId);
    },
    decline: async () => {
      const call = incoming;
      if (!call) return;
      setIncoming(undefined);
      cancelRing(call.conversationId);
    },
    leave: async () => {
      // Hanging up before anyone answered tells the other side to stop ringing.
      if (ringing && !ringing.declined) cancelRing(ringing.channelId);
      try { await voice.leave(); } catch (reason) { fail(reason); }
      reset();
    },
    setMuted: next => { voice.mute(next); setMuted(next); },
    // Deafen also closes the microphone, and undeafen restores the earlier state.
    setDeafened: next => {
      if (next) { mutedBeforeDeafen.current = muted; voice.mute(true); setMuted(true); }
      else { const restore = mutedBeforeDeafen.current; voice.mute(restore); setMuted(restore); }
      setDeafened(next);
    },
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
    refreshDevices: async () => {
      try {
        const found = await availableVoiceInputs();
        setDevices(found);
        // A saved id that is no longer present must not stick around and pin the next join.
        // Ids are blank until capture permission is granted; then nothing can be judged stale.
        const known = found.some(device => device.id);
        const has = (id?: string) => !id || !known || found.some(device => device.id === id);
        setSelected(current => has(current.microphone) && has(current.camera) ? current : {
          microphone: has(current.microphone) ? current.microphone : undefined,
          camera: has(current.camera) ? current.camera : undefined,
        });
      } catch (reason) { fail(reason); }
    },
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
