import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { CallMedia, CallParticipant } from "../../core/call";
import { personPrefs, readPrefs, setPersonPrefs, subscribePrefs } from "../../state/audioOutput";
import { copy } from "../copy";
import { Avatar, Icon, cx } from "../kit";
import { usePersonCard } from "../people/PersonCard";
import { LivePill } from "./LivePill";
import { useOutput } from "./useOutput";

/** A picture counts as live while frames keep arriving. A camera that is switched off stops sending. */
const STALE_MS = 4000;

/** Attaches a stream to a video element and keeps it playing. */
function useStream(stream: MediaStream | undefined) {
  const element = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const node = element.current;
    if (!node || !stream) return;
    node.srcObject = stream;
    void node.play().catch(() => {});
    return () => { node.srcObject = null; };
  }, [stream]);
  return element;
}

/** True while the element is decoding new frames. */
function useFrames(element: React.RefObject<HTMLVideoElement | null>, enabled: boolean) {
  const [flowing, setFlowing] = useState(false);
  useEffect(() => {
    const node = element.current;
    if (!node || !enabled) { setFlowing(false); return; }
    let last = 0;
    let stopped = false;
    const frame = () => {
      if (stopped) return;
      last = performance.now();
      node.requestVideoFrameCallback(frame);
    };
    node.requestVideoFrameCallback(frame);
    const timer = setInterval(() => setFlowing(last > 0 && performance.now() - last < STALE_MS), 500);
    return () => { stopped = true; clearInterval(timer); };
  }, [element, enabled]);
  return flowing;
}

/** The prefs key for the volume of someone's screen sound. */
export const shareKey = (personId: string) => `${personId}:share`;

/** A slider for the sound that comes with someone's shared screen. Only on this device. */
function ShareVolume({ personId, name }: { personId: string; name: string }) {
  useSyncExternalStore(subscribePrefs, () => localStorage.getItem("hc.voicePrefs") ?? "", () => "");
  const prefs = personPrefs(readPrefs(), shareKey(personId));
  return (
    <input type="range" className="hc-tile__sharevol" min={0} max={100} value={Math.round(prefs.volume * 100)} data-testid="share-volume"
      aria-label={copy.call.shareSoundVolume(name)} title={copy.call.shareSoundVolume(name)}
      onClick={event => event.stopPropagation()}
      onChange={event => setPersonPrefs(shareKey(personId), { volume: Number(event.target.value) / 100 })} />
  );
}

/** One remote stream. Always mounted, so audio plays whether or not a picture shows. */
function RemoteMedia({ media, personId, deafened, onPicture }: { media: CallMedia; personId?: string; deafened: boolean; onPicture: (id: string, flowing: boolean) => void }) {
  const element = useStream(media.stream);
  const flowing = useFrames(element, media.video);
  // The sound of a shared screen has its own volume, apart from the person's voice.
  const muted = useOutput(element, media.share && personId ? shareKey(personId) : personId);
  useEffect(() => { onPicture(media.id, flowing); return () => onPicture(media.id, false); }, [media.id, flowing]);
  return (
    <video ref={element} autoPlay playsInline muted={deafened || muted} data-testid="remote-media" data-peer-id={media.participantId} data-share={media.share ? "" : undefined} data-media-kind={media.video ? "video" : "audio"}
      className={cx("hc-tile__video", !(media.video && flowing) && "is-hidden")}
      aria-label={media.video ? copy.call.remoteVideo : copy.call.remoteAudio} />
  );
}

export interface TileProps {
  participant: CallParticipant;
  media: CallMedia[];
  localVideo?: MediaStream;
  speaking: boolean;
  muted: boolean;
  deafened: boolean;
  sharing: boolean;
  streamTile?: boolean;
  tileKey?: string;
  outputDeafened?: boolean;
  pinned: boolean;
  onPin: () => void;
}

/** One participant: their picture or their avatar, name, mute state, and a ring while they speak. */
export function Tile({ participant, media, localVideo, speaking, muted, deafened, sharing, tileKey, streamTile = false, outputDeafened = deafened, pinned, onPin }: TileProps) {
  const openPerson = usePersonCard();
  const local = useStream(localVideo);
  const [pictures, setPictures] = useState<Record<string, boolean>>({});
  const onPicture = (id: string, flowing: boolean) => setPictures(current => current[id] === flowing ? current : { ...current, [id]: flowing });
  const showing = participant.me ? !!localVideo : Object.values(pictures).some(Boolean);
  const state = streamTile ? "" : deafened ? copy.call.deafened : muted ? copy.call.muted : "";
  return (
    <figure className={cx("hc-tile", streamTile && "hc-tile--stream is-entering", speaking && "is-speaking", pinned && "is-pinned", !showing && "is-faceless")} data-testid="call-tile" data-tile-key={tileKey ?? participant.id} data-peer-id={participant.id}
      data-speaking={speaking ? "" : undefined} data-picture={showing ? "" : undefined}>
      {participant.me
        ? localVideo && <video ref={local} autoPlay playsInline muted data-testid="local-media" className="hc-tile__video" aria-label={copy.call.localVideo} />
        : media.map(item => <RemoteMedia key={item.id} media={item} personId={participant.personId} deafened={outputDeafened} onPicture={onPicture} />)}
      {!showing && <span className="hc-tile__face"><Avatar name={participant.name} src={participant.avatarUrl} size="lg" /></span>}
      <button type="button" className="hc-tile__pin" aria-pressed={pinned} aria-label={pinned ? copy.voice.unfocus(streamTile ? copy.voice.screenOf(participant.name) : participant.name) : copy.voice.focus(streamTile ? copy.voice.screenOf(participant.name) : participant.name)} onClick={onPin} />
      <span className="hc-tile__hint" aria-hidden="true"><Icon name="expand" /></span>
      <figcaption>
        <button type="button" className="hc-tile__name" onClick={event => openPerson({ id: participant.personId, anchor: event.currentTarget, name: participant.name, avatarUrl: participant.avatarUrl })}>{streamTile ? copy.voice.screenOf(participant.name) : participant.name}{participant.me && !streamTile && <small> ({copy.call.you})</small>}</button>
        {sharing && <LivePill />}
        {!participant.me && participant.personId && streamTile && media.some(item => item.share) && <ShareVolume personId={participant.personId} name={participant.name} />}
        {state && <span className="hc-tile__state" role="img" aria-label={state} title={state}><Icon name={deafened ? "headphones" : "mic"} off /></span>}
        {speaking && <span className="hc-sr">{copy.call.speaking}</span>}
      </figcaption>
    </figure>
  );
}

/** Streams whose sender is not in the roster yet. They still play, and show no tile. */
export function Sink({ media, deafened, personId }: { media: CallMedia; deafened: boolean; personId?: string }) {
  const element = useStream(media.stream);
  const muted = useOutput(element, media.share && personId ? shareKey(personId) : personId);
  return <video ref={element} autoPlay playsInline muted={deafened || muted} data-testid="remote-media" data-peer-id={media.participantId} data-share={media.share ? "" : undefined} data-media-kind={media.video ? "video" : "audio"} className="hc-tile__video is-hidden"
    aria-label={media.video ? copy.call.remoteVideo : copy.call.remoteAudio} />;
}
