import { useEffect, useLayoutEffect, useRef } from "react";
import { useChat } from "../../core/context";
import { copy } from "../copy";
import { day } from "../format";
import { GimmeCard } from "./GimmeCard";
import { Message } from "./Message";

const GROUP_WINDOW_MS = 5 * 60 * 1000;

/** Messages oldest first, grouped by author, pinned to the newest unless the reader scrolled up. */
export function MessageList() {
  const chat = useChat();
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const last = chat.messages.at(-1)?.id;
  useLayoutEffect(() => {
    const node = scroller.current;
    if (node && stick.current) node.scrollTop = node.scrollHeight;
  }, [last, chat.messages.length, chat.requests.length, chat.current?.id]);
  // Reading the newest message clears the mention count.
  useEffect(() => {
    if (last && stick.current && chat.current?.mentions && document.visibilityState === "visible") void chat.markRead();
  }, [last, chat.current?.mentions]);
  return (
    <div ref={scroller} className="hc-messages" data-testid="screen-conversation"
      onScroll={event => { const node = event.currentTarget; stick.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80; }}>
      <ol aria-label={copy.messages.label}>
        {chat.messages.map((message, index) => {
          const before = chat.messages[index - 1];
          const newDay = !before || new Date(before.createdAt).toDateString() !== new Date(message.createdAt).toDateString();
          const grouped = !newDay && !message.replyTo && before.authorId === message.authorId && message.createdAt - before.createdAt < GROUP_WINDOW_MS;
          return [
            newDay && <li key={`day-${message.id}`} className="hc-day" role="separator">{day(message.createdAt)}</li>,
            <Message key={message.id} message={message} grouped={grouped} me={chat.me.name} />,
          ];
        })}
        {chat.requests.map(request => <GimmeCard key={request.id} request={request} />)}
      </ol>
      <p className="hc-typing" role="status">{chat.typing.length > 0 ? copy.messages.typing(chat.typing) : ""}</p>
    </div>
  );
}
