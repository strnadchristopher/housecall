import { useCallback, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { Action, Field, Intent, Item, Phase, ScreenProps } from '../contracts/ui';
import { Icon, type IconName } from './icons/Icon';
import { cx } from './primitives';

/**
 * Contract plumbing shared by every designed screen.
 *
 * Invariants that keep App.tsx and the engineering E2E suite working:
 * - every Action renders as a <button> whose accessible name is action.label;
 * - every Field renders as a labelled control named field.name, and submit
 *   emits { action: 'submit', values } read the same way the fixture did;
 * - every Item renders inside an <li data-item-id> whose text content still
 *   contains item.text;
 * - the screen root keeps data-testid="screen-<id>".
 */

export type Values = Record<string, string | boolean>;
export type Emit = (action: string, itemId?: string, values?: Values) => Promise<void>;

export function useEmit(props: Pick<ScreenProps, 'id' | 'onIntent'>): Emit {
  const { id, onIntent } = props;
  return useCallback((action: string, itemId?: string, values: Values = {}) => onIntent({ screen: id, action, itemId, values } as Intent), [id, onIntent]);
}

/** Fire an intent on behalf of another screen (navigation through the shell, for example). */
export function emitAs(props: Pick<ScreenProps, 'onIntent'>, screen: Intent['screen'], action: string, values: Values = {}, itemId?: string) {
  return props.onIntent({ screen, action, itemId, values });
}

/** Set a field's value the way a user would, so App's onInput listeners see it. */
export function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement | null, value: string) {
  if (!el) return;
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

export function readValues(form: HTMLFormElement, fields: Field[] = []): Values {
  const data = new FormData(form);
  const values: Values = {};
  for (const f of fields) values[f.name] = f.type === 'checkbox' ? data.has(f.name) : String(data.get(f.name) ?? '');
  return values;
}

export interface FieldHint {
  multiline?: boolean;
  hideLabel?: boolean;
  placeholder?: string;
  hint?: ReactNode;
  icon?: IconName;
  autoFocus?: boolean;
  autoComplete?: string;
  inputMode?: 'text' | 'numeric' | 'url' | 'search';
  /** Visual size. */
  size?: 'm' | 'l';
  accept?: string;
}

export function FieldControl({ field, busy, hint = {} }: { field: Field; busy?: boolean; hint?: FieldHint }) {
  const id = useId();
  const [fileName, setFileName] = useState('');
  const type = field.type ?? 'text';
  if (type === 'checkbox') {
    return (
      <label className="cc-check" htmlFor={id}>
        <input id={id} name={field.name} type="checkbox" defaultChecked={field.value === 'true'} required={field.required} disabled={busy} />
        <span className="cc-check__box" aria-hidden><Icon name="check" size={14} /></span>
        <span className="cc-check__text">
          <span>{field.label}</span>
          {hint.hint && <small>{hint.hint}</small>}
        </span>
      </label>
    );
  }
  if (type === 'file') {
    return (
      <div className={cx('cc-drop', fileName && 'has-file')}>
        <input id={id} name={field.name} type="file" required={field.required} disabled={busy} accept={hint.accept}
          onChange={e => setFileName(e.currentTarget.files?.[0]?.name ?? '')} />
        <label htmlFor={id}>
          <Icon name="upload" size={20} />
          <span className="cc-drop__label">{field.label}</span>
          <span className="cc-drop__name">{fileName || (hint.placeholder ?? 'Choose or drop a file. No size limit.')}</span>
        </label>
      </div>
    );
  }
  const common = {
    id, name: field.name, defaultValue: field.value, required: field.required, disabled: busy,
    placeholder: hint.placeholder, autoFocus: hint.autoFocus, autoComplete: hint.autoComplete,
  };
  return (
    <div className={cx('cc-field', hint.size === 'l' && 'cc-field--l')}>
      <label htmlFor={id} className={hint.hideLabel ? 'cc-sr' : undefined}>{field.label}</label>
      <div className="cc-field__box">
        {hint.icon && <Icon name={hint.icon} size={18} className="cc-field__icon" />}
        {hint.multiline
          ? <textarea {...common} rows={4} aria-describedby={hint.hint ? `${id}-hint` : undefined} />
          : <input {...common} type={type} inputMode={hint.inputMode} spellCheck={type === 'text' ? undefined : false} aria-describedby={hint.hint ? `${id}-hint` : undefined} />}
      </div>
      {hint.hint && <p className="cc-field__hint" id={`${id}-hint`}>{hint.hint}</p>}
    </div>
  );
}

/**
 * The working form. `render` lets a screen arrange the controls; by default
 * they stack. The submit button keeps submitLabel as its accessible name.
 */
export function ContractForm({ props, hints = {}, render, submitIcon, submitVariant = 'primary', submitText, className, formRef }: {
  props: ScreenProps;
  hints?: Record<string, FieldHint>;
  render?: (f: Record<string, ReactNode>, submit: ReactNode) => ReactNode;
  submitIcon?: IconName;
  submitVariant?: 'primary' | 'raised' | 'quiet';
  /** Visible text when it differs from submitLabel (the label stays the accessible name). */
  submitText?: ReactNode;
  className?: string;
  formRef?: React.Ref<HTMLFormElement>;
}) {
  const emit = useEmit(props);
  const fields = props.fields ?? [];
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    void emit('submit', undefined, readValues(e.currentTarget, fields));
  }
  const controls: Record<string, ReactNode> = {};
  for (const f of fields) controls[f.name] = <FieldControl key={f.name} field={f} busy={props.busy} hint={hints[f.name]} />;
  const label = props.submitLabel ?? 'Submit';
  const button = (
    <button type="submit" className={cx('cc-btn', `cc-btn--${submitVariant}`)} disabled={props.busy} aria-label={submitText ? label : undefined} aria-busy={props.busy || undefined}>
      {submitIcon && <Icon name={submitIcon} size={18} />}
      <span>{submitText ?? label}</span>
    </button>
  );
  return (
    <form ref={formRef} className={cx('cc-form', className)} onSubmit={submit} noValidate={false}>
      {render ? render(controls, button) : <>{fields.map(f => controls[f.name])}<div className="cc-form__go">{button}</div></>}
    </form>
  );
}

