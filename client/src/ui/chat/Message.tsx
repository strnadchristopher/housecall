import { memo, useEffect, useRef, useState } from "react";
import type { ChatMessage, LinkPreview } from "../../core/chat";
import { useChat } from "../../core/context";
import { copy } from "../copy";
import { bytes, time } from "../format";
import { Avatar, Button, Icon, IconButton, cx } from "../kit";
import { EmojiPicker } from "./EmojiPicker";
import { GifClip } from "./GifPicker";
import { MessageBody } from "./Markdown";

function Player({ messageId, attachmentId, onClose }: { messageId: string; attachmentId: string; onClose: () => void }) {
  const chat = useChat();
  const element = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState("");
  useEffect(() => (element.current ? chat.playVideo(element.current, messageId, attachmentId, setError) : undefined), [messageId, attachmentId]);
  return (
    <div className="hc-player">
      <video ref={element} controls playsInline data-testid="uploaded-media" aria-label={copy.messages.video} />
      {error && <p className="hc-error" role="alert">{error}</p>}
      <Button kind="text" onClick={onClose}>{copy.messages.closeVideo}</Button>
    </div>
  );
}

/** One message. Actions show on hover or focus (desktop) and on tap (touch). */
export const Message = memo(function Message({ message, grouped, me }: { message: ChatMessage; grouped: boolean; me: string }) {
  const chat = useChat();
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<"" | "react" | "unsend">("");
  const [preview, setPreview] = useState<LinkPreview>();
  const [playing, setPlaying] = useState<string>();
  const onlyGif = message.gifs.length === 1 && /^https:\/\/giphy\.com\/gifs\/\w+$/.test(message.body.trim());
  return (
    <li className={cx("hc-msg", grouped && "is-grouped", message.mentionsMe && "is-mention", open && "is-open")} data-message-id={message.id}
      onClick={event => { if (!(event.target as HTMLElement).closest("button, a, video, input")) setOpen(value => !value); }}>
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
        {message.attachments.map(attachment => (
          <div key={attachment.id} className="hc-file">
            <Icon name={attachment.video ? "film" : "file"} />
            <span><strong>{attachment.filename}</strong><small>{bytes(attachment.size)}</small></span>
            {attachment.video && <IconButton icon="play" label={`${copy.messages.play} ${attachment.filename}`} onClick={() => setPlaying(attachment.id)} />}
            <IconButton icon="download" label={`${copy.messages.download} ${attachment.filename}`} onClick={() => void chat.download(attachment)} />
          </div>
        ))}
        {playing && <Player messageId={message.id} attachmentId={playing} onClose={() => setPlaying(undefined)} />}
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
        {panel === "react" && <EmojiPicker onPick={emoji => { setPanel(""); void chat.react(message.id, emoji); }} />}
        {panel === "unsend" && (
          <div className="hc-msg__confirm">
            <Button kind="danger" onClick={() => { setPanel(""); void chat.unsend(message.id); }}>{copy.messages.unsendConfirm}</Button>
            <Button kind="text" onClick={() => setPanel("")}>{copy.common.cancel}</Button>
          </div>
        )}
      </div>
      <div className="hc-msg__bar" role="toolbar" aria-label={copy.messages.label}>
        <IconButton icon="reply" label={copy.messages.reply} onClick={() => chat.reply(message.id)} />
        <IconButton icon="emoji" label={copy.messages.react} active={panel === "react"} onClick={() => setPanel(panel === "react" ? "" : "react")} />
        <IconButton icon="pin" off={message.pinned} label={message.pinned ? copy.messages.unpin : copy.messages.pin} onClick={() => void chat.pin(message.id)} />
        {message.link && !preview && <IconButton icon="link" label={copy.messages.preview} onClick={() => void chat.preview(message.id).then(setPreview)} />}
        {message.canEdit && <IconButton icon="edit" label={copy.messages.edit} onClick={() => chat.edit(message.id)} />}
        {message.canUnsend && <IconButton icon="trash" className="hc-ibtn--danger" label={copy.messages.unsend} active={panel === "unsend"} onClick={() => setPanel(panel === "unsend" ? "" : "unsend")} />}
      </div>
    </li>
  );
});
