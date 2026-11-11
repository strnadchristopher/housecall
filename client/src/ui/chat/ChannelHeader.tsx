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
  return (
    <header className="hc-header">
      {phone && <IconButton icon="back" label={copy.common.back} onClick={() => nav.set({ screen: "list" })} />}
      <div className="hc-header__title">
        <h1>{chat.current?.name}</h1>
        {chat.current?.kind === "channel" && <small>{copy.header.in(identity.serverName)}</small>}
      </div>
      {call.available && peer && !calling && <IconButton icon="phone" label={copy.call.callPerson(peer.name)} onClick={() => void call.callPerson(peer.id)} />}
      <IconButton icon="search" label={copy.header.search} active={nav.side.kind === "search"} onClick={() => side("search")} />
      <IconButton icon="pin" label={copy.header.pins} active={nav.side.kind === "pins"} onClick={() => side("pins")} />
      {sheet && <IconButton icon="people" label={copy.header.people} onClick={() => nav.set({ side: { kind: "tabs", tab: "people" }, sheet: true })} />}
      <IconButton icon="settings" label={copy.header.settings} onClick={() => nav.set({ main: "settings", section: identity.owner ? "invites" : "about" })} />
    </header>
  );
}
