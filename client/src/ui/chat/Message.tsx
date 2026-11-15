import { memo, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { ChatMessage, LinkPreview } from "../../core/chat";
import { useChat } from "../../core/context";
import { copy } from "../copy";
import { time } from "../format";
import { Avatar, Button, Icon, IconButton, Presence, cx } from "../kit";
import { usePhone } from "../tokens/motion";
import { useDismiss } from "../useDismiss";
import { Attachments } from "./Attachments";
import { EmojiPicker } from "./EmojiPicker";
import { GifClip } from "./GifPicker";
import { MessageBody } from "./Markdown";

function PlainMarker({ tabIndex }: { tabIndex: number }) {
  const [open, setOpen] = useState(false), id = useId();
  const root = useRef<HTMLButtonElement>(null);
  useDismiss(open, () => setOpen(false), root);
  return <button ref={root} type="button" tabIndex={tabIndex} className="hc-msg__plain hc-tipped" aria-describedby={id} data-open={open || undefined} onClick={() => setOpen(!open)}>
    {copy.e2e.plain}<span className="hc-tip hc-tip--wrap" role="tooltip" id={id}>{copy.e2e.plainTip}</span>
  </button>;
}

/** One message. Actions show on hover or focus (desktop) and on tap (touch). */
export const Message = memo(function Message({ message, grouped, me, day, stop, open, onToggle }: { message: ChatMessage; grouped: boolean; me: string; day?: string; stop: boolean; open: boolean; onToggle: (id: string) => void }) {
  const chat = useChat();
  const phone = usePhone();
  // The row is one tab stop (roving, arrow keys in MessageList); Enter enters its toolbar, Escape leaves it.
  const [entered, setEntered] = useState(false);
  const row = useRef<HTMLLIElement>(null);
  const toolTab = entered ? 0 : -1;
  const onRowKey = (event: KeyboardEvent<HTMLLIElement>) => {
    if (event.target === row.current && event.key === "Enter") {
      if (phone && !open) onToggle(message.id);
      event.preventDefault();
      setEntered(true);
      requestAnimationFrame(() => row.current?.querySelector<HTMLElement>(".hc-msg__bar button")?.focus());
    } else if (event.key === "Escape" && entered && panel === "") {
      event.preventDefault();
      event.stopPropagation();
      setEntered(false);
      if (phone && open) onToggle(message.id);
      row.current?.focus();
    }
  };
  const [panel, setPanel] = useState<"" | "react" | "unsend">("");
  useEffect(() => { if (!open) setPanel(""); }, [open]);
  // A reaction or unsend panel opened from a hover or focus bar also closes on an outside press or Escape.
  useDismiss(panel !== "", () => setPanel(""), target => !!target.closest(".hc-emoji, .hc-msg__confirm, [data-panel-toggle]"));
  const [trayHidden, setTrayHidden] = useState(false);
  useEffect(() => { if (!open) setTrayHidden(false); }, [open]);
  const [preview, setPreview] = useState<LinkPreview>();
  const onlyGif = message.gifs.length === 1 && /^https:\/\/giphy\.com\/gifs\/\w+$/.test(message.body.trim());
  return (
    <li ref={row} className={cx("hc-msg", grouped && "is-grouped", message.mentionsMe && "is-mention", open && "is-open")} data-message-id={message.id}
      tabIndex={stop ? 0 : -1} onKeyDown={onRowKey}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setEntered(false); }}
      onClick={event => { if (!(event.target as HTMLElement).closest("button, a, video, img, input, .hc-media")) { setTrayHidden(false); onToggle(message.id); } }}>
      {day && <p className="hc-day">{day}</p>}
      <div className="hc-msg__gutter">{!grouped && <Avatar name={message.authorName} src={message.authorAvatarUrl} />}</div>
      <div className="hc-msg__main">
        {message.replyTo && (
          <p className="hc-msg__reply"><Icon name="reply" /><strong>{message.replyTo.authorName}</strong><span>{message.replyTo.excerpt}</span></p>
        )}
        {!grouped && (
          <p className="hc-msg__head">
            <strong>{message.authorName}</strong>
            <time dateTime={new Date(message.createdAt).toISOString()}>{time(message.createdAt)}</time>
            {(message.plaintextMarker || message.security?.status === "plaintext" && message.security.marker) && <PlainMarker tabIndex={toolTab} />}
            {message.pinned && <span className="hc-msg__flag"><Icon name="pin" />{copy.messages.pinned}</span>}
          </p>
        )}
        {grouped && (message.plaintextMarker || message.security?.status === 'plaintext' && message.security.marker) && <PlainMarker tabIndex={toolTab} />}
        {message.security?.status === 'opened' && ['unchecked', 'edited'].includes(message.security.reply) && <p className="hc-msg__reply">{message.security.reply === 'edited' ? copy.e2e.replyEdited : copy.e2e.replyUnchecked}</p>}
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
        <Presence show={panel === "react"}>
          <EmojiPicker onClose={() => setPanel("")} onPick={emoji => { setPanel(""); void chat.react(message.id, emoji); }} />
        </Presence>
        <Presence show={panel === "unsend"}>
          <div className="hc-msg__confirm hc-anim-pop">
            <Button kind="danger" onClick={() => { setPanel(""); void chat.unsend(message.id); }}>{copy.messages.unsendConfirm}</Button>
            <Button kind="text" onClick={() => setPanel("")}>{copy.common.cancel}</Button>
          </div>
        </Presence>
      <div className={cx("hc-msg__bar", phone && trayHidden && "is-suspended")} role="toolbar" aria-label={copy.messages.label}>
        <IconButton tabIndex={toolTab} icon="reply" text={copy.messages.reply} label={copy.messages.reply} disabled={!!message.security && message.security.status !== 'opened' && !!chat.dmSecurity?.peer.pin} onClick={() => { chat.reply(message.id); if (phone) onToggle(message.id); }} />
        <IconButton data-panel-toggle="" tabIndex={toolTab} icon="emoji" text={copy.messages.react} label={copy.messages.react} active={panel === "react"} onClick={() => { setPanel(panel === "react" ? "" : "react"); setTrayHidden(true); }} />
        <IconButton tabIndex={toolTab} icon="pin" off={message.pinned} text={message.pinned ? copy.messages.unpin : copy.messages.pin} label={message.pinned ? copy.messages.unpin : copy.messages.pin} onClick={() => void chat.pin(message.id)} />
        <IconButton className={!message.link || preview ? "hc-msg__optional" : undefined} disabled={!message.link || !!preview} tabIndex={toolTab} icon="link" text={copy.messages.previewShort} label={copy.messages.preview} onClick={() => void chat.preview(message.id).then(setPreview)} />
        <IconButton className={!message.canEdit ? "hc-msg__optional" : undefined} disabled={!message.canEdit} tabIndex={toolTab} icon="edit" text={copy.messages.edit} label={copy.messages.edit} onClick={() => { chat.edit(message.id); if (phone) onToggle(message.id); }} />
        <IconButton disabled={!message.canUnsend} data-panel-toggle="" tabIndex={toolTab} icon="trash" className={cx("hc-ibtn--danger", !message.canUnsend && "hc-msg__optional")} text={copy.messages.unsend} label={copy.messages.unsend} active={panel === "unsend"} onClick={() => { setPanel(panel === "unsend" ? "" : "unsend"); setTrayHidden(true); }} />
      </div>
      </div>
    </li>
  );
});
