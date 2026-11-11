import { useCall, useChat } from "../../core/context";
import { CallControls } from "../call/CallControls";
import { copy } from "../copy";
import { useNav } from "./nav";

/** Visible while in a call, wherever you are reading. */
export function CallDock() {
  const call = useCall();
  const chat = useChat();
  const nav = useNav();
  if (call.phase === "idle" || !call.conversationId) return null;
  const id = call.conversationId;
  return (
    <section className="hc-dock" data-testid="call-dock" aria-label={copy.call.dock}>
      <button type="button" className="hc-dock__name" aria-label={copy.call.open(call.conversationName ?? "")}
        onClick={() => { nav.set({ main: "chat", screen: "main", left: "channels" }); if (chat.current?.id !== id) void chat.open(id); }}>
        <strong>{call.conversationName}</strong>
        <small>{call.phase === "live" ? copy.call.people(call.participants.length) : call.phase === "failed" ? copy.call.failed : copy.call.joining}</small>
      </button>
      <CallControls />
    </section>
  );
}
