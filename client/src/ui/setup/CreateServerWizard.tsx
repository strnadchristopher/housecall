import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useChat, useIdentity } from "../../core/context";
import { copy } from "../copy";
import { Avatar, Button, ErrorLine, Field, IconButton, MediaDropzone, Presence, cx } from "../kit";

import { prepareImage } from "../settings/resizeImage";
import { IntegrationSetup } from "./IntegrationSetup";
import { CALL_CARDS, EXTRA_CARDS } from "./steps";

const PICTURE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const OPTIONAL_CHANNELS = [{ key: "lounge", name: "Voice lounge" }, { key: "music", name: "Music" }] as const;
const LAST = 4;

/**
 * Five steps: name and icon, channels, calls, extras, invite. The server exists as soon as step 1
 * is submitted, so leaving early keeps it. Only step 1 and the channels step change anything.
 */
export function CreateServerWizard({ onClose }: { onClose: () => void }) {
  const chat = useChat();
  const identity = useIdentity();
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [icon, setIcon] = useState<File>();
  const [created, setCreated] = useState<{ id: string; name: string; iconFailed: boolean }>();
  const [problem, setProblem] = useState("");
  const [picked, setPicked] = useState<Record<string, boolean>>({ lounge: false, music: false });
  const made = useRef(new Set<string>());
  const [link, setLink] = useState("");
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(document.activeElement);

  useEffect(() => {
    root.current?.querySelector<HTMLElement>("input, button")?.focus();
    const back = opener.current;
    return () => { if (back instanceof HTMLElement) back.focus(); };
  }, []);

  const leave = () => (created && !confirming ? setConfirming(true) : onClose());
  // On the document, because focus drops to the page when a step's field unmounts.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault(); event.stopPropagation();
      if (confirming) setConfirming(false); else leave();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  });

  const submitServer = async (event?: FormEvent) => {
    event?.preventDefault();
    const clean = name.trim();
    if (!clean || created) return;
    setProblem(""); setBusy(true);
    try {
      let blob: Blob | undefined;
      if (icon) {
        try { blob = await prepareImage(icon); } catch (error) { setProblem(error instanceof Error ? error.message : String(error)); return; }
      }
      const result = await chat.createServer(clean, blob);
      if (result) { setCreated({ ...result, name: clean }); setStep(1); }
    } finally { setBusy(false); }
  };

  const submitChannels = async () => {
    setBusy(true);
    try {
      for (const option of OPTIONAL_CHANNELS) {
        if (!picked[option.key] || made.current.has(option.key)) continue;
        if (!(await chat.createChannel(option.name, []))) return;
        made.current.add(option.key);
      }
      setStep(2);
    } finally { setBusy(false); }
  };

  const makeInvite = async () => {
    setCopied(false);
    const result = await identity.createInvite({ expiresInSeconds: 604800 });
    if (result.link) setLink(result.link);
  };
  // The invite step shows the link as soon as it opens: one request, made once.
  const asked = useRef(false);
  useEffect(() => {
    if (step !== LAST || asked.current) return;
    asked.current = true;
    void makeInvite();
  }, [step]);
  const copyLink = async () => {
    try { await navigator.clipboard.writeText(link); setCopied(true); } catch { setCopied(false); }
  };

  const next = () => {
    if (step === 0) void submitServer();
    else if (step === 1) void submitChannels();
    else if (step < LAST) setStep(step + 1);
    else onClose();
  };
  const nextLabel = step === 0 && !created ? copy.wizard.create : step === LAST ? copy.wizard.done : copy.wizard.next;
  const nextDisabled = step === 0 && (!name.trim() || chat.busy || busy);

  const slide = (index: number, label: string, body: ReactNode) => (
    <Presence show={step === index}>
      <section className="hc-wizard__step hc-anim-slide-right" aria-labelledby={`hc-wizard-h-${index}`} data-testid={`wizard-step-${index + 1}`}>
        <h2 id={`hc-wizard-h-${index}`}>{label}</h2>
        {body}
      </section>
    </Presence>
  );

  return (
      <div className="hc-wizard hc-anim-fade" role="dialog" aria-modal="true" aria-label={copy.wizard.title} ref={root} data-testid="create-server-wizard">
        <div className="hc-wizard__panel">
          <header className="hc-wizard__head">
            <div>
              <h1>{copy.wizard.title}</h1>
              <p className="hc-muted" aria-live="polite">{copy.wizard.stepOf(step + 1, LAST + 1)}</p>
            </div>
            <IconButton icon="close" label={copy.common.close} onClick={leave} />
          </header>
          <ol className="hc-wizard__dots" aria-label={copy.wizard.title}>
            {copy.wizard.steps.map((label, index) => (
              <li key={label} className={cx(index === step && "is-current", index < step && "is-done")} aria-current={index === step ? "step" : undefined}>{label}</li>
            ))}
          </ol>
          <div className="hc-wizard__stage">
            {slide(0, copy.wizard.steps[0], (
              <form className="hc-stack" onSubmit={event => void submitServer(event)}>
                {created
                  ? <p className="hc-person"><Avatar name={created.name} size="lg" shape="squircle" /><span><strong>{copy.wizard.created(created.name)}</strong></span></p>
                  : <>
                      <Field label={copy.profile.serverName} value={name} onChange={event => setName(event.target.value)} maxLength={48} required />
                      <MediaDropzone label={copy.profile.serverIcon} accept={PICTURE_TYPES} maxBytes={8 * 1024 * 1024} hint={copy.profile.pictureHint} typeError={copy.profile.pictureType} value={icon} onChange={setIcon} />
                    </>}
                {created?.iconFailed && <p className="hc-field__error" role="alert">{copy.wizard.iconFailed}</p>}
              </form>
            ))}
            {slide(1, copy.wizard.steps[1], (
              <div className="hc-stack">
                <p className="hc-muted">{copy.wizard.channelsIntro}</p>
                <fieldset className="hc-checks">
                  <label className="hc-check"><input type="checkbox" checked disabled /><span>{copy.wizard.general}</span></label>
                  {OPTIONAL_CHANNELS.map(option => (
                    <label key={option.key} className="hc-check">
                      <input type="checkbox" checked={picked[option.key]} disabled={made.current.has(option.key)} onChange={event => setPicked({ ...picked, [option.key]: event.target.checked })} />
                      <span>{option.name}</span>
                    </label>
                  ))}
                </fieldset>
              </div>
            ))}
            {slide(2, copy.wizard.steps[2], (
              <div className="hc-stack">
                <p className="hc-muted">{copy.wizard.callsIntro}</p>
                <IntegrationSetup only={CALL_CARDS} deviceTestFirst />
              </div>
            ))}
            {slide(3, copy.wizard.steps[3], (
              <div className="hc-stack">
                <p className="hc-muted">{copy.wizard.extrasIntro}</p>
                <IntegrationSetup only={EXTRA_CARDS} />
              </div>
            ))}
            {slide(4, copy.wizard.steps[4], (
              <div className="hc-stack">
                <p className="hc-muted">{copy.wizard.inviteIntro}</p>
                {link
                  ? <div className="hc-copy">
                      <Field label={copy.settings.inviteLink} value={link} readOnly onFocus={event => event.target.select()} data-testid="wizard-invite-link" />
                      <Button onClick={() => void copyLink()}>{copied ? copy.common.copied : copy.common.copy}</Button>
                    </div>
                  : identity.error && <Button kind="primary" busy={identity.busy} onClick={() => void makeInvite()}>{copy.common.retry}</Button>}
              </div>
            ))}
          </div>
          <ErrorLine text={problem || chat.error || identity.error} />
          {confirming && (
            <div className="hc-wizard__confirm" role="alertdialog" aria-label={copy.wizard.leave}>
              <p><strong>{copy.wizard.leave}</strong> {copy.wizard.leaveBody}</p>
              <div className="hc-inline">
                <Button onClick={() => setConfirming(false)}>{copy.wizard.leaveNo}</Button>
                <Button kind="danger" onClick={onClose}>{copy.wizard.leaveYes}</Button>
              </div>
            </div>
          )}
          <footer className="hc-wizard__foot">
            {step > 1 ? <Button kind="text" onClick={() => setStep(step - 1)}>{copy.common.back}</Button> : <span />}
            <Button kind="primary" busy={busy} disabled={nextDisabled} onClick={next}>{nextLabel}</Button>
          </footer>
        </div>
      </div>
  );
}
