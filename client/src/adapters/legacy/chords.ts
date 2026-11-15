import { copy } from "../../ui/copy";
import { useEffect, useRef, useState } from "react";
import type { BrowserState, ChordEntry, ChordRegistry, SharedSession } from "../../core/chords";
import type { RequestCard } from "../../core/chat";
import type { ActivitySnapshot } from "../../data/activities";
import type { PlexPlayer } from "../../transport/plex";
import { DjPlayer } from "../../transport/dj";
import type { VoiceStatus } from "../../transport/voice";
import { userName } from "../../data/people";
import type { Housecall } from "./chat";

interface PlexItem { id: string; title: string; kind: string; duration_ms: number }
interface Track { title: string; source: string; duration_ms: number }

/** ChordRegistry over the current activity, Plex, DJ, Gimme and VM routes. */
export function useLegacyChords(c: Housecall, voice: { status: VoiceStatus; live: boolean }, requests: RequestCard[], encryptedDm = false): ChordRegistry {
  const disabled = encryptedDm;
  const cap = c.capabilities;
  const me = c.auth?.user.id ?? "";
  const activity = c.activities[c.channel];
  const [error, setError] = useState("");
  const [libraries, setLibraries] = useState<{ id: string; title: string }[]>([]);
  const [items, setItems] = useState<PlexItem[]>([]);
  const [subtitles, setSubtitles] = useState(false);
  const [manifest, setManifest] = useState<string>();
  const [tracks, setTracks] = useState<Track[]>([]);
  const [djAudio, setDjAudio] = useState<string>();
  const [vm, setVm] = useState<{ armed: boolean; phase: string; peer_id?: number }>();
  const [resetOutcome, setResetOutcome] = useState<NonNullable<BrowserState["resetOutcome"]>>();
  const pendingGimme = useRef<{ intent: string; key: string } | undefined>(undefined);
  const watchers = useRef(new Set<PlexPlayer>());
  const listeners = useRef(new Set<DjPlayer>());
  const latest = useRef({ activity, subtitles });
  latest.current = { activity, subtitles };
  const configured = cap.plex === true || cap.dj === true || cap.vm_media === true;

  useEffect(() => { setError(""); setLibraries([]); setItems([]); setTracks([]); pendingGimme.current = undefined; }, [c.channel, me]);
  useEffect(() => {
    if (me && c.channel && configured) void c.loadActivity().catch(() => {});
  }, [c.channel, me, configured]);
  useEffect(() => {
    for (const player of watchers.current) { if (activity) player.update(activity); player.subtitles(subtitles); }
    for (const player of listeners.current) if (activity) player.update(activity);
  }, [activity, subtitles]);

  const plexMedia = activity?.kind === "plex" ? activity.playback.media_id : null;
  useEffect(() => {
    let cancelled = false;
    setManifest(undefined);
    if (plexMedia && voice.live && cap.plex === true)
      void c.api.post<{ manifest_url: string }>(`/api/channels/${c.channel}/plex/playback`, { rating_key: plexMedia })
        .then(result => { if (!cancelled) setManifest(result.manifest_url); })
        .catch(reason => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { cancelled = true; };
  }, [plexMedia, voice.live, c.channel, c.api, cap.plex]);

  const djTrack = activity?.kind === "dj" ? activity.playback.media_id : null;
  useEffect(() => {
    let cancelled = false;
    setDjAudio(undefined);
    if (djTrack && voice.live && cap.dj === true)
      void c.api.get<{ track: { id: string; audio_url: string } | null }>(`/api/channels/${c.channel}/dj/playback`)
        .then(result => { if (!cancelled && result.track?.id === djTrack) setDjAudio(result.track.audio_url); })
        .catch(reason => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { cancelled = true; };
  }, [djTrack, voice.live, c.channel, c.api, cap.dj]);

  const vmLive = activity?.kind === "vm" && cap.vm_media === true && !!me;
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setVm(undefined);
    if (!vmLive) return;
    const poll = async () => {
      try {
        const result = await c.api.get<NonNullable<typeof vm>>(`/api/channels/${c.channel}/vm/media`);
        if (!stopped) setVm(result);
      } catch { if (!stopped) setVm({ armed: false, phase: "unavailable" }); }
      if (!stopped) timer = setTimeout(() => void poll(), 1000);
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [vmLive, c.channel, c.api]);
  const checkReset = async () => {
    const status = await c.api.get<{ operation?: string; outcome: string }>(`/api/channels/${c.channel}/vm/reset`);
    const known = ["pending", "reset", "rolled_back", "unknown"] as const;
    setResetOutcome(status.operation ? known.find(outcome => outcome === status.outcome) : undefined);
  };
  useEffect(() => {
    setResetOutcome(undefined);
    if (activity?.kind === "vm" && me && cap.vm_reset === true) void checkReset().catch(() => {});
  }, [c.channel, me, activity?.kind, cap.vm_reset]);

  const nameOf = (id: string) => { const member = c.members.find(candidate => candidate.id === id); return member ? userName(member) : id; };
  const session = (snapshot: ActivitySnapshot): SharedSession => ({
    kind: snapshot.kind === "plex" ? "watch" : snapshot.kind === "dj" ? "music" : "browser",
    playing: snapshot.playback.playing,
    positionMs: Math.max(0, Math.min(snapshot.playback.duration_ms ?? Infinity,
      snapshot.playback.position_ms + (snapshot.playback.playing ? Date.now() - snapshot.playback.anchored_at_ms : 0))),
    durationMs: snapshot.playback.duration_ms ?? undefined,
    hasMedia: !!snapshot.playback.media_id,
    hostId: snapshot.host, hostName: nameOf(snapshot.host), isHost: snapshot.host === me,
    queue: snapshot.queue.map(track => ({ id: track.id, title: track.title, requestedBy: nameOf(track.requested_by), current: track.id === snapshot.playback.media_id })),
    votedSkip: snapshot.skip_votes.includes(me),
  });
  const run = (work: () => Promise<void>) => c.run(async () => { setError(""); if (disabled) throw new Error(copy.e2e.off.apps); await work(); });
  const command = (body: Record<string, unknown>) => run(async () => {
    if (!activity) return;
    await c.api.post(`/api/channels/${c.channel}/activity/commands`, { expected_revision: activity.revision, command: body });
    await c.loadActivity();
  });
  const start = (kind: string) => run(async () => { await c.api.post(`/api/channels/${c.channel}/activity`, { kind }); await c.loadActivity(); });

  const chords: ChordEntry[] = [
    ...(cap.gimme_dry_run === false || cap.plex === true ? [{ id: "gimme" as const, active: activity?.kind === "plex" }] : []),
    ...(cap.dj === true ? [{ id: "steve" as const, active: activity?.kind === "dj" }] : []),
    ...(cap.vm_media === true ? [{ id: "browser" as const, active: activity?.kind === "vm" }] : []),
  ];

  return {
    chords, inCall: voice.live, error,
    session: activity ? session(activity) : undefined,
    gimme: {
      canRequest: cap.gimme_dry_run === false, canWatch: cap.plex === true, requests,
      libraries, items: items.map(({ id, title, kind }) => ({ id, title, kind })), subtitles,
      player: activity?.kind === "plex" ? manifest : undefined,
    },
    steve: {
      results: tracks.map((track, index) => ({ index, title: track.title, seconds: Math.round(track.duration_ms / 1000) })),
      player: activity?.kind === "dj" ? djAudio : undefined,
    },
    browser: activity?.kind === "vm" && vm ? {
      phase: (["idle", "armed", "connecting", "live"] as const).find(phase => phase === vm.phase) ?? "unavailable",
      canStop: activity.host === me && vm.armed, canReset: cap.vm_reset === true, resetOutcome,
      streams: voice.status.streams.filter(stream => voice.status.sourcePeers?.[stream.id] === String(vm.peer_id)),
    } : undefined,

    request: (title, media) => run(async () => {
      const request = { media, query: title };
      const fingerprint = JSON.stringify([c.channel, request]);
      if (pendingGimme.current?.intent !== fingerprint) pendingGimme.current = { intent: fingerprint, key: crypto.randomUUID() };
      await c.api.post(`/api/channels/${c.channel}/gimme/requests`, { request, idempotency_key: pendingGimme.current.key });
      await c.refresh();
      pendingGimme.current = undefined;
    }),
    startWatch: () => start("plex"),
    loadLibraries: () => run(async () => {
      setLibraries((await c.api.get<{ libraries: { id: string; title: string }[] }>(`/api/channels/${c.channel}/plex/sections`)).libraries);
      setItems([]);
    }),
    openLibrary: id => run(async () => {
      setItems((await c.api.get<{ items: PlexItem[] }>(`/api/channels/${c.channel}/plex/items?section=${encodeURIComponent(id)}&start=0`)).items);
    }),
    watch: itemId => {
      const item = items.find(candidate => candidate.id === itemId);
      return item ? command({ type: "select", media_id: item.id, duration_ms: item.duration_ms }) : Promise.resolve();
    },
    toggleSubtitles: () => setSubtitles(value => !value),
    bindWatch: element => {
      let cancelled = false;
      let player: PlexPlayer | undefined;
      const path = manifest;
      if (!path) return () => {};
      void import("../../transport/plex").then(({ PlexPlayer }) => {
        if (cancelled) return;
        player = new PlexPlayer(element, c.api, setError);
        watchers.current.add(player);
        player.load(path);
        if (latest.current.activity) player.update(latest.current.activity);
        player.subtitles(latest.current.subtitles);
      }).catch(reason => setError(reason instanceof Error ? reason.message : String(reason)));
      return () => { cancelled = true; if (player) { watchers.current.delete(player); player.destroy(); } };
    },
    startMusic: () => start("dj"),
    searchSongs: query => run(async () => {
      setTracks((await c.api.post<{ results: Track[] }>(`/api/channels/${c.channel}/dj/search`, { query })).results);
    }),
    queueSong: index => run(async () => {
      const track = tracks[index];
      if (track) await c.api.post(`/api/channels/${c.channel}/dj/queue`, { query: track.source });
      await c.loadActivity();
    }),
    voteSkip: () => command({ type: "vote_skip" }),
    bindMusic: element => {
      if (!djAudio) return () => {};
      const player = new DjPlayer(element, c.api, setError);
      listeners.current.add(player);
      void player.load(djAudio, c.channel);
      if (latest.current.activity) player.update(latest.current.activity);
      return () => { listeners.current.delete(player); player.destroy(); };
    },
    play: () => command({ type: "play" }),
    pause: () => command({ type: "pause" }),
    seek: positionMs => command({ type: "seek", position_ms: Math.round(positionMs) }),
    handOff: personId => command({ type: "handoff", user_id: personId }),
    stop: () => run(async () => { await c.api.delete(`/api/channels/${c.channel}/activity`); await c.loadActivity(); }),
    stopBrowser: () => run(async () => { await c.api.delete(`/api/channels/${c.channel}/vm/media`); }),
    checkBrowserReset: () => run(checkReset),
  };
}
