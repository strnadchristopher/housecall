import { useChat } from "../../core/context";
import { copy } from "../copy";
import { Avatar, Icon, IconButton, cx } from "../kit";
import { useNav } from "../shell/nav";
import { FriendList } from "./FriendList";

/** Direct messages: existing conversations, then the people you can message. */
export function DmView() {
  const chat = useChat();
  const nav = useNav();
  const direct = chat.conversations.filter(conversation => (conversation.kind === "dm" || conversation.kind === "group"));
  return (
    <section className="hc-channels hc-dm" data-testid="screen-direct-messages" aria-labelledby="hc-dm-label">
      <div className="hc-dm__head">
        <IconButton icon="back" label={copy.common.back} onClick={() => nav.set({ left: "channels" })} />
        <h2 id="hc-dm-label" className="hc-label">{copy.dm.label}</h2>
      </div>
      <ul>
        {direct.map(conversation => {
          const here = conversation.id === chat.current?.id;
          return (
            <li key={conversation.id}>
              <button type="button" className={cx("hc-channel", here && "is-current", conversation.mentions > 0 && "is-unread")}
                aria-current={here ? "page" : undefined} aria-label={copy.channels.open(conversation.name)}
                onClick={() => { nav.set({ main: "chat", screen: "main" }); if (!here) void chat.open(conversation.id); }}>
                <Avatar name={conversation.name} size="sm" />
                <span className="hc-channel__name">{conversation.name}</span>
                {conversation.mentions > 0 && <span className="hc-count" aria-label={copy.channels.mentions(conversation.mentions)}>{conversation.mentions}</span>}
                <span className="hc-channel__chev" aria-hidden="true"><Icon name="right" /></span>
              </button>
            </li>
          );
        })}
      </ul>
      <FriendList />
    </section>
  );
}
