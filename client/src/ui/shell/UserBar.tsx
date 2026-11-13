import { useChat } from "../../core/context";
import { copy } from "../copy";
import { Avatar, IconButton } from "../kit";
import { usePhone } from "../tokens/motion";
import { useNav } from "./nav";

export function UserBar() {
  const chat = useChat();
  const nav = useNav();
  const phone = usePhone();
  const dmMentions = chat.conversations.filter(conversation => (conversation.kind === "dm" || conversation.kind === "group")).reduce((sum, conversation) => sum + conversation.mentions, 0);
  return (
    <footer className="hc-userbar">
      <button type="button" className="hc-userbar__me" aria-label={copy.userBar.profile} title={copy.userBar.profile}
        onClick={() => nav.set({ main: "settings", section: "account", screen: "main" })}>
        <Avatar name={chat.me.name} src={chat.me.avatarUrl} />
        <span className="hc-userbar__name">
          <strong>{chat.me.name}</strong>
          <small>{chat.online ? copy.state.connected : copy.state.reconnecting}</small>
        </span>
      </button>
      <span className="hc-userbar__mail">
        <IconButton icon="mail" label={copy.userBar.messages} active={nav.left === "dm"} onClick={() => nav.set({ left: nav.left === "dm" ? "channels" : "dm", screen: "list" })} />
        {dmMentions > 0 && <span className="hc-dot" role="img" aria-label={copy.channels.mentions(dmMentions)} />}
      </span>
      <IconButton icon="gear" label={copy.userBar.settings} active={nav.main === "settings"}
        onClick={() => nav.set(nav.main === "settings" ? { main: "chat" } : { main: "settings", section: phone ? null : "account", screen: "main" })} />
    </footer>
  );
}
