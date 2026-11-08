import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { ScreenProps } from '../../contracts/ui';
import { Icon } from '../icons/Icon';
import { Alert, emitAs, find, readValues, setNativeValue, useEmit } from '../contract';
import { Avatar, Menu, cx } from '../primitives';
import { useUi } from '../store';

const EMOJI = ['👍', '😂', '❤️', '🔥', '👀', '🎉', '😭', '🫡', '🙏', '💀', '🤝', '🍿', '🎬', '🎶', '🕹️', '💯', '😎', '🤔', '🫠', '☕'];

/**
 * The composer. App.tsx owns the draft (it listens to input events on the
 * `body` input), mention candidates arrive as items, and the form submits
 * the body. Picking a candidate emits its own action; App rewrites the draft
 * and remounts the composer with the completed text.
 *
 * `/gimme movie|show <title>` is routed to the Gimme screen's submit intent
 * instead of being posted as text.
 */
export function ComposerScreen(props: ScreenProps) {
  const emit = useEmit(props);
  const channel = useUi(s => s.channelTitle);
  const form = useRef<HTMLFormElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const [sel, setSel] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [menu, setMenu] = useState<'add' | 'emoji' | null>(null);
  const [hint, setHint] = useState('');
  const field = props.fields?.find(f => f.name === 'body');
  const cancel = find(props.actions, 'cancel');
  const candidates = props.items ?? [];
  const showList = candidates.length > 0 && !dismissed;
  const mode = props.title === 'Edit message' ? 'edit' : props.title === 'Reply to message' ? 'reply' : 'new';
  const [empty, setEmpty] = useState(!field?.value);

  useEffect(() => {
    // App remounts the composer after send, edit or a picked mention; keep focus in the box.
    const el = input.current;
    if (!el || matchMedia('(hover: none)').matches) return;
    const active = document.activeElement;
    if (!active || active === document.body || mode !== 'new' || field?.value) {
      el.focus({ preventScroll: true });
      const end = el.value.length;
      el.setSelectionRange(end, end);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function pick(i: number) {
    const item = candidates[i];
    const action = item?.actions?.[0];
    if (item && action && !action.disabled) void emit(action.id, item.id);
  }

  function key(e: KeyboardEvent<HTMLInputElement>) {
    if (showList) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => (s + 1) % candidates.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => (s - 1 + candidates.length) % candidates.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(Math.min(sel, candidates.length - 1)); return; }
      if (e.key === 'Escape') { e.preventDefault(); setDismissed(true); return; }
    }
    if (e.key === 'Escape' && cancel) { e.preventDefault(); void emit('cancel'); }
  }

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const values = readValues(e.currentTarget, props.fields);
    const body = String(values.body ?? '').trim();
    if (!body) return;
    const cmd = /^\/gimme(?:\s+(movie|show|tv))?\s+(.+)$/i.exec(body);
    if (cmd) {
      const tv = !!cmd[1] && cmd[1].toLowerCase() !== 'movie';
      void emitAs(props, 'gimme', 'submit', { query: cmd[2].trim(), tv });
      setNativeValue(input.current, '');
      setEmpty(true);
      setHint(`Asked Gimme for ${cmd[2].trim()}. Its status shows at the top of this channel.`);
      return;
    }
    if (/^\/gimme\s*$/i.test(body)) { setHint('Try /gimme movie Arrival, or /gimme show Severance.'); return; }
    setHint('');
    void emit('submit', undefined, values);
  }

  function insert(text: string) {
    const el = input.current;
    if (!el) return;
    const at = el.selectionStart ?? el.value.length;
    setNativeValue(el, el.value.slice(0, at) + text + el.value.slice(el.selectionEnd ?? at));
    setEmpty(false);
    el.focus();
    el.setSelectionRange(at + text.length, at + text.length);
  }

  const where = channel ? `#${channel}` : 'this conversation';
  return (
    <section data-testid="screen-composer" aria-busy={props.busy} className={cx('cc-composer', `is-${mode}`)}>
      <Alert error={props.error} />
      {mode !== 'new' && (
        <div className="cc-replybar">
          <Icon name={mode === 'edit' ? 'edit' : 'reply'} size={15} />
          <span>{mode === 'edit' ? 'Editing your message' : 'Replying to a message'}</span>
          {cancel && (
            <button type="button" className="cc-btn cc-btn--quiet" disabled={props.busy || cancel.disabled} onClick={() => void emit('cancel')}>
              <span>{cancel.label}</span>
            </button>
          )}
        </div>
      )}
      {showList && (
        <div className="cc-ac" role="listbox" id={listId} aria-label="Mention someone">
          <p className="cc-ac__head" aria-hidden>Mention</p>
          <ul>
            {candidates.map((c, i) => {
              const a = c.actions?.[0];
              const role = c.id.startsWith('role-');
              const label = c.text.replace(/ \(role\)$/, '');
              return (
                <li key={c.id} data-item-id={c.id} role="presentation">
                  <button type="button" role="option" id={`${listId}-${i}`} aria-selected={i === sel} aria-label={a?.label ?? c.text}
                    className={cx('cc-ac__item', i === sel && 'is-sel')} disabled={props.busy || a?.disabled}
                    onMouseDown={e => e.preventDefault()} onMouseEnter={() => setSel(i)} onClick={() => pick(i)}>
                    {role ? <Icon name="at" size={18} className="cc-ac__glyph" /> : <Avatar name={label.slice(1)} size={24} presence={false} />}
                    <span className="cc-ac__label">{label}</span>
                    <span className="cc-ac__detail">{role ? 'role' : ''}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="cc-ac__foot" aria-hidden><kbd>↑</kbd><kbd>↓</kbd> choose <kbd>Enter</kbd> insert <kbd>Esc</kbd> close</p>
        </div>
      )}
      <form ref={form} className="cc-composer__box" onSubmit={submit}>
        <div className="cc-composer__add">
          <button type="button" className={cx('cc-ibtn', menu === 'add' && 'is-active')} aria-label="Add to message" aria-haspopup="menu" aria-expanded={menu === 'add'} onClick={() => setMenu(m => (m === 'add' ? null : 'add'))}>
            <Icon name="plus" size={20} />
          </button>
          {menu === 'add' && (
            <Menu label="Add to message" className="cc-composer__menu" onClose={() => setMenu(null)}
              items={[
                { id: 'uploads', label: 'Attach a file', icon: 'upload', hint: 'any size' },
                { id: 'gifs', label: 'Find a GIF', icon: 'sparkle' },
                { id: 'gimme', label: 'Ask Gimme for a movie or show', icon: 'film' },
                { id: 'activities', label: 'Start an activity', icon: 'disc' },
              ]}
              onPick={id => void emitAs(props, 'shell', id)} />
          )}
        </div>
        <label htmlFor={`${listId}-in`} className="cc-sr">{field?.label ?? 'Message'}</label>
        <input
          ref={input}
          id={`${listId}-in`}
          name="body"
          type="text"
          autoComplete="off"
          defaultValue={field?.value}
          required={field?.required}
          disabled={props.busy}
          placeholder={mode === 'edit' ? 'Edit message' : `Message ${where}`}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={showList}
          aria-controls={showList ? listId : undefined}
          aria-activedescendant={showList ? `${listId}-${sel}` : undefined}
          onKeyDown={key}
          onInput={e => { setDismissed(false); setSel(0); setEmpty(!e.currentTarget.value.trim()); }}
        />
        <div className="cc-composer__tools">
          <button type="button" className={cx('cc-ibtn', menu === 'emoji' && 'is-active')} aria-label="Insert emoji" data-tip="Emoji" aria-expanded={menu === 'emoji'} onClick={() => setMenu(m => (m === 'emoji' ? null : 'emoji'))}>
            <Icon name="smile" size={19} />
          </button>
          <button type="button" className="cc-gifbtn" aria-label="Add a GIF" data-tip="GIFs" onClick={() => void emitAs(props, 'shell', 'gifs')}>GIF</button>
          <button type="submit" className={cx('cc-send', !empty && 'is-ready')} aria-label={props.submitLabel ?? 'Send'} data-tip={props.submitLabel ?? 'Send'} disabled={props.busy}>
            <Icon name={mode === 'edit' ? 'check' : 'send'} size={18} />
          </button>
        </div>
        {menu === 'emoji' && (
          <>
            <div className="cc-away" onMouseDown={() => setMenu(null)} aria-hidden />
            <div className="cc-emoji-pop" role="dialog" aria-label="Insert emoji" onKeyDown={e => e.key === 'Escape' && setMenu(null)}>
              {EMOJI.map((e, i) => <button key={e} type="button" aria-label={`Insert ${e}`} autoFocus={i === 0} onClick={() => { insert(e); setMenu(null); }}>{e}</button>)}
            </div>
          </>
        )}
      </form>
      <p className="cc-composer__hint" aria-live="polite">{hint}</p>
    </section>
  );
}
