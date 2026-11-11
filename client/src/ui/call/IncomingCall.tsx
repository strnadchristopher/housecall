import { useRef } from "react";
import { useCall, useChat } from "../../core/context";
import type { IncomingCall as Incoming } from "../../core/call";
import { copy } from "../copy";
import { Avatar, IconButton, Presence } from "../kit";
import { useNav } from "../shell/nav";

/**
 * Someone is calling you. Answer opens their conversation and joins; decline tells them.
 * It rings for 30 s (the adapter clears it). Not shown on iOS app builds, where the system call screen rings instead.
 */
export function IncomingCall() {
  const call = useCall();
  const chat = useChat();
  const nav = useNav();
  // Keep the last caller on screen while the toast plays its exit.
  const last = useRef<Incoming | undefined>(undefined);
  if (call.incoming) last.current = call.incoming;
  const who = call.incoming ?? last.current;
  return (
    <Presence show={!!call.incoming}>
      {who && (
        <section className="hc-incoming hc-anim-pop" role="alert" data-testid="incoming-call" aria-label={copy.call.incoming}>
          <Avatar name={who.name} src={who.avatarUrl} />
          <div className="hc-incoming__who">
            <strong>{who.name}</strong>
            <small>{copy.call.incoming}</small>
          </div>
          <IconButton icon="leave" className="hc-ibtn--danger" label={copy.call.decline(who.name)} onClick={() => void call.decline()} />
          <IconButton icon="phone" className="hc-ibtn--answer" label={copy.call.answer(who.name)}
            onClick={() => { nav.set({ main: "chat", screen: "main", left: "channels" }); void chat.open(who.conversationId); void call.accept(); }} />
        </section>
      )}
    </Presence>
  );
}
