import { useEffect, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react";
import { useChat } from "../core/context";
import { copy } from "./copy";
import { afterExit, prefersReducedMotion } from "./tokens/motion";

/**
 * House icons: 20 unit grid, one stroke weight, round caps. The recurring
 * figure is the doorway arch (flat base, round top): microphone, people and
 * the Chords mark are all built from it.
 */
const ICONS = {
  search: "M9 3.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 0 0 0-11M13.2 13.2L17 17",
  settings: "M3 6.5h2M9 6.5h8M3 13.5h8M15 13.5h2M7 4.5a2 2 0 1 0 0 4a2 2 0 0 0 0-4M13 11.5a2 2 0 1 0 0 4a2 2 0 0 0 0-4",
  gear: "M10 7.4a2.6 2.6 0 1 0 0 5.2a2.6 2.6 0 0 0 0-5.2M10 2.8v2M10 15.2v2M2.8 10h2M15.2 10h2M4.9 4.9l1.4 1.4M13.7 13.7l1.4 1.4M4.9 15.1l1.4-1.4M13.7 6.3l1.4-1.4",
  mail: "M5 5h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2M3.6 6.4L10 11l6.4-4.6",
  plus: "M10 4v12M4 10h12",
  emoji: "M10 3a7 7 0 1 0 0 14a7 7 0 0 0 0-14M7 11.6c.8 1.2 1.8 1.8 3 1.8s2.2-.6 3-1.8M7.6 8v.4M12.4 8v.4",
  gif: "M4.5 5h11a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2M8 8.6c-.4-.5-.9-.8-1.6-.8c-1.2 0-2 .9-2 2.2s.8 2.2 2 2.2c.9 0 1.6-.5 1.7-1.7H6.7M10.4 7.9v4.2M12.6 12.1V7.9h2.6M12.6 10.1h2",
  mic: "M10 2.8a2.6 2.6 0 0 1 2.6 2.6v4.2a2.6 2.6 0 0 1-5.2 0V5.4A2.6 2.6 0 0 1 10 2.8M5.2 9.6a4.8 4.8 0 0 0 9.6 0M10 14.4v2.8",
  headphones: "M4 12v-1.5a6 6 0 0 1 12 0V12M4 11.6h1.6v5H4.8a1.6 1.6 0 0 1-1.6-1.6v-1.8a1.6 1.6 0 0 1 .8-1.6M16 11.6h-1.6v5h.8a1.6 1.6 0 0 0 1.6-1.6v-1.8a1.6 1.6 0 0 0-.8-1.6",
  camera: "M4.5 5.5h6.5a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H4.5a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2M13 9l4.5-2.5v7L13 11",
  snap: "M4.5 6.5h2l1-1.5h5l1 1.5h2a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2M10 8.6a2.9 2.9 0 1 0 0 5.8a2.9 2.9 0 0 0 0-5.8",
  screen: "M4.5 4h11a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2M7 17h6M10 14v3",
  leave: "M3 12.2c0-1 .5-1.9 1.4-2.3c3.5-1.6 7.7-1.6 11.2 0c.9.4 1.4 1.3 1.4 2.3v.6c0 .7-.6 1.2-1.3 1.1l-1.9-.3c-.5-.1-.9-.5-.9-1v-1.1c-1.9-.6-3.9-.6-5.8 0v1.1c0 .5-.4.9-.9 1l-1.9.3c-.7.1-1.3-.4-1.3-1.1z",
  phone: "M6.4 3.5l1.5 3.3l-1.6 1.4c.9 2 2.5 3.6 4.5 4.5l1.4-1.6l3.3 1.5v2.4c0 .8-.7 1.5-1.5 1.5C8.5 16.5 3.5 11.5 3.5 6c0-.8.7-1.5 1.5-1.5z",
  down: "M5 7.5l5 5l5-5",
  right: "M7.5 5l5 5l-5 5",
  back: "M12.5 5l-5 5l5 5",
  // The short third line points back toward the edge the drawer comes from.
  menu: "M3.5 5.5h13M3.5 10h13M3.5 14.5h8",
  close: "M5 5l10 10M15 5L5 15",
  check: "M4 10.5l4 4l8-9",
  send: "M10 16V4M5 9l5-5l5 5",
  reply: "M8 5L3.5 9.5L8 14M3.5 9.5h8a5 5 0 0 1 5 5v1",
  edit: "M12.5 4l3.5 3.5L7.5 16H4v-3.5z",
  pin: "M10 12.5V17M6 12.5h8M7.5 3.5h5l-.6 4.5l2.1 4.5H6l2.1-4.5z",
  trash: "M4 6h12M8 6V4h4v2M5.5 6l.8 10h7.4l.8-10",
  people: "M7.5 4.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 0 0 0-5M3 16v-1a4.5 4.5 0 0 1 9 0v1M14 6a2 2 0 1 0 0 4a2 2 0 0 0 0-4M13.6 11.6a3.6 3.6 0 0 1 3.4 3.6V16",
  chords: "M3.5 16V9a2 2 0 0 1 4 0v7M8 16V6.5a2 2 0 0 1 4 0V16M12.5 16v-5.5a2 2 0 0 1 4 0V16",
  copy: "M9 7h5a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2M4 13V5.5A1.5 1.5 0 0 1 5.5 4H13",
  link: "M8.5 11.5a3 3 0 0 0 4.2 0l2.6-2.6a3 3 0 0 0-4.2-4.2l-1 1M11.5 8.5a3 3 0 0 0-4.2 0l-2.6 2.6a3 3 0 0 0 4.2 4.2l1-1",
  play: "M7 4.5v11l9-5.5z",
  pause: "M7 4.5v11M13 4.5v11",
  stop: "M7 5.5h6a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 13V7A1.5 1.5 0 0 1 7 5.5",
  film: "M5 4h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2M7 4v12M13 4v12M3 8h4M3 12h4M13 8h4M13 12h4",
  music: "M8 15V5l8-1.5v10M6 13a2 2 0 1 0 0 4a2 2 0 0 0 0-4M14 11.5a2 2 0 1 0 0 4a2 2 0 0 0 0-4",
  browser: "M4.5 4h11a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2M2.5 8h15M5.5 6v.2",
  download: "M10 3.5v9M6 9l4 4l4-4M4 16.5h12",
  file: "M6 3h5l4 4v8.5a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 5 15.5v-11A1.5 1.5 0 0 1 6 3M11 3v4h4",
  slash: "M4 3.5l12 13",
  image: "M4.5 4h11a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2M3 14.5l4.2-4.2l3 3l2.3-2.3L17 15M13 7.9v.2",
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, off }: { name: IconName; off?: boolean }) {
  return (
    <svg className="hc-icon" viewBox="0 0 20 20" aria-hidden="true">
      <path d={ICONS[name]} />
      {off && <path d={ICONS.slash} />}
    </svg>
  );
}

