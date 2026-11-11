import { useEffect, useRef, useState } from "react";
import type { CallMedia, CallParticipant } from "../../core/call";
import { copy } from "../copy";
import { Avatar, Icon, cx } from "../kit";

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

/** One remote stream. Always mounted, so audio plays whether or not a picture shows. */
function RemoteMedia({ media, deafened, onPicture }: { media: CallMedia; deafened: boolean; onPicture: (id: string, flowing: boolean) => void }) {
  const element = useStream(media.stream);
  const flowing = useFrames(element, media.video);
  useEffect(() => { onPicture(media.id, flowing); return () => onPicture(media.id, false); }, [media.id, flowing]);
  return (
    <video ref={element} autoPlay playsInline muted={deafened} data-testid="remote-media" data-peer-id={media.participantId}
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
  pinned: boolean;
  onPin: () => void;
}

/** One participant: their picture or their avatar, name, mute state, and a ring while they speak. */
export function Tile({ participant, media, localVideo, speaking, muted, deafened, sharing, pinned, onPin }: TileProps) {
  const local = useStream(localVideo);
  const [pictures, setPictures] = useState<Record<string, boolean>>({});
  const onPicture = (id: string, flowing: boolean) => setPictures(current => current[id] === flowing ? current : { ...current, [id]: flowing });
  const showing = participant.me ? !!localVideo : Object.values(pictures).some(Boolean);
  const state = participant.me ? (deafened ? copy.call.deafened : muted ? copy.call.muted : "") : "";
  return (
    <figure className={cx("hc-tile", speaking && "is-speaking", pinned && "is-pinned", !showing && "is-faceless")} data-testid="call-tile" data-peer-id={participant.id}
      data-speaking={speaking ? "" : undefined} data-picture={showing ? "" : undefined}>
      {participant.me
        ? localVideo && <video ref={local} autoPlay playsInline muted data-testid="local-media" className="hc-tile__video" aria-label={copy.call.localVideo} />
        : media.map(item => <RemoteMedia key={item.id} media={item} deafened={deafened} onPicture={onPicture} />)}
      {!showing && <span className="hc-tile__face"><Avatar name={participant.name} src={participant.avatarUrl} size="lg" /></span>}
      <button type="button" className="hc-tile__pin" aria-pressed={pinned} aria-label={pinned ? copy.call.unpin(participant.name) : copy.call.pin(participant.name)} onClick={onPin} />
      <figcaption>
        <span className="hc-tile__name">{participant.name}{participant.me && <small> ({copy.call.you})</small>}</span>
        {participant.me && sharing && <Icon name="screen" />}
        {state && <span className="hc-tile__state" role="img" aria-label={state} title={state}><Icon name={deafened ? "headphones" : "mic"} off /></span>}
        {speaking && <span className="hc-sr">{copy.call.speaking}</span>}
      </figcaption>
    </figure>
  );
}

/** Streams whose sender is not in the roster yet. They still play, and show no tile. */
export function Sink({ media, deafened }: { media: CallMedia; deafened: boolean }) {
  const element = useStream(media.stream);
  return <video ref={element} autoPlay playsInline muted={deafened} data-testid="remote-media" data-peer-id={media.participantId} className="hc-tile__video is-hidden"
    aria-label={media.video ? copy.call.remoteVideo : copy.call.remoteAudio} />;
}
