import { useEffect, useRef } from "react";
import type { CallMedia } from "../../core/call";
import { copy } from "../copy";

/** One remote stream. Audio-only streams render the same element with no picture. */
export function Tile({ media, name, deafened }: { media: CallMedia; name?: string; deafened: boolean }) {
  const element = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const node = element.current;
    if (!node) return;
    node.srcObject = media.stream;
    void node.play().catch(() => {});
    return () => { node.srcObject = null; };
  }, [media.stream]);
  return (
    <figure className={media.video ? "hc-tile" : "hc-tile hc-tile--audio"}>
      <video ref={element} autoPlay playsInline muted={deafened} data-testid="remote-media" data-peer-id={media.participantId}
        aria-label={media.video ? copy.call.remoteVideo : copy.call.remoteAudio} />
      {media.video && name && <figcaption>{name}</figcaption>}
    </figure>
  );
}
