import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { useCall, useChat, useIdentity } from "../../core/context";
import { copy } from "../copy";
import { Avatar, Button, Door, ErrorLine } from "../kit";
import { useNav } from "../shell/nav";
import { CallControls } from "./CallControls";
import { splitStageMedia } from "./stageMedia";
import { stageGrid } from "./stageGrid";
import { Sink, Tile } from "./Tile";

/** The stage owns pictures; when away it keeps the same remote audio playing. */
export function CallStage({ full }: { full?: boolean; away?: boolean }) {
  const call = useCall(), chat = useChat(), identity = useIdentity(), nav = useNav();
  const [dismissed, setDismissed] = useState("");
  useEffect(() => { if (call.phase === "idle" || call.phase === "connecting" && !call.reconnecting) setDismissed(""); }, [call.phase, call.reconnecting]);
  const [pinned, setPinned] = useState<string>();
  const root = useRef<HTMLElement>(null);
  const pendingFocus = useRef<{ key: string; spot?: string } | undefined>(undefined);
  const focusTile = (key: string) => {
    const next = pinned === key ? undefined : key;
    pendingFocus.current = { key, spot: next };
    setPinned(next);
  };
  useLayoutEffect(() => {
    const pending = pendingFocus.current;
    if (!full || !pending || pending.spot !== pinned) return;
    const button = root.current?.querySelector<HTMLElement>(`[data-tile-key="${CSS.escape(pending.key)}"] .hc-tile__pin`);
    if (button) { button.focus({ preventScroll: true }); pendingFocus.current = undefined; }
  }, [pinned, full, nav.watchStream]);
  const roster = call.rooms[call.conversationId ?? ""] ?? [];
  const items = call.participants.flatMap(participant => {
    const member = roster.find(member => member.personId === participant.personId);
    const media = call.media.filter(media => media.participantId === participant.id);
    const sharing = participant.me ? call.sharing : !!member?.sharing;
    const split = splitStageMedia(media, sharing);
    const person = { key: participant.id, participant, stream: false, sharing, member, media: split.person };
    return sharing ? [person, { ...person, key: `stream:${participant.id}`, stream: true, media: split.stream }] : [person];
  });
  const spot = items.find(item => item.key === pinned);
  useEffect(() => { if (pinned && !spot) setPinned(undefined); }, [pinned, !!spot]);
  const grid = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const node = grid.current;
    if (!node) return;
    const measure = () => setSize({ width: node.clientWidth, height: node.clientHeight });
    measure();
    const observer = new ResizeObserver(measure); observer.observe(node);
    return () => observer.disconnect();
  }, [full, call.phase, items.length, !!spot]);
  const layout = stageGrid(items.length || 2, size.width, size.height);
  useLayoutEffect(() => {
    if (!nav.watchStream || nav.watchStream.conversationId !== call.conversationId || !full) return;
    const stream = items.find(item => item.stream && item.participant.personId === nav.watchStream?.personId);
    if (stream) { pendingFocus.current = { key: stream.key, spot: stream.key }; setPinned(stream.key); nav.set({ watchStream: undefined }); }
  }, [nav.watchStream, full, items.map(item => item.key).join()]);
  useEffect(() => {
    if (!spot || !full) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !(event.target instanceof Element && event.target.closest('[role="dialog"]'))) { event.preventDefault(); pendingFocus.current = { key: spot.key }; setPinned(undefined); }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [spot?.key, full]);
  const callee = chat.current?.peerId ? chat.people.find(person => person.id === chat.current?.peerId) : undefined;
  if (call.phase === "idle") return null;
  const common = { "data-testid": "call-stage", "aria-label": copy.call.stage, "data-phase": call.phase, "data-received-bytes": call.stats.receivedBytes, "data-decoded-frames": call.stats.decodedFrames } as const;
  if (!full) return <section className="hc-stage is-away" {...common}>{call.media.map(media => <Sink key={media.id} media={media} personId={call.participants.find(person => person.id === media.participantId)?.personId} deafened={call.deafened} />)}</section>;
  const known = new Set(call.participants.map(participant => participant.id));
  const orphans = call.media.filter(media => !media.participantId || !known.has(media.participantId));
  const tile = (item: typeof items[number]) => <Tile key={item.key} tileKey={item.key} participant={item.participant} media={item.media}
    streamTile={item.stream} localVideo={item.participant.me && (item.stream === call.sharing) ? call.localVideo : undefined}
    speaking={!item.stream && call.speaking.includes(item.participant.id)}
    muted={item.participant.me ? call.muted : !!item.member?.muted} deafened={item.participant.me ? call.deafened : !!item.member?.deafened}
    outputDeafened={call.deafened} sharing={item.sharing} pinned={pinned === item.key}
    onPin={() => focusTile(item.key)} />;
  return <section ref={root} className="hc-stage is-full" {...common}>
    {chat.current?.kind === "dm" && <p className="hc-lockline" title={copy.e2e.relayedTip}>{copy.e2e.relayed}</p>}
    {call.outgoing && <p className="hc-stage__ring" role="status" data-state={call.outgoing}>
      {callee && <Avatar name={callee.name} src={callee.avatarUrl} size="sm" />}
      <span data-testid="call-ringing" data-state={call.outgoing}>{call.outgoing === "declined" ? copy.call.declined : copy.call.ringing(callee?.name ?? call.conversationName ?? "")}</span>
    </p>}
    {call.phase === "failed" ? <div className="hc-empty" role="status"><Door /><strong>{copy.voice.couldntJoin(call.conversationName ?? "")}</strong><p>{call.error || copy.voice.couldntJoinBody}</p><Button kind="primary" onClick={() => void call.join(call.conversationId!)}>{copy.voice.tryAgain}</Button></div>
      : spot ? <><div className="hc-stage__spot hc-anim-fade">{tile(spot)}</div><div className="hc-stage__strip hc-anim-fade">{items.filter(item => item !== spot).map(tile)}</div></>
      : <div ref={grid} className="hc-stage__grid" data-count={items.length || 2} style={size.width ? { "--hc-cols": layout.cols, "--hc-tile-w": `${layout.tile}px` } as CSSProperties : undefined}>
        {items.length ? items.map(tile) : <><div className="hc-tile hc-skel" aria-busy="true" /><div className="hc-tile hc-skel" aria-busy="true" /></>}
      </div>}
    {(call.phase === "live" || call.reconnecting) && items.length === 1 && <p className="hc-stage__note"><strong>{copy.voice.aloneTitle}</strong>{copy.voice.aloneBody(identity.serverName)}</p>}
    {call.phase !== "failed" && <><ErrorLine text={call.error} /><ErrorLine text={call.warning === dismissed ? "" : call.warning} onDismiss={() => setDismissed(call.warning)} dismissLabel={copy.common.dismiss} /><CallControls stage /></>}
    {orphans.map(media => <Sink key={media.id} media={media} personId={call.participants.find(person => person.id === media.participantId)?.personId} deafened={call.deafened} />)}
  </section>;
}
