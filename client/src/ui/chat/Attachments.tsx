import { useEffect, useRef, useState } from "react";
import type { Attachment, ChatMessage } from "../../core/chat";
import { useChat } from "../../core/context";
import { copy } from "../copy";
import { bytes } from "../format";
import { Icon, IconButton, Presence } from "../kit";
import { useMediaUrl } from "./useMediaUrl";

const INLINE_IMAGE_LIMIT = 25 * 1024 * 1024;

function FileCard({ attachment }: { attachment: Attachment }) {
  const chat = useChat();
  return (
    <div className="hc-file">
      <Icon name={attachment.video ? "film" : "file"} />
      <span><strong>{attachment.filename}</strong><small>{bytes(attachment.size)}</small></span>
      <IconButton icon="download" label={`${copy.messages.download} ${attachment.filename}`} onClick={() => void chat.download(attachment)} />
    </div>
  );
}

function Lightbox({ attachment, src, onClose }: { attachment: Attachment; src: string; onClose: () => void }) {
  const chat = useChat();
  const close = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.stopPropagation(); onClose(); }
    };
    document.addEventListener("keydown", onKey, true);
    close.current?.querySelector<HTMLElement>("button")?.focus();
    return () => { document.removeEventListener("keydown", onKey, true); previous?.focus?.(); };
  }, []);
  return (
    <div className="hc-lightbox hc-anim-fade" role="dialog" aria-modal="true" aria-label={attachment.filename} onClick={onClose}>
      <img src={src} alt={attachment.filename} onClick={event => event.stopPropagation()} data-testid="lightbox-image" />
      <div className="hc-lightbox__bar" ref={close} onClick={event => event.stopPropagation()}>
        <IconButton icon="close" label={copy.messages.closeImage} onClick={onClose} />
        <IconButton icon="download" label={`${copy.messages.download} ${attachment.filename}`} onClick={() => void chat.download(attachment)} />
      </div>
    </div>
  );
}

function InlineImage({ attachment }: { attachment: Attachment }) {
  const { url, error } = useMediaUrl(`/api/media/${encodeURIComponent(attachment.id)}`);
  const [zoom, setZoom] = useState(false);
  if (error) return <FileCard attachment={attachment} />;
  return (
    <>
      <button type="button" className="hc-media hc-media--image" onClick={() => setZoom(true)} aria-label={`${copy.messages.open} ${attachment.filename}`}>
        {url ? <img src={url} alt={attachment.filename} decoding="async" data-testid="inline-image" /> : <span className="hc-media__skeleton" />}
      </button>
      <Presence show={zoom && !!url}>
        {url && <Lightbox attachment={attachment} src={url} onClose={() => setZoom(false)} />}
      </Presence>
    </>
  );
}

function Player({ messageId, attachment }: { messageId: string; attachment: Attachment }) {
  const chat = useChat();
  const element = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState("");
  const poster = useMediaUrl(attachment.thumbnail).url;
  useEffect(() => (element.current ? chat.playVideo(element.current, messageId, attachment.id, setError) : undefined), [messageId, attachment.id]);
  return (
    <>
      <video ref={element} controls playsInline preload="metadata" poster={poster} data-testid="uploaded-media" aria-label={copy.messages.video} />
      {error && <p className="hc-error" role="alert">{error}</p>}
    </>
  );
}

function InlineVideo({ message, attachment }: { message: ChatMessage; attachment: Attachment }) {
  if (attachment.kind === "video_pending") {
    return (
      <div className="hc-media hc-media--pending" role="status" data-testid="video-processing">
        <Icon name="film" /><span>{copy.messages.processingVideo}<small>{attachment.filename}</small></span>
      </div>
    );
  }
  return <div className="hc-media hc-media--video"><Player messageId={message.id} attachment={attachment} /></div>;
}

/** Images and GIFs render in place, videos play in place, everything else is a file card. */
export function Attachments({ message }: { message: ChatMessage }) {
  if (message.attachments.length === 0) return null;
  return (
    <div className="hc-attachments">
      {message.attachments.map(a =>
        (a.kind === "image" || a.kind === "gif") && Number(a.size) <= INLINE_IMAGE_LIMIT ? <InlineImage key={a.id} attachment={a} />
        : a.kind === "video" || a.kind === "video_pending" ? <InlineVideo key={a.id} message={message} attachment={a} />
        : <FileCard key={a.id} attachment={a} />)}
    </div>
  );
}