export function ActionButton({ action, emit, busy, itemId, icon, variant = 'raised', text, className, iconOnly, tip, values }: {
  action: Action; emit: Emit; busy?: boolean; itemId?: string; icon?: IconName;
  variant?: 'primary' | 'raised' | 'quiet' | 'danger' | 'ghost'; text?: ReactNode; className?: string; iconOnly?: boolean; tip?: 'top' | 'bottom' | 'left' | 'right';
  values?: Values;
}) {
  const disabled = busy || action.disabled;
  if (iconOnly && icon) {
    return (
      <button type="button" className={cx('cc-ibtn', variant === 'danger' && 'cc-ibtn--danger', className)} aria-label={action.label} data-tip={action.label} data-tip-at={tip ?? 'top'}
        disabled={disabled} onClick={() => void emit(action.id, itemId, values)}>
        <Icon name={icon} size={18} />
      </button>
    );
  }
  const visible = text ?? action.label;
  return (
    <button type="button" className={cx('cc-btn', `cc-btn--${variant}`, className)} disabled={disabled}
      aria-label={typeof visible === 'string' && visible === action.label ? undefined : action.label}
      onClick={() => void emit(action.id, itemId, values)}>
      {icon && <Icon name={icon} size={18} />}
      <span>{visible}</span>
    </button>
  );
}

export function find(actions: Action[] | undefined, id: string) { return actions?.find(a => a.id === id); }
export function without(actions: Action[] | undefined, ...ids: string[]) { return (actions ?? []).filter(a => !ids.includes(a.id)); }

/** Actions for which we draw a specific glyph. Unknown ids get none. */
export const ACTION_ICON: Record<string, IconName> = {
  reply: 'reply', react: 'smile', pin: 'pin', edit: 'edit', unsend: 'unsend', 'preview-link': 'link',
  revoke: 'close', resolve: 'check', screenshot: 'download', delete: 'trash', select: 'arrowUpRight',
  library: 'film2', choose: 'plus', start: 'play', play: 'play', pause: 'pause', vote_skip: 'skip',
  request_control: 'handoff', stop: 'close', 'browse-plex': 'film', 'browse-dj': 'disc', subtitles: 'subtitles',
  join: 'voice', leave: 'hangup', share: 'screen', mute: 'micOff', passkey: 'fingerprint', enable: 'bell',
  pause_upload: 'pause', derive: 'film', attach: 'link', read: 'check', 'close-video': 'close', mention: 'at', 'mention-role': 'at',
};

export function Alert({ error }: { error?: string }) {
  if (!error) return null;
  return (
    <div className="cc-alert" role="alert">
      <Icon name="warn" size={17} />
      <span>{error}</span>
    </div>
  );
}