export const cx = (...names: (string | false | undefined | null)[]) => names.filter(Boolean).join(" ");

function hash(text: string) {
  let value = 0;
  for (let index = 0; index < text.length; index++) value = (value * 31 + text.charCodeAt(index)) >>> 0;
  return value;
}

/**
 * Object URLs for small avatar and icon images, shared by every Avatar showing the same path.
 * Paths carry a revision (?v=), so a changed image is a new key. The signed-in user id is part of
 * the key so two accounts or hosts never share an entry. Entries live until the page closes: they
 * are at most 512 KB each and only as many as there are people and servers.
 */
const pictures = new Map<string, Promise<string>>();

function usePicture(path: string | undefined) {
  const chat = useChat();
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    setUrl(undefined);
    if (!path) return;
    const key = `${chat.me.id}|${path}`;
    let live = true;
    let pending = pictures.get(key);
    if (!pending) {
      pending = chat.fetchMedia(path).then(blob => URL.createObjectURL(blob));
      pictures.set(key, pending);
      pending.catch(() => pictures.delete(key));
    }
    pending.then(next => { if (live) setUrl(next); }, () => {});
    return () => { live = false; };
  }, [path, chat.me.id]);
  return url;
}

/**
 * The person's picture, or their initial in a doorway arch in one of six tones mixed from the palette.
 * Servers use the same component with the squircle shape. `src` is an authenticated media path.
 */
export function Avatar({ name, src, size = "md", shape = "arch" }: { name: string; src?: string; size?: "sm" | "md" | "lg"; shape?: "arch" | "squircle" }) {
  const picture = usePicture(src);
  return (
    <span className={cx("hc-avatar", `hc-avatar--${size}`, shape === "squircle" && "hc-avatar--squircle")} data-tone={hash(name) % 6} data-has-image={picture ? "" : undefined} aria-hidden="true">
      {picture ? <img src={picture} alt="" /> : (name.trim()[0] ?? "?").toUpperCase()}
    </span>
  );
}

