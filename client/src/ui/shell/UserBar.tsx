import { useChat } from "../../core/context";
import { copy } from "../copy";
import { Avatar, IconButton } from "../kit";
import { useNav } from "./nav";

export function UserBar() {
  const chat = useChat();
  const nav = useNav();
  const dmMentions = chat.conversations.filter(conversation => conversation.kind !== "channel").reduce((sum, conversation) => sum + conversation.mentions, 0);
  return (
    <footer className="hc-userbar">
      <Avatar name={chat.me.name} />
      <span className="hc-userbar__name">
        <strong>{chat.me.name}</strong>
        <small>{chat.online ? copy.state.connected : copy.state.offline}</small>
      </span>
      <span className="hc-userbar__mail">
        <IconButton icon="mail" label={copy.userBar.messages} active={nav.left === "dm"} onClick={() => nav.set({ left: nav.left === "dm" ? "channels" : "dm", screen: "list" })} />
        {dmMentions > 0 && <span className="hc-dot" role="img" aria-label={copy.channels.mentions(dmMentions)} />}
      </span>
      <IconButton icon="settings" label={copy.userBar.settings} active={nav.main === "settings"}
        onClick={() => nav.set(nav.main === "settings" ? { main: "chat" } : { main: "settings", section: "account", screen: "main" })} />
    </footer>
  );
}
