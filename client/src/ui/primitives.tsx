import {
  useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type KeyboardEvent as RKeyboardEvent,
  type ReactNode, type TextareaHTMLAttributes,
} from 'react';
import { Icon, type IconName } from './icons/Icon';
import type { Phase, Presence, UserView } from './model';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');
export { cx };

/* ── Buttons ─────────────────────────────────────────────────────────── */

type BtnVariant = 'primary' | 'quiet' | 'raised' | 'danger';
interface BtnProps extends ButtonHTMLAttributes<HTMLButtonElement> { variant?: BtnVariant; icon?: IconName; busy?: boolean; size?: 'm' | 'l' }

export function Button({ variant = 'raised', icon, busy, size = 'm', className, children, disabled, ...rest }: BtnProps) {
  return (
    <button type="button" className={cx('cc-btn', `cc-btn--${variant}`, size === 'l' && 'cc-btn--l', busy && 'is-busy', className)} disabled={disabled || busy} aria-busy={busy || undefined} {...rest}>
      {busy ? <Dots /> : icon ? <Icon name={icon} size={18} /> : null}
      <span>{children}</span>
    </button>
  );
}

interface IconBtnProps extends ButtonHTMLAttributes<HTMLButtonElement> { icon: IconName; label: string; active?: boolean; tone?: 'danger' | 'accent'; size?: number; tip?: 'top' | 'bottom' | 'left' | 'right' | false }

/** Square icon control. The label is the accessible name and the tooltip. */
export function IconButton({ icon, label, active, tone, size = 20, tip = 'top', className, ...rest }: IconBtnProps) {
  return (
    <button
      type="button"
      className={cx('cc-ibtn', active && 'is-active', tone && `cc-ibtn--${tone}`, className)}
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
      data-tip={tip ? label : undefined}
      data-tip-at={tip || undefined}
      {...rest}
    >
      <Icon name={icon} size={size} />
    </button>
  );
}

/* ── Avatar: the dressed stone ───────────────────────────────────────── */

/** Earth and water hues only: no violet or blue-purple avatars. */
const HUES = [28, 52, 96, 150, 178, 12, 205, 70];
function hueOf(id: string) { let h = 0; for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return HUES[h % HUES.length]; }

/** The initial is drawn with CSS (data-initial) so it never leaks into the row's text content. */
export function Avatar({ user, name: rawName, size = 36, presence = true, speaking, className }: { user?: UserView; name?: string; size?: number; presence?: boolean; speaking?: boolean; className?: string }) {
  const name = user?.name ?? rawName ?? '?';
  const hue = hueOf(user?.id ?? name);
  const p: Presence | undefined = presence ? user?.presence : undefined;
  const initial = Array.from(name.replace(/^[^\p{L}\p{N}]+/u, ''))[0]?.toUpperCase() ?? '?';
  return (
    <span className={cx('cc-avatar', speaking && 'is-speaking', className)} aria-hidden={p ? undefined : true} style={{ width: size, height: size, ['--h' as string]: hue, ['--s' as string]: `${size}px` }}>
      <span className="cc-avatar__stone">
        {user?.avatarUrl ? <img src={user.avatarUrl} alt="" /> : <span className="cc-avatar__mono" data-initial={initial} />}
      </span>
      {p && p !== 'offline' && <span className={`cc-avatar__p cc-p--${p}`} role="img" aria-label={p === 'dnd' ? 'Do not disturb' : p} />}
    </span>
  );
}

/* ── Inputs ──────────────────────────────────────────────────────────── */

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> { label: string; hint?: ReactNode; error?: string; trailing?: ReactNode }
export function Field({ label, hint, error, trailing, className, id, ...rest }: FieldProps) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <div className={cx('cc-field', error && 'has-error', className)}>
      <label htmlFor={fid}>{label}</label>
      <div className="cc-field__box">
        <input id={fid} aria-invalid={!!error || undefined} aria-describedby={error || hint ? fid + '-d' : undefined} {...rest} />
        {trailing}
      </div>
      {(error || hint) && <p id={fid + '-d'} className={error ? 'cc-field__err' : 'cc-field__hint'} role={error ? 'alert' : undefined}>{error ?? hint}</p>}
    </div>
  );
}

interface AreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> { label: string; hint?: ReactNode; error?: string }
export function TextArea({ label, hint, error, className, id, ...rest }: AreaProps) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <div className={cx('cc-field', error && 'has-error', className)}>
      <label htmlFor={fid}>{label}</label>
      <div className="cc-field__box"><textarea id={fid} aria-invalid={!!error || undefined} {...rest} /></div>
      {(error || hint) && <p className={error ? 'cc-field__err' : 'cc-field__hint'} role={error ? 'alert' : undefined}>{error ?? hint}</p>}
    </div>
  );
}