const PHASE_NOTE: Partial<Record<Phase, { icon: IconName; text: string; tone: string }>> = {
  offline: { icon: 'offline', text: 'Offline. Showing what was loaded; changes send when the connection is back.', tone: 'warn' },
  loading: { icon: 'diamond', text: 'Loading', tone: 'info' },
  forbidden: { icon: 'lock', text: 'You do not have access to this.', tone: 'danger' },
  unavailable: { icon: 'diamond', text: 'Not available on this server yet.', tone: 'info' },
  empty: { icon: 'diamond', text: 'Nothing here yet.', tone: 'info' },
  error: { icon: 'warn', text: 'Something went wrong.', tone: 'danger' },
};

/** Phase other than ready, as a quiet status line (never role=alert: errors own that). */
export function PhaseNote({ phase, children }: { phase: Phase; children?: ReactNode }) {
  if (phase === 'ready') return null;
  const n = PHASE_NOTE[phase]!;
  return (
    <div className={cx('cc-note', `cc-note--${n.tone}`)} role="status">
      {phase === 'loading' ? <span className="cc-dots" aria-hidden><i /><i /><i /></span> : <Icon name={n.icon} size={16} />}
      <span>{children ?? n.text}</span>
      <span className="cc-sr">{phase}</span>
    </div>
  );
}

/** Standard page for everything that is not the chat column. */
export function Page({ props, children, icon, title, subtitle, wide, tools, className, handled = [] }: {
  props: ScreenProps; children: ReactNode; icon?: IconName; title?: ReactNode; subtitle?: ReactNode; wide?: boolean; tools?: ReactNode; className?: string;
  /** Action ids the screen draws itself. Every other action still renders, at the foot of the page. */
  handled?: string[];
}) {
  const emit = useEmit(props);
  const back = find(props.actions, 'back');
  const leftover = without(props.actions, 'back', ...handled);
  return (
    <section data-testid={`screen-${props.id}`} aria-busy={props.busy} className={cx('cc-page', wide && 'cc-page--wide', className)} aria-labelledby={`h-${props.id}`}>
      <header className="cc-page__head">
        {back && (
          <button type="button" className="cc-back" aria-label={back.label} disabled={props.busy || back.disabled} onClick={() => void emit('back')}>
            <Icon name="chevronLeft" size={18} /><span>Chat</span>
          </button>
        )}
        <div className="cc-page__title">
          {icon && <Icon name={icon} size={22} className="cc-page__glyph" />}
          <h1 id={`h-${props.id}`} className="cc-display">{title ?? props.title}</h1>
        </div>
        {tools && <div className="cc-page__tools">{tools}</div>}
      </header>
      {subtitle && <p className="cc-page__sub">{subtitle}</p>}
      <div className="cc-page__body">
        <PhaseNote phase={props.phase} />
        <Alert error={props.error} />
        {children}
        {leftover.length > 0 && (
          <div className="cc-page__actions">
            {leftover.map(a => <ActionButton key={a.id} action={a} emit={emit} busy={props.busy} icon={ACTION_ICON[a.id]} />)}
          </div>
        )}
      </div>
    </section>
  );
}

/** Generic list rendering, used when a screen has no bespoke treatment for its items. */
export function ItemList({ props, items, render, className, label, empty }: {
  props: ScreenProps; items?: Item[]; render?: (item: Item) => ReactNode; className?: string; label?: string; empty?: ReactNode;
}) {
  const emit = useEmit(props);
  const list = items ?? props.items ?? [];
  if (!list.length) return <>{empty ?? null}</>;
  return (
    <ul className={cx('cc-items', className)} aria-label={label}>
      {list.map(item => (
        <li key={item.id} data-item-id={item.id} className="cc-item">
          {render ? render(item) : (
            <>
              <span className="cc-item__text">{item.text}</span>
              {item.actions?.length ? (
                <span className="cc-item__actions">
                  {item.actions.map(a => <ActionButton key={a.id} action={a} emit={emit} busy={props.busy} itemId={item.id} icon={ACTION_ICON[a.id]} variant="quiet" />)}
                </span>
              ) : null}
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Remember a ref to the closest form so helpers can fill fields like a user. */
export function useFormRef() { return useRef<HTMLFormElement>(null); }
export function fieldIn(form: HTMLFormElement | null, name: string) {
  return form?.elements.namedItem(name) as HTMLInputElement | HTMLTextAreaElement | null;
}
