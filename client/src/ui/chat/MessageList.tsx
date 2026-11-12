import { useEffect, useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import { useChat } from "../../core/context";
import { copy } from "../copy";
import { day } from "../format";
import { cx } from "../kit";
import { GimmeCard } from "./GimmeCard";
import { Message } from "./Message";

const GROUP_WINDOW_MS = 5 * 60 * 1000;

/** Messages oldest first, grouped by author, pinned to the newest unless the reader scrolled up. */
export function MessageList({ compact }: { compact?: boolean }) {
  const chat = useChat();
  const scroller = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const stick = useRef(true);
  const last = chat.messages.at(-1)?.id;
  // Roving tabindex: one message row is the tab stop (the newest until another is focused); arrows move between rows.
  const [focused, setFocused] = useState<string>();
  const stopId = chat.messages.some(message => message.id === focused) ? focused : last;
  const remember = (event: FocusEvent<HTMLOListElement>) => {
    const id = (event.target as HTMLElement).closest<HTMLElement>(".hc-msg")?.dataset.messageId;
    if (id) setFocused(id);
  };
  const navigate = (event: KeyboardEvent<HTMLOListElement>) => {
    const target = event.target as HTMLElement;
    if (!target.classList.contains("hc-msg")) return;
    const key = event.key;
    if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(key)) return;
    const rows = [...event.currentTarget.querySelectorAll<HTMLElement>(":scope > .hc-msg")];
    const at = rows.indexOf(target);
    const next = key === "Home" ? 0 : key === "End" ? rows.length - 1 : at + (key === "ArrowUp" ? -1 : 1);
    if (next < 0 || next >= rows.length) return;
    event.preventDefault();
    rows[next].focus();
    rows[next].scrollIntoView({ block: "nearest" });
  };
  useLayoutEffect(() => {
    const node = scroller.current;
    if (node && stick.current) node.scrollTop = node.scrollHeight;
  }, [last, chat.messages.length, chat.requests.length, chat.current?.id]);
  // Images, GIFs and video posters load after the messages render and grow the list (or the composer shrinks the view):
  // keep the newest message in view while the reader is at the bottom.
  useEffect(() => {
    const node = scroller.current, content = list.current;
    if (!node || !content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => { if (stick.current) node.scrollTop = node.scrollHeight; });
    observer.observe(content); observer.observe(node);
    return () => observer.disconnect();
  }, []);
  // Reading the newest message clears the mention count.
  useEffect(() => {
    if (last && stick.current && chat.current?.mentions && document.visibilityState === "visible") void chat.markRead();
  }, [last, chat.current?.mentions]);
  return (
    <div ref={scroller} className={cx("hc-messages", compact && "is-compact")} data-testid="screen-conversation"
      onScroll={event => { const node = event.currentTarget; stick.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80; }}>
      <button type="button" className="hc-sr hc-skip" onClick={() => document.querySelector<HTMLTextAreaElement>(".hc-composer textarea")?.focus()}>{copy.messages.skip}</button>
      <ol ref={list} aria-label={copy.messages.label} onFocus={remember} onKeyDown={navigate}>
        {chat.messages.map((message, index) => {
          const before = chat.messages[index - 1];
          const newDay = !before || new Date(before.createdAt).toDateString() !== new Date(message.createdAt).toDateString();
          const grouped = !newDay && !message.replyTo && before.authorId === message.authorId && message.createdAt - before.createdAt < GROUP_WINDOW_MS;
          return <Message key={message.id} message={message} grouped={grouped} me={chat.me.name} day={newDay ? day(message.createdAt) : undefined} stop={message.id === stopId} />;
        })}
        {chat.requests.map(request => <GimmeCard key={request.id} request={request} />)}
      </ol>
      {chat.loading && chat.messages.length === 0 && <p className="hc-muted hc-loading" role="status">{copy.common.loading}</p>}
      <p className="hc-typing" role="status">{chat.typing.length > 0 ? copy.messages.typing(chat.typing) : ""}</p>
    </div>
  );
}