/** Switch: a block that slides along a cut track. Not a sun/moon pill. */
export function Toggle({ checked, onChange, label, detail, disabled, id }: { checked: boolean; onChange: (v: boolean) => void; label: string; detail?: ReactNode; disabled?: boolean; id?: string }) {
  const auto = useId();
  const tid = id ?? auto;
  return (
    <div className={cx('cc-toggle', disabled && 'is-disabled')}>
      <div className="cc-toggle__text">
        <label htmlFor={tid}>{label}</label>
        {detail && <p>{detail}</p>}
      </div>
      <button id={tid} type="button" role="switch" aria-checked={checked} disabled={disabled} className="cc-switch" onClick={() => onChange(!checked)}>
        <span className="cc-switch__knob" />
      </button>
    </div>
  );
}

/** Segmented single choice (radio group semantics, arrow-key navigation). */
export function Segmented<T extends string>({ value, options, onChange, label, size = 'm' }: { value: T; options: { value: T; label: string; icon?: IconName }[]; onChange: (v: T) => void; label: string; size?: 's' | 'm' }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  function key(e: RKeyboardEvent, i: number) {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const n = (i + d + options.length) % options.length;
    onChange(options[n].value);
    refs.current[n]?.focus();
  }
  const idx = Math.max(0, options.findIndex(o => o.value === value));
  return (
    <div className={cx('cc-seg', size === 's' && 'cc-seg--s')} role="radiogroup" aria-label={label} style={{ ['--n' as string]: options.length, ['--i' as string]: idx }}>
      <span className="cc-seg__thumb" aria-hidden />
      {options.map((o, i) => (
        <button key={o.value} ref={el => { refs.current[i] = el; }} type="button" role="radio" aria-checked={o.value === value} tabIndex={o.value === value ? 0 : -1} onClick={() => onChange(o.value)} onKeyDown={e => key(e, i)}>
          {o.icon && <Icon name={o.icon} size={16} />}{o.label}
        </button>
      ))}
    </div>
  );
}

/* ── Progress & loading ──────────────────────────────────────────────── */

export function Progress({ value, label, tone, indeterminate }: { value: number; label: string; tone?: 'warn' | 'danger' | 'ok'; indeterminate?: boolean }) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div className={cx('cc-progress', tone && `cc-progress--${tone}`, indeterminate && 'is-indeterminate')} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={indeterminate ? undefined : pct}>
      <span className="cc-progress__fill" style={{ width: indeterminate ? undefined : `${pct}%` }} />
    </div>
  );
}

/** Three diamonds stepping. Used inside buttons and quiet loading spots. */
export function Dots({ label }: { label?: string }) {
  return <span className="cc-dots" role={label ? 'status' : undefined} aria-label={label}><i /><i /><i /></span>;
}

export function Skeleton({ lines = 3, avatar = true }: { lines?: number; avatar?: boolean }) {
  return (
    <div className="cc-skel" aria-hidden>
      {avatar && <span className="cc-skel__av" />}
      <div className="cc-skel__lines">{Array.from({ length: lines }, (_, i) => <span key={i} style={{ width: `${[38, 86, 64, 72, 50][i % 5]}%` }} />)}</div>
    </div>
  );
}

/* ── Status surfaces ─────────────────────────────────────────────────── */

