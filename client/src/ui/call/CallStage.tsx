import { useCall, useChat } from "../../core/context";
import { copy } from "../copy";
import { Tile } from "./Tile";

/**
 * Remote media for the current call. Always mounted while in a call so audio
 * keeps playing when another channel is open; pictures show only in the
 * call's own channel.
 */
export function CallStage({ away }: { away?: boolean }) {
  const call = useCall();
  const chat = useChat();
  if (call.phase === "idle") return null;
  const here = !away && call.conversationId === chat.current?.id;
  const pictures = call.media.some(media => media.video);
  return (
    <section className={here && pictures ? "hc-stage" : "hc-stage is-away"} data-testid="call-stage" aria-label={copy.call.stage}
      data-phase={call.phase} data-received-bytes={call.stats.receivedBytes} data-decoded-frames={call.stats.decodedFrames}>
      {call.media.map(media => (
        <Tile key={media.id} media={media} deafened={call.deafened} name={call.participants.find(participant => participant.id === media.participantId)?.name} />
      ))}
    </section>
  );
}
