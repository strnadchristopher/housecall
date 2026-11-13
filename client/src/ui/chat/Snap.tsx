import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Attachment, ChatMessage } from "../../core/chat";
import { useChat } from "../../core/context";
import { copy } from "../copy";
import { Button, Icon, IconButton, Presence } from "../kit";
import { SnapCamera, cameraSupported } from "../snap/SnapCamera";

/** How long a snap stays on screen once opened. */
const VIEW_SECONDS = 10;

/** Esc closes, focus moves to the first button and returns to where it was. */
function useDialogFocus(root: React.RefObject<HTMLElement | null>, onClose: () => void) {
  const latest = useRef(onClose);
  latest.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.stopPropagation(); latest.current(); }
    };
    document.addEventListener("keydown", onKey, true);
    root.current?.querySelector<HTMLElement>("button")?.focus();
    return () => { document.removeEventListener("keydown", onKey, true); previous?.focus?.(); };
  }, [root]);
}

/**
 * The photo, full screen, for ten seconds. Tap anywhere to close. There is no save control and the
 * image takes no pointer events, so there is no long-press menu to save it from.
 * `src` goes away the moment it closes, while the fade out is still playing.
 */
function SnapViewer({ src, onClose }: { src?: string; onClose: () => void }) {
  const [left, setLeft] = useState(VIEW_SECONDS);
  const root = useRef<HTMLDivElement>(null);
  const latest = useRef(onClose);
  latest.current = onClose;
  useDialogFocus(root, onClose);
  const live = !!src;
  useEffect(() => {
    if (!live) return;
    const end = setTimeout(() => latest.current(), VIEW_SECONDS * 1000);
    const tick = setInterval(() => setLeft(value => Math.max(0, value - 1)), 1000);
    return () => { clearTimeout(end); clearInterval(tick); };
  }, [live]);
  return (
    <div ref={root} className="hc-snapview hc-anim-fade" role="dialog" aria-modal="true" aria-label={copy.snaps.snap}
      onClick={onClose} onContextMenu={event => event.preventDefault()}>
      <div className="hc-snapview__top" onClick={event => event.stopPropagation()}>
        <span className="hc-snapview__track" aria-hidden="true">
          <span className="hc-snapview__fill" style={{ "--hc-snap-done": `${((VIEW_SECONDS - left) / VIEW_SECONDS) * 100}%` } as React.CSSProperties} />
        </span>
        <span className="hc-snapview__left" role="timer" aria-label={copy.snaps.left(left)}>{copy.snaps.left(left)}</span>
        <IconButton icon="close" label={copy.snaps.close} onClick={onClose} />
      </div>
      {src && <img className="hc-snapview__photo" src={src} alt={copy.snaps.photo} draggable={false} data-testid="snap-image" />}
    </div>
  );
}

/** A snap in the conversation: tap to view for a recipient, the opened count for the sender. */
export function SnapTile({ message, attachment }: { message: ChatMessage; attachment: Attachment }) {
  const chat = useChat();
  const snap = attachment.snap ?? { opened: false, openedCount: 0, recipients: 0 };
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState<string>();
  const [error, setError] = useState("");
  const held = useRef<string | undefined>(undefined);
  const release = useCallback(() => {
    if (held.current) URL.revokeObjectURL(held.current);
    held.current = undefined;
    setUrl(undefined);
  }, []);
  const close = useCallback(() => { setOpen(false); release(); }, [release]);
  useEffect(() => release, [release]);

  const view = async () => {
    setBusy(true); setError("");
    try {
      const photo = await chat.openSnap(attachment.id);
      if (photo === "gone") { setError(copy.snaps.gone); return; }
      held.current = URL.createObjectURL(photo);
      setUrl(held.current);
      setOpen(true);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : copy.snaps.gone);
    } finally {
      setBusy(false);
    }
  };

  const received = !message.mine;
  const waiting = received && attachment.kind === "snap" && !snap.opened;
  const line = message.mine ? copy.snaps.openedBy(snap.openedCount, snap.recipients)
    : snap.opened ? copy.snaps.opened
    : attachment.kind === "snap_expired" ? copy.snaps.expired : busy ? copy.snaps.opening : copy.snaps.tap;
  const body = <><Icon name="snap" /><span><strong>{copy.snaps.snap}</strong><small>{line}</small></span></>;
  return (
    <>
      {waiting
        ? <button type="button" className="hc-snap" data-testid="snap-tile" data-state="unopened" aria-busy={busy || undefined} disabled={busy}
            aria-label={`${copy.snaps.snap}, ${copy.snaps.tap}`} onClick={() => void view()}>{body}</button>
        : <div className="hc-snap is-static" data-testid="snap-tile" data-state={message.mine ? "sent" : snap.opened ? "opened" : "expired"}>{body}</div>}
      {error && <p className="hc-error" role="alert">{error}</p>}
      {createPortal(
        <Presence show={open}>
          <SnapViewer src={url} onClose={close} />
        </Presence>,
        document.body,
      )}
    </>
  );
}

/** Composer camera: takes a photo with the device camera, shows it, and sends it as a snap. */
export function SnapCapture() {
  const chat = useChat();
  const input = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const [photo, setPhoto] = useState<File>();
  const [preview, setPreview] = useState<string>();
  useEffect(() => {
    if (!photo) { setPreview(undefined); return; }
    const next = URL.createObjectURL(photo);
    setPreview(next);
    return () => URL.revokeObjectURL(next);
  }, [photo]);
  const [failed, setFailed] = useState(false);
  const [camera, setCamera] = useState(false);
  useEffect(() => setFailed(false), [photo]);
  const send = async () => {
    if (!photo) return;
    setFailed(false);
    if (await chat.sendSnap(photo)) setPhoto(undefined); else setFailed(true);
  };
  return (
    <>
      <IconButton icon="snap" label={copy.snaps.take} onClick={() => { if (cameraSupported()) setCamera(true); else input.current?.click(); }} />
      <input ref={input} type="file" accept="image/*" capture="environment" className="hc-sr" tabIndex={-1} aria-hidden="true" data-testid="snap-capture"
        onChange={event => { const chosen = event.target.files?.[0]; event.target.value = ""; if (chosen) setPhoto(chosen); }} />
      {createPortal(
        <Presence show={camera}>
          <SnapCamera onClose={() => setCamera(false)} onSend={chat.sendSnap} error={chat.error} />
        </Presence>,
        document.body,
      )}
      {createPortal(
        <Presence show={!!photo}>
          <SnapPreview root={root} src={preview} busy={chat.busy} error={failed ? chat.error : ""} onSend={() => void send()} onCancel={() => setPhoto(undefined)} />
        </Presence>,
        document.body,
      )}
    </>
  );
}

function SnapPreview({ root, src, busy, error, onSend, onCancel }: {
  root: React.RefObject<HTMLDivElement | null>; src?: string; busy: boolean; error: string; onSend: () => void; onCancel: () => void;
}) {
  useDialogFocus(root, onCancel);
  return (
    <div ref={root} className="hc-snapview hc-anim-fade" role="dialog" aria-modal="true" aria-label={copy.snaps.preview}>
      {src && <img className="hc-snapview__photo" src={src} alt={copy.snaps.preview} draggable={false} data-testid="snap-preview" />}
      <div className="hc-snapview__bar">
        <small>{error || copy.snaps.once}</small>
        <Button kind="text" onClick={onCancel} disabled={busy}>{copy.common.cancel}</Button>
        <Button kind="primary" onClick={onSend} busy={busy}>{busy ? copy.snaps.sending : copy.snaps.send}</Button>
      </div>
    </div>
  );
}
