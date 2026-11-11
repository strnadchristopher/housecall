import { memo, useRef, useState, type KeyboardEvent } from "react";
import type { ChatMessage, LinkPreview } from "../../core/chat";
import { useChat } from "../../core/context";
import { copy } from "../copy";
import { time } from "../format";
import { Avatar, Button, Icon, IconButton, cx } from "../kit";
import { Attachments } from "./Attachments";
import { EmojiPicker } from "./EmojiPicker";
import { GifClip } from "./GifPicker";
import { MessageBody } from "./Markdown";

/** One message. Actions show on hover or focus (desktop) and on tap (touch). */
export const Message = memo(function Message({ message, grouped, me, day, stop }: { message: ChatMessage; grouped: boolean; me: string; day?: string; stop: boolean }) {
  const chat = useChat();
  const [open, setOpen] = useState(false);
  // The row is one tab stop (roving, arrow keys in MessageList); Enter enters its toolbar, Escape leaves it.
  const [entered, setEntered] = useState(false);
  const row = useRef<HTMLLIElement>(null);
  const toolTab = entered ? 0 : -1;
  const onRowKey = (event: KeyboardEvent<HTMLLIElement>) => {
    if (event.target === row.current && event.key === "Enter") {
      event.preventDefault();
      setEntered(true);
      requestAnimationFrame(() => row.current?.querySelector<HTMLElement>(".hc-msg__bar button")?.focus());
    } else if (event.key === "Escape" && entered && panel === "") {
      event.preventDefault();
      event.stopPropagation();
      setEntered(false);
      row.current?.focus();
    }
  };
  const [panel, setPanel] = useState<"" | "react" | "unsend">("");
  const [preview, setPreview] = useState<LinkPreview>();
  const onlyGif = message.gifs.length === 1 && /^https:\/\/giphy\.com\/gifs\/\w+$/.test(message.body.trim());
  return (
    <li ref={row} className={cx("hc-msg", grouped && "is-grouped", message.mentionsMe && "is-mention", open && "is-open")} data-message-id={message.id}
      tabIndex={stop ? 0 : -1} onKeyDown={onRowKey}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setEntered(false); }}
      onClick={event => { if (!(event.target as HTMLElement).closest("button, a, video, img, input, .hc-media")) setOpen(value => !value); }}>
      {day && <p className="hc-day">{day}</p>}
      <div className="hc-msg__gutter">{!grouped && <Avatar name={message.authorName} />}</div>
      <div className="hc-msg__main">
        {message.replyTo && (
          <p className="hc-msg__reply"><Icon name="reply" /><strong>{message.replyTo.authorName}</strong><span>{message.replyTo.excerpt}</span></p>
        )}
        {!grouped && (
          <p className="hc-msg__head">
            <strong>{message.authorName}</strong>
            <time dateTime={new Date(message.createdAt).toISOString()}>{time(message.createdAt)}</time>
            {message.pinned && <span className="hc-msg__flag"><Icon name="pin" />{copy.messages.pinned}</span>}
          </p>
        )}
        {!onlyGif && <MessageBody nodes={message.nodes} text={message.body} me={me} />}
        {grouped && message.pinned && <span className="hc-msg__flag"><Icon name="pin" />{copy.messages.pinned}</span>}
        {message.editedAt && <small className="hc-msg__edited">{copy.messages.edited}</small>}
        {message.gifs.map(id => <GifClip key={id} id={id} title={copy.messages.gif} />)}
        <Attachments message={message} />
        {preview && (
          <a className="hc-preview" href={preview.url} target="_blank" rel="noopener noreferrer nofollow">
            <small>{preview.hostname}</small><strong>{preview.title}</strong><span>{preview.description}</span>
          </a>
        )}
        {message.reactions.length > 0 && (
          <div className="hc-reacts">
            {message.reactions.map(reaction => (
              <button key={reaction.emoji} type="button" className={cx("hc-react", reaction.mine && "is-mine")}
                aria-label={`${reaction.emoji} ${reaction.count}`} onClick={() => void chat.react(message.id, reaction.emoji)}>
                <span>{reaction.emoji}</span><span>{reaction.count}</span>
              </button>
            ))}
          </div>
        )}
        {panel === "react" && <EmojiPicker onClose={() => setPanel("")} onPick={emoji => { setPanel(""); void chat.react(message.id, emoji); }} />}
        {panel === "unsend" && (
          <div className="hc-msg__confirm">
            <Button kind="danger" onClick={() => { setPanel(""); void chat.unsend(message.id); }}>{copy.messages.unsendConfirm}</Button>
            <Button kind="text" onClick={() => setPanel("")}>{copy.common.cancel}</Button>
          </div>
        )}
      <div className="hc-msg__bar" role="toolbar" aria-label={copy.messages.label}>
        <IconButton tabIndex={toolTab} icon="reply" label={copy.messages.reply} onClick={() => chat.reply(message.id)} />
        <IconButton tabIndex={toolTab} icon="emoji" label={copy.messages.react} active={panel === "react"} onClick={() => setPanel(panel === "react" ? "" : "react")} />
        <IconButton tabIndex={toolTab} icon="pin" off={message.pinned} label={message.pinned ? copy.messages.unpin : copy.messages.pin} onClick={() => void chat.pin(message.id)} />
        {message.link && !preview && <IconButton tabIndex={toolTab} icon="link" label={copy.messages.preview} onClick={() => void chat.preview(message.id).then(setPreview)} />}
        {message.canEdit && <IconButton tabIndex={toolTab} icon="edit" label={copy.messages.edit} onClick={() => chat.edit(message.id)} />}
        {message.canUnsend && <IconButton tabIndex={toolTab} icon="trash" className="hc-ibtn--danger" label={copy.messages.unsend} active={panel === "unsend"} onClick={() => setPanel(panel === "unsend" ? "" : "unsend")} />}
      </div>
      </div>
    </li>
  );
});
