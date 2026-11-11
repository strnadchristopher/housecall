import { useEffect, useState } from "react";
import { useCall, useChat } from "../../core/context";
import { CallControls } from "../call/CallControls";
import { copy } from "../copy";
import { clock } from "../format";
import { Avatar, Button, Icon } from "../kit";

/**
 * The one voice entry point. Idle: Join. In this channel's call: who is in
 * it, how long this client has been in, and the in-call controls.
 */
export function CallBar() {
  const call = useCall();
  const chat = useChat();
  const here = call.phase !== "idle" && call.conversationId === chat.current?.id;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!here || !call.joinedAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [here, call.joinedAt]);
  if (!chat.current) return null;
  if (!here)
    return (
      <section className="hc-callbar" data-testid="call-bar" aria-label={copy.call.label}>
        <span className="hc-callbar__mark"><Icon name="phone" /></span>
        <strong className="hc-callbar__title">{copy.call.label}</strong>
        <Button kind="primary" onClick={() => void call.join(chat.current!.id)}>{copy.call.join}</Button>
      </section>
    );
  return (
    <section className="hc-callbar is-live" data-testid="call-bar" data-phase={call.phase} aria-label={copy.call.label}>
      <div className="hc-callbar__people">
        {call.participants.slice(0, 5).map(participant => <span key={participant.id} title={participant.name}><Avatar name={participant.name} size="sm" /></span>)}
      </div>
      <div className="hc-callbar__title">
        <strong>
          {call.phase === "live" ? copy.call.people(call.participants.length) : call.phase === "failed" ? copy.call.failed : copy.call.joining}
          {call.phase === "live" && call.joinedAt && <time data-testid="call-duration"> · {clock(Math.max(0, (now - call.joinedAt) / 1000))}</time>}
        </strong>
        <small>{call.error || copy.call.inTransit}</small>
      </div>
      <CallControls />
    </section>
  );
}
