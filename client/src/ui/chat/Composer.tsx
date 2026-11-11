import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useChat } from "../../core/context";
import { copy } from "../copy";
import { bytes } from "../format";
import { Button, IconButton } from "../kit";
import { EmojiPicker } from "./EmojiPicker";
import { GifPicker } from "./GifPicker";

/** Attach, text, emoji, GIF. Uploads, replies, edits and mention suggestions sit above the field. */
export function Composer() {
  const chat = useChat();
  const [panel, setPanel] = useState<"" | "emoji" | "gif">("");
  const input = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const upload = chat.upload;
  useEffect(() => { if (chat.replyingTo || chat.editing) input.current?.focus(); }, [chat.replyingTo?.id, chat.editing?.id]);
  useEffect(() => setPanel(""), [chat.current?.id]);
  if (!chat.current) return null;

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (chat.draft.trim() || chat.attached.length) void chat.send();
  };
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); }
    if (event.key === "Escape" && (chat.replyingTo || chat.editing)) { event.preventDefault(); chat.cancelCompose(); }
  };
  const uploadState = upload && { uploading: copy.composer.uploading, paused: copy.composer.paused, held: copy.composer.held, ready: copy.composer.ready, failed: copy.composer.failed }[upload.state];

  return (
    <form className="hc-composer" data-testid="screen-composer" onSubmit={submit}>
      {(chat.replyingTo || chat.editing) && (
        <div className="hc-composer__context">
          <span>{chat.editing ? copy.composer.editing : copy.composer.replying(chat.replyingTo!.authorName)}</span>
          <Button kind="text" onClick={chat.cancelCompose}>{copy.common.cancel}</Button>
        </div>
      )}
      {chat.suggestions.length > 0 && (
        <ul className="hc-composer__suggest" aria-label={copy.side.people}>
          {chat.suggestions.map(suggestion => (
            <li key={`${suggestion.kind}-${suggestion.id}`}>
              <button type="button" onClick={() => { chat.complete(suggestion); input.current?.focus(); }}>
                @{suggestion.label}{suggestion.kind === "role" && <small> {copy.composer.role}</small>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {upload && upload.state !== "ready" && (
        <div className="hc-upload" data-testid="upload" data-state={upload.state}>
          <span className="hc-upload__name"><strong>{upload.filename}</strong><small>{uploadState} · {bytes(upload.sent)} / {bytes(upload.total)}</small></span>
          {upload.note && <span className="hc-upload__note">{upload.note}</span>}
          {upload.state === "uploading" && <Button kind="text" onClick={chat.pauseUpload}>{copy.composer.pause}</Button>}
          {(upload.state === "paused" || upload.state === "failed") && <Button kind="text" onClick={() => void chat.resumeUpload()}>{copy.composer.resume}</Button>}
          {upload.state === "held" && <Button kind="text" onClick={() => void chat.checkScan()}>{copy.composer.checkScan}</Button>}
          {upload.state === "held" && upload.canRetryScan && <Button kind="text" onClick={() => void chat.retryScan()}>{copy.composer.retryScan}</Button>}
          <IconButton icon="close" label={`${copy.common.remove} ${upload.filename}`} onClick={chat.discardUpload} />
        </div>
      )}
      {chat.attached.length > 0 && (
        <ul className="hc-composer__files">
          {chat.attached.map(item => (
            <li key={item.id} className="hc-upload" data-testid="attached">
              <span className="hc-upload__name"><strong>{item.filename}</strong>
                <small>{upload?.video ? copy.composer.video[upload.video.state] : copy.composer.ready}{upload?.video?.error ? ` · ${upload.video.error}` : ""}</small>
              </span>
              {upload?.canPrepareVideo && upload.filename === item.filename && <Button kind="text" onClick={() => void chat.prepareVideo()}>{copy.composer.prepareVideo}</Button>}
              <IconButton icon="close" label={`${copy.common.remove} ${item.filename}`} onClick={() => chat.removeAttached(item.id)} />
            </li>
          ))}
        </ul>
      )}
      {panel === "emoji" && <EmojiPicker onPick={emoji => { chat.setDraft(chat.draft + emoji); input.current?.focus(); }} />}
      {panel === "gif" && <GifPicker onDone={() => setPanel("")} />}
      <div className="hc-composer__row">
        {chat.can.attach && (
          <>
            <IconButton icon="plus" label={copy.composer.attach} onClick={() => picker.current?.click()} />
            <input ref={picker} type="file" className="hc-sr" tabIndex={-1} aria-hidden="true"
              onChange={event => { const chosen = event.target.files?.[0]; event.target.value = ""; if (chosen) void chat.attach(chosen); }} />
          </>
        )}
        <textarea ref={input} rows={1} name="body" aria-label={copy.composer.label} placeholder={copy.composer.placeholder(chat.current.name)}
          value={chat.draft} onChange={event => chat.setDraft(event.target.value)} onKeyDown={onKey} />
        <IconButton icon="emoji" label={copy.composer.emoji} active={panel === "emoji"} onClick={() => setPanel(panel === "emoji" ? "" : "emoji")} />
        {chat.can.gif && <IconButton icon="gif" label={copy.composer.gif} active={panel === "gif"} onClick={() => setPanel(panel === "gif" ? "" : "gif")} />}
        <IconButton icon="send" className="hc-composer__send" label={chat.editing ? copy.composer.saveEdit : copy.composer.send} type="submit"
          disabled={chat.busy || !(chat.draft.trim() || chat.attached.length)} />
      </div>
    </form>
  );
}
