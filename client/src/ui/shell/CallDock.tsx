import { useId } from "react";
import { useCall, useChat } from "../../core/context";
import { cardState, signalBars, signalTip } from "../../state/callQuality";
import { copy } from "../copy";
import { Button, IconButton, Presence } from "../kit";
import { useNav } from "./nav";

/** Three bars and a tooltip with the measured round trip. Never an invented number. */
export function Signal() {
  const call = useCall();
  const tip = useId();
  const quality = { phase: call.phase, rttMs: call.quality.rttMs, loss: call.quality.loss };
  return (
    <button type="button" className="hc-signal hc-tipped" data-bars={signalBars(quality)} data-busy={call.phase === "connecting" ? "" : undefined}
      aria-label={copy.call.connection} aria-describedby={tip}
      onClick={event => { const el = event.currentTarget; el.toggleAttribute("data-open"); }}
      onBlur={event => event.currentTarget.removeAttribute("data-open")}>
      <i /><i /><i />
      <span className="hc-tip" role="tooltip" id={tip} data-side="start">{signalTip(quality)}</span>
    </button>
  );
}

function useCard() {
  const call = useCall();
  const chat = useChat();
  const nav = useNav();
  const state = cardState({ phase: call.phase, rttMs: call.quality.rttMs, loss: call.quality.loss });
  const id = call.conversationId;
  const line = state === "connecting" ? copy.call.connecting : state === "failed" ? copy.call.failed : state === "weak" ? copy.call.weak : copy.call.connected;
  const open = () => { if (!id) return; nav.set({ main: "chat", screen: "main", left: "channels" }); if (chat.current?.id !== id) void chat.open(id); };
  return { call, state, line, open, show: call.phase !== "idle" && !!id };
}

/** In the left column, directly above the user bar, for as long as you are in a call or joining one. */
export function CallDock() {
  const { call, state, line, open, show } = useCard();
  return (
    <Presence show={show} ms={110}>
      <section className="hc-callcard hc-anim-rise" data-state={state} data-testid="call-dock" aria-label={copy.call.dock}>
        <Signal />
        <button type="button" className="hc-callcard__main" aria-label={copy.call.open(call.conversationName ?? "")} onClick={open}>
          <strong>{call.conversationName}</strong>
          <small>{line}</small>
        </button>
        <div className="hc-callcard__ctl" role="toolbar" aria-label={copy.call.label}>
          {state === "failed" && call.conversationId && <Button onClick={() => void call.join(call.conversationId!)}>{copy.call.tryAgain}</Button>}
          <IconButton icon="mic" off={call.muted} active={call.muted} disabled={state === "connecting" || state === "failed"} label={call.muted ? copy.call.unmute : copy.call.mute} onClick={() => call.setMuted(!call.muted)} />
          <IconButton icon="headphones" off={call.deafened} active={call.deafened} disabled={state === "connecting" || state === "failed"} label={call.deafened ? copy.call.undeafen : copy.call.deafen} onClick={() => call.setDeafened(!call.deafened)} />
          <IconButton icon="leave" className="hc-ibtn--danger" label={copy.call.leave} onClick={() => void call.leave()} />
        </div>
      </section>
    </Presence>
  );
}

/** Phone, outside the drawer: one strip under the header on every screen that is not the stage. */
export function CallStrip() {
  const { call, state, line, open, show } = useCard();
  if (!show) return null;
  return (
    <section className="hc-callstrip" data-state={state} data-testid="call-strip" aria-label={copy.call.dock}>
      <Signal />
      <button type="button" className="hc-callstrip__main" aria-label={copy.call.open(call.conversationName ?? "")} onClick={open}>
        <strong>{call.conversationName}</strong>
        <small>{line}</small>
      </button>
      <IconButton icon="mic" off={call.muted} active={call.muted} disabled={state === "connecting" || state === "failed"} label={call.muted ? copy.call.unmute : copy.call.mute} onClick={() => call.setMuted(!call.muted)} />
      <IconButton icon="leave" className="hc-ibtn--danger" label={copy.call.leave} onClick={() => void call.leave()} />
    </section>
  );
}
