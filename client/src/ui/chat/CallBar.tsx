import { useEffect, useState } from "react";
import { useCall, useChat } from "../../core/context";
import { CallControls } from "../call/CallControls";
import { copy } from "../copy";
import { clock } from "../format";
import { Avatar, Button, Icon, cx } from "../kit";

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
  const [dismissed, setDismissed] = useState("");
  useEffect(() => { if (call.phase === "idle" || call.phase === "connecting") setDismissed(""); }, [call.phase]);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => setConfirming(false), [chat.current?.id]);
  if (!chat.current) return null;
  const elsewhere = call.phase !== "idle" && !here;
  if (elsewhere)
    return (
      <section className="hc-callbar is-live" data-testid="call-bar" data-phase={call.phase} data-elsewhere="" aria-label={copy.call.label}>
        <div className="hc-callbar__title">
          <strong>{copy.call.inCallIn(call.conversationName ?? "")}</strong>
          {call.error && <small>{call.error}</small>}
        </div>
        {confirming
          ? <><Button kind="primary" onClick={() => { setConfirming(false); void call.join(chat.current!.id); }}>{copy.call.switchCall}</Button><Button kind="text" onClick={() => setConfirming(false)}>{copy.common.cancel}</Button></>
          : <Button onClick={() => setConfirming(true)}>{copy.call.join}</Button>}
        <CallControls />
      </section>
    );
  if (!here) {
    const running = call.active[chat.current.id] ?? [];
    return (
      <section className={cx("hc-callbar", running.length > 0 && "is-live")} data-testid="call-bar" data-running={running.length > 0 ? "" : undefined} aria-label={copy.call.label}>
        {running.length > 0
          ? <div className="hc-callbar__people">{running.slice(0, 5).map(person => <span key={person.personId} title={person.name}><Avatar name={person.name} size="sm" /></span>)}</div>
          : <span className="hc-callbar__mark"><Icon name="phone" /></span>}
        <div className="hc-callbar__title">
          <strong>{running.length > 0 ? copy.call.inProgress : copy.call.label}</strong>
          {running.length > 0 && <small>{running.map(person => person.name).join(", ")}</small>}
        </div>
        <Button kind="primary" onClick={() => void call.join(chat.current!.id)}>{copy.call.join}</Button>
      </section>
    );
  }
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
        {call.error && <small>{call.error}</small>}
        {call.warning && call.warning !== dismissed && (
          <small role="status" className="hc-callbar__warning">
            {call.warning}
            <button type="button" className="hc-callbar__dismiss" onClick={() => setDismissed(call.warning)}>{copy.common.dismiss}</button>
          </small>
        )}
      </div>
      <CallControls />
    </section>
  );
}