export function Banner({ tone = 'info', icon, children, action }: { tone?: 'info' | 'warn' | 'danger' | 'ok'; icon?: IconName; children: ReactNode; action?: ReactNode }) {
  return (
    <div className={`cc-banner cc-banner--${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
      {icon && <Icon name={icon} size={18} />}
      <div className="cc-banner__text">{children}</div>
      {action}
    </div>
  );
}

const PHASE_COPY: Record<Exclude<Phase, 'ready'>, { icon: IconName; title: string }> = {
  loading: { icon: 'diamond', title: 'Loading' },
  empty: { icon: 'chat', title: 'Nothing here yet' },
  error: { icon: 'warn', title: 'That did not load' },
  offline: { icon: 'offline', title: 'You are offline' },
  forbidden: { icon: 'lock', title: 'Not for you, sorry' },
  unavailable: { icon: 'diamond', title: 'Not available yet' },
};

/** One consistent treatment for loading / empty / error / offline / forbidden / unavailable. */
export function StateView({ phase, title, detail, action, compact, skeleton }: { phase: Exclude<Phase, 'ready'>; title?: string; detail?: ReactNode; action?: ReactNode; compact?: boolean; skeleton?: number }) {
  if (phase === 'loading' && skeleton) {
    return <div className="cc-state cc-state--skel" role="status" aria-label={title ?? 'Loading'}>{Array.from({ length: skeleton }, (_, i) => <Skeleton key={i} lines={(i % 3) + 1} />)}</div>;
  }
  const c = PHASE_COPY[phase];
  return (
    <div className={cx('cc-state', `cc-state--${phase}`, compact && 'cc-state--compact')} role={phase === 'error' ? 'alert' : 'status'}>
      {phase === 'loading' ? <Dots /> : <Icon name={c.icon} size={compact ? 20 : 26} className="cc-state__icon" />}
      <p className="cc-state__title">{title ?? c.title}</p>
      {detail && <p className="cc-state__detail">{detail}</p>}
      {action && <div className="cc-state__action">{action}</div>}
    </div>
  );
}

/* ── Overlays ────────────────────────────────────────────────────────── */

function useEscape(onClose?: () => void) {
  useEffect(() => {
    if (!onClose) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
}

function useFocusIn(ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>('[data-autofocus], input, textarea, button, [tabindex="0"]');
    first?.focus({ preventScroll: true });
    return () => prev?.focus?.({ preventScroll: true });
  }, [ref]);
}

/** Trap Tab inside a container. */
function trapTab(e: RKeyboardEvent<HTMLElement>) {
  if (e.key !== 'Tab') return;
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select, a[href], [tabindex="0"]'));
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

export function Dialog({ title, onClose, children, wide, className, footer, label }: { title: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean; className?: string; footer?: ReactNode; label?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const hid = useId();
  useEscape(onClose);
  useFocusIn(ref);
  return (
    <div className="cc-scrim" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} className={cx('cc-dialog', wide && 'cc-dialog--wide', className)} role="dialog" aria-modal="true" aria-labelledby={label ? undefined : hid} aria-label={label} onKeyDown={trapTab}>
        <header className="cc-dialog__head">
          <h2 id={hid}>{title}</h2>
          <IconButton icon="close" label="Close" onClick={onClose} tip={false} />
        </header>
        <div className="cc-dialog__body">{children}</div>
        {footer && <footer className="cc-dialog__foot">{footer}</footer>}
      </div>
    </div>
  );
}

/** Bottom sheet for phones. Same semantics as Dialog. */
export function Sheet({ title, onClose, children, full, platform = 'ios' }: { title: ReactNode; onClose: () => void; children: ReactNode; full?: boolean; platform?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const hid = useId();
  useEscape(onClose);
  useFocusIn(ref);
  return (
    <div className="cc-scrim cc-scrim--sheet" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} className={cx('cc-sheet', full && 'cc-sheet--full', `cc-sheet--${platform}`)} role="dialog" aria-modal="true" aria-labelledby={hid} onKeyDown={trapTab}>
        <span className="cc-sheet__grab" aria-hidden />
        <header className="cc-sheet__head">
          <h2 id={hid}>{title}</h2>
          <IconButton icon="close" label="Close" onClick={onClose} tip={false} />
        </header>
        <div className="cc-sheet__body">{children}</div>
      </div>
    </div>
  );
}

export interface MenuItem { id: string; label: string; icon?: IconName; danger?: boolean; disabled?: boolean; hint?: string; checked?: boolean }

/** Popover menu with roving focus. Anchored by the caller's positioning class. */
export function Menu({ items, onPick, onClose, label, className }: { items: MenuItem[]; onPick: (id: string) => void; onClose: () => void; label: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [i, setI] = useState(0);
  useEscape(onClose);
  useEffect(() => {
    const el = ref.current;
    el?.querySelectorAll<HTMLElement>('[role^="menuitem"]')[0]?.focus();
    const away = (e: MouseEvent) => { if (el && !el.contains(e.target as Node)) onClose(); };
    const t = setTimeout(() => window.addEventListener('mousedown', away));
    return () => { clearTimeout(t); window.removeEventListener('mousedown', away); };
  }, [onClose]);
  function key(e: RKeyboardEvent) {
    const enabled = items.map((it, n) => (it.disabled ? -1 : n)).filter(n => n >= 0);
    const pos = enabled.indexOf(i);
    let next = i;
    if (e.key === 'ArrowDown') next = enabled[(pos + 1) % enabled.length];
    else if (e.key === 'ArrowUp') next = enabled[(pos - 1 + enabled.length) % enabled.length];
    else if (e.key === 'Home') next = enabled[0];
    else if (e.key === 'End') next = enabled[enabled.length - 1];
    else return;
    e.preventDefault();
    setI(next);
    ref.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]')[next]?.focus();
  }
  return (
    <div ref={ref} className={cx('cc-menu', className)} role="menu" aria-label={label} onKeyDown={key}>
      {items.map((it, n) => (
        <button
          key={it.id}
          type="button"
          role={it.checked === undefined ? 'menuitem' : 'menuitemradio'}
          aria-checked={it.checked}
          tabIndex={n === i ? 0 : -1}
          disabled={it.disabled}
          className={cx('cc-menu__item', it.danger && 'is-danger')}
          onClick={() => { onPick(it.id); onClose(); }}
        >
          {it.icon ? <Icon name={it.icon} size={18} /> : it.checked !== undefined ? <Icon name={it.checked ? 'check' : 'diamond'} size={16} className={it.checked ? '' : 'cc-menu__off'} /> : null}
          <span>{it.label}</span>
          {it.hint && <kbd>{it.hint}</kbd>}
        </button>
      ))}
    </div>
  );
}

/** Small typographic count (no pill): "@3" in the accent. */
export function MentionCount({ n }: { n: number }) {
  if (!n) return null;
  return <span className="cc-count" aria-label={`${n} mention${n === 1 ? '' : 's'}`}>@{n > 99 ? '99+' : n}</span>;
}
