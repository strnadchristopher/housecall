import { useEffect, useState, type FormEvent } from "react";
import { useChat, useIdentity } from "../../core/context";
import { copy } from "../copy";
import { Button, ErrorLine, Field, MediaDropzone } from "../kit";
import { Sheet } from "../Sheet";
import { prepareImage } from "../settings/resizeImage";

const PICTURE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const C = copy.createServer;

/** One field (name) and an optional icon. On success the new server is already current; offer an invite. */
export function CreateServerDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const chat = useChat();
  const identity = useIdentity();
  const [name, setName] = useState("");
  const [icon, setIcon] = useState<File>();
  const [error, setError] = useState("");
  const [made, setMade] = useState<{ name: string; iconFailed: boolean }>();
  const [link, setLink] = useState("");
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setName(""); setIcon(undefined); setError(""); setMade(undefined); setLink(""); setCopied(false); } }, [open]);
  // The sheet takes focus when it opens; move it to the one field once that has happened.
  useEffect(() => {
    if (!open || made) return;
    const timer = window.setTimeout(() => document.querySelector<HTMLInputElement>("#hc-create-server input[type=text], #hc-create-server input:not([type])")?.focus(), 60);
    return () => window.clearTimeout(timer);
  }, [open, made]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const clean = name.trim();
    if (!clean || busy) return;
    setError(""); setBusy(true);
    try {
      let blob: Blob | undefined;
      if (icon) {
        try { blob = await prepareImage(icon); } catch (problem) { setError(problem instanceof Error ? problem.message : String(problem)); return; }
      }
      const result = await chat.createServer(clean, blob);
      if (result) setMade({ name: clean, iconFailed: result.iconFailed });
      else setError(chat.error || copy.common.retry);
    } finally { setBusy(false); }
  };
  const invitePeople = async () => {
    setBusy(true); setCopied(false);
    try {
      const result = await identity.createInvite({ expiresInSeconds: 604800, maxUses: 1 });
      if (result.link) setLink(result.link); else setError(identity.error || copy.common.retry);
    } finally { setBusy(false); }
  };
  const copyLink = async () => {
    try { await navigator.clipboard.writeText(link); setCopied(true); } catch { setCopied(false); }
  };

  return (
    <Sheet open={open} onClose={onClose} title={made ? C.created(made.name) : C.title} testId="create-server"
      actions={made
        ? <>
            {!link && <Button kind="primary" busy={busy} onClick={() => void invitePeople()}>{C.invite}</Button>}
            <Button kind={link ? "primary" : "text"} onClick={onClose}>{copy.common.done}</Button>
          </>
        : <>
            <Button kind="primary" type="submit" form="hc-create-server" busy={busy} disabled={!name.trim()}>{C.create}</Button>
            <Button kind="text" onClick={onClose}>{copy.common.cancel}</Button>
          </>}>
      {made
        ? <div className="hc-stack">
            {made.iconFailed && <p className="hc-field__error" role="alert">{copy.wizard.iconFailed}</p>}
            {link && (
              <div className="hc-copy">
                <Field label={copy.settings.inviteLink} value={link} readOnly onFocus={event => event.target.select()} data-testid="create-server-invite-link" />
                <Button onClick={() => void copyLink()}>{copied ? copy.common.copied : copy.common.copy}</Button>
              </div>
            )}
            <ErrorLine text={error} />
          </div>
        : <form id="hc-create-server" className="hc-stack" onSubmit={event => void submit(event)}>
            <Field label={copy.profile.serverName} value={name} onChange={event => setName(event.target.value)} maxLength={48} autoFocus required />
            <MediaDropzone label={copy.profile.serverIcon} accept={PICTURE_TYPES} maxBytes={8 * 1024 * 1024} hint={copy.profile.pictureHint} typeError={copy.profile.pictureType} value={icon} onChange={setIcon} />
            <ErrorLine text={error} onDismiss={() => setError("")} dismissLabel={copy.common.dismiss} />
          </form>}
    </Sheet>
  );
}
