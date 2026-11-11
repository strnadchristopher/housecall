import { useState } from "react";
import { useCall } from "../../core/context";
import { copy } from "../copy";
import { Sink, Tile } from "./Tile";

/**
 * The call. With `full` it is the center column: one tile per participant
 * (camera or avatar), a speaking ring, and a pinned tile in a spotlight with
 * the rest in a strip. Without `full` it renders no picture at all and only
 * keeps remote audio playing while another channel or Settings is open.
 */
export function CallStage({ full }: { full?: boolean; away?: boolean }) {
  const call = useCall();
  const [pinned, setPinned] = useState<string>();
  if (call.phase === "idle") return null;
  const common = { "data-testid": "call-stage", "aria-label": copy.call.stage, "data-phase": call.phase, "data-received-bytes": call.stats.receivedBytes, "data-decoded-frames": call.stats.decodedFrames } as const;
  if (!full) {
    return (
      <section className="hc-stage is-away" {...common}>
        {call.media.map(media => <Sink key={media.id} media={media} deafened={call.deafened} />)}
      </section>
    );
  }
  const known = new Set(call.participants.map(participant => participant.id));
  const orphans = call.media.filter(media => !media.participantId || !known.has(media.participantId));
  const me = call.participants.find(participant => participant.me);
  const spot = call.participants.find(participant => participant.id === pinned) ?? (call.sharing ? me : undefined);
  const tile = (participant: (typeof call.participants)[number]) => (
    <Tile key={participant.id} participant={participant} media={call.media.filter(media => media.participantId === participant.id)}
      localVideo={participant.me ? call.localVideo : undefined} speaking={call.speaking.includes(participant.id)}
      muted={call.muted} deafened={call.deafened} sharing={call.sharing} pinned={pinned === participant.id}
      onPin={() => setPinned(current => current === participant.id ? undefined : participant.id)} />
  );
  return (
    <section className="hc-stage is-full" {...common}>
      {spot ? (
        <>
          <div className="hc-stage__spot">{tile(spot)}</div>
          {call.participants.length > 1 && <div className="hc-stage__strip">{call.participants.filter(participant => participant !== spot).map(tile)}</div>}
        </>
      ) : (
        <div className="hc-stage__grid" data-count={call.participants.length}>{call.participants.map(tile)}</div>
      )}
      {orphans.map(media => <Sink key={media.id} media={media} deafened={call.deafened} />)}
    </section>
  );
}
