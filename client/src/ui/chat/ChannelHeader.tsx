import { useCall, useChat, useIdentity } from "../../core/context";
import { copy } from "../copy";
import { IconButton } from "../kit";
import { useNav } from "../shell/nav";
import { usePhone, useSheet } from "../tokens/motion";

export function ChannelHeader() {
  const chat = useChat();
  const call = useCall();
  const identity = useIdentity();
  // A two-person direct conversation gets a Call button until you are in its call.
  const peer = chat.current?.kind === "dm" ? chat.people.find(person => person.id === chat.current?.peerId) : undefined;
  const calling = call.phase !== "idle" && call.conversationId === chat.current?.id;
  const nav = useNav();
  const phone = usePhone();
  const sheet = useSheet();
  const side = (kind: "search" | "pins") => nav.set({ side: nav.side.kind === kind && !sheet ? { kind: "tabs", tab: "people" } : { kind }, sheet: true });
  // On a phone the other conversations live in the drawer, so the menu button says when one of them wants you.
  const elsewhere = chat.conversations.filter(conversation => conversation.id !== chat.current?.id).reduce((sum, conversation) => sum + conversation.mentions, 0);
  return (
    <header className="hc-header">
      {phone && (
        <span className="hc-header__menu">
          <IconButton icon="menu" label={copy.header.menu} data-menu-button="" onClick={() => nav.set({ screen: "list" })} />
          {elsewhere > 0 && <span className="hc-dot" role="img" aria-label={copy.channels.mentions(elsewhere)} />}
        </span>
      )}
      <div className="hc-header__title">
        <h1>{chat.current?.name}</h1>
        {chat.current?.kind === "channel" && <small>{copy.header.in(identity.serverName)}</small>}
      </div>
      {call.available && peer && !calling && <IconButton icon="phone" label={copy.call.callPerson(peer.name)} onClick={() => void call.callPerson(peer.id)} />}
      <IconButton icon="search" label={copy.header.search} active={nav.side.kind === "search"} onClick={() => side("search")} />
      <IconButton icon="pin" label={copy.header.pins} active={nav.side.kind === "pins"} onClick={() => side("pins")} />
      {sheet && <IconButton icon="people" label={copy.header.people} onClick={() => nav.set({ side: { kind: "tabs", tab: "people" }, sheet: true })} />}
      <IconButton icon="settings" label={copy.header.settings} onClick={() => nav.set({ main: "settings", section: phone ? null : identity.owner ? "invites" : "about" })} />
    </header>
  );
}
