import { useEffect, useState } from "react";
import { clock } from "../format";
import { Signal } from "../shell/CallDock";
import { DmSecurityLabel } from "../security/DmSecurity";
import { useCall, useChat, useIdentity } from "../../core/context";
import { copy } from "../copy";
import { Icon, IconButton } from "../kit";
import { useNav } from "../shell/nav";
import { usePhone, useSheet } from "../tokens/motion";

export function ChannelHeader() {
  const chat = useChat();
  const call = useCall();
  const identity = useIdentity();
  // A two-person direct conversation gets a Call button until you are in its call.
  const peer = chat.current?.kind === "dm" ? chat.people.find(person => person.id === chat.current?.peerId) : undefined;
  const calling = call.phase !== "idle" && call.conversationId === chat.current?.id;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!calling || !call.joinedAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [calling, call.joinedAt]);
  const nav = useNav();
  const inside = chat.current ? call.rooms[chat.current.id]?.length ?? 0 : 0;
  const phone = usePhone();
  const sheet = useSheet();
  const side = (kind: "search" | "pins") => nav.set({ side: nav.side.kind === kind && !sheet ? { kind: "tabs", tab: "people" } : { kind }, sheet: true });
  // On a phone the other conversations live in the drawer, so the menu button says when one of them wants you.
  const elsewhere = chat.conversations.filter(conversation => conversation.id !== chat.current?.id).reduce((sum, conversation) => sum + conversation.mentions, 0);
  return (
    <header className={calling ? "hc-header is-calling" : "hc-header"}>
      {phone && (
        <span className="hc-header__menu">
          <IconButton icon="menu" label={copy.header.menu} data-menu-button="" onClick={() => nav.set({ screen: "list" })} />
          {elsewhere > 0 && <span className="hc-dot" role="img" aria-label={copy.channels.mentions(elsewhere)} />}
        </span>
      )}
      <div className="hc-header__title">
        {(chat.current?.kind === "channel" || chat.current?.kind === "voice") && <span className="hc-header__glyph"><Icon name={chat.current.kind === "voice" ? "speaker" : "hash"} /></span>}
        <h1>{chat.current?.name}</h1>
        {chat.current?.kind === "channel" && <small>{copy.header.in(identity.serverName)}</small>}
        {!calling && chat.current?.kind === "voice" && <small>{inside > 0 ? copy.channels.inside(inside) : copy.header.in(identity.serverName)}</small>}
        {calling && <small className="hc-header__meta" role="status">{phone && <Signal />}{call.reconnecting ? copy.call.reconnecting : call.phase === "connecting" ? copy.call.connecting : call.phase === "failed" ? copy.call.failed : copy.voice.inside(call.participants.length)}{call.phase === "live" && call.joinedAt && <time data-testid="call-duration"> · {clock(Math.max(0, (now - call.joinedAt) / 1000))}</time>}</small>}
        <DmSecurityLabel />
        {peer?.bio && <small className="hc-header__bio">{peer.bio}</small>}
      </div>
      {calling && <span className="hc-header__chat"><IconButton icon="chat" label={chat.current?.mentions ? copy.call.chatUnread(chat.current.mentions) : copy.call.chat} active={nav.side.kind === "tabs" && nav.side.tab === "chat" && (!sheet || nav.sheet)} onClick={() => nav.set({ side: { kind: "tabs", tab: "chat" }, sheet: !nav.sheet })} />{!!chat.current?.mentions && (sheet ? !nav.sheet : nav.side.kind !== "tabs" || nav.side.tab !== "chat") && <span className="hc-count" aria-hidden="true">{chat.current.mentions}</span>}</span>}
      {call.available && peer && !calling && <IconButton icon="phone" label={copy.call.callPerson(peer.name)} onClick={() => void call.callPerson(peer.id)} />}
      <IconButton icon="search" label={copy.header.search} active={nav.side.kind === "search"} onClick={() => side("search")} />
      <IconButton icon="pin" label={copy.header.pins} active={nav.side.kind === "pins"} onClick={() => side("pins")} />
      {sheet && <IconButton icon="people" label={copy.header.people} onClick={() => nav.set({ side: { kind: "tabs", tab: "people" }, sheet: true })} />}
      <IconButton icon="settings" label={copy.header.settings} onClick={() => nav.set({ main: "settings", section: phone ? null : identity.owner ? "invites" : "about" })} />
    </header>
  );
}