/**
 * Keeps `children` mounted while they play their exit animation (`data-state="exit"` selects it in CSS).
 * The exiting copy is inert and ignores the pointer, so it never blocks a click on what is underneath.
 * With reduced motion it unmounts at once. `ms` matches `--hc-dur-base`.
 */
export function Presence({ show, children, ms = 190 }: { show: boolean; children: ReactNode; ms?: number }) {
  const [mounted, setMounted] = useState(show);
  useEffect(() => {
    if (show) { setMounted(true); return; }
    return afterExit(ms, prefersReducedMotion(), () => setMounted(false));
  }, [show, ms]);
  // Reduced motion unmounts in the same commit as the close, not a frame later in the effect.
  if (!show && (!mounted || prefersReducedMotion())) return null;
  return <div className="hc-presence" data-state={show ? "enter" : "exit"} inert={!show}>{children}</div>;
}

const DROP_COPY = copy.dropzone;

/**
 * One drop zone for every image field: click to browse, drag and drop, or paste.
 * Validates type and size before anything leaves the device and shows a small preview.
 */
export function MediaDropzone({ label, accept, maxBytes, value, onChange, hint, typeError, lead }: {
  label: string; accept: string[]; maxBytes: number; value?: File; onChange: (file?: File) => void; hint?: string; typeError?: string;
  /** Shown under the label, inside the field: the picture the field currently holds. */
  lead?: ReactNode;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<string>();
  useEffect(() => {
    if (!value) { setPreview(undefined); return; }
    const url = URL.createObjectURL(value);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [value]);
  const take = (file?: File) => {
    if (!file) return;
    if (!accept.includes(file.type)) return setError(typeError ?? DROP_COPY.type);
    if (file.size > maxBytes) return setError(DROP_COPY.size(maxBytes));
    setError("");
    onChange(file);
  };
  return (
    <div className="hc-field" role="group" aria-label={label}>
      <span className="hc-field__label">{label}</span>
      {lead}
      <div className={cx("hc-drop", over && "is-over", value && "has-file")} data-testid="dropzone"
        onDragOver={event => { event.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
        onDrop={event => { event.preventDefault(); setOver(false); take(event.dataTransfer.files[0]); }}
        onPaste={event => take([...event.clipboardData.files][0])}>
        {value && preview
          ? <>
              <img src={preview} alt="" className="hc-drop__preview" />
              <span className="hc-drop__name">{value.name}</span>
              <IconButton icon="close" label={DROP_COPY.remove} onClick={() => { setError(""); onChange(undefined); }} />
            </>
          : <button type="button" className="hc-drop__cta" onClick={() => input.current?.click()}>
              <Icon name="image" /><strong>{DROP_COPY.cta}</strong><small>{hint ?? DROP_COPY.hint}</small>
            </button>}
        <input ref={input} type="file" accept={accept.join(",")} className="hc-sr" tabIndex={-1} aria-hidden="true"
          onChange={event => { take(event.target.files?.[0]); event.target.value = ""; }} />
      </div>
      {error && <p className="hc-field__error" role="alert">{error}</p>}
    </div>
  );
}

export function IconButton({ icon, label, off, active, className, ...rest }: {
  icon: IconName; label: string; off?: boolean; active?: boolean;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" {...rest} className={cx("hc-ibtn", active && "is-active", className)} aria-label={label} title={label}>
      <Icon name={icon} off={off} />
    </button>
  );
}

export function Button({ kind = "plain", busy, className, children, ...rest }: {
  kind?: "primary" | "plain" | "danger" | "text"; busy?: boolean; children: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" {...rest} className={cx("hc-btn", `hc-btn--${kind}`, className)} disabled={rest.disabled || busy} aria-busy={busy || undefined}>
      {children}
    </button>
  );
}

export function Field({ label, hideLabel, className, ...rest }: { label: string; hideLabel?: boolean } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className={cx("hc-field", className)}>
      <span className={hideLabel ? "hc-sr" : "hc-field__label"}>{label}</span>
      <input {...rest} aria-label={hideLabel ? label : undefined} />
    </label>
  );
}

export function ErrorLine({ text, onDismiss, dismissLabel }: { text: string; onDismiss?: () => void; dismissLabel?: string }) {
  if (!text) return null;
  return (
    <p className="hc-error" role="alert">
      <span>{text}</span>
      {onDismiss && dismissLabel && <IconButton icon="close" label={dismissLabel} onClick={onDismiss} />}
    </p>
  );
}
