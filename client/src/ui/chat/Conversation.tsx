import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Item, ScreenProps } from '../../contracts/ui';
import { Icon } from '../icons/Icon';
import { Alert, PhaseNote, emitAs, find, useEmit } from '../contract';
import { Dots, cx } from '../primitives';
import { gimmeTone, parseGimme, parseMessage } from '../parse';
import { setUi, useUi } from '../store';
import { MessageRow } from './Message';

const GIMME_ICON = { preview: 'film', ok: 'check', wait: 'diamond', warn: 'warn', fail: 'warn' } as const;

/** The reading column. Items arrive as typing rows, messages, Gimme status rows and playback errors. */
export function ConversationScreen(props: ScreenProps) {
  const emit = useEmit(props);
  const me = useUi(s => s.me);
  useEffect(() => { setUi({ view: 'conversation', channelTitle: props.title }); }, [props.title]);

  const items = props.items ?? [];
  const typing = items.filter(i => i.id.startsWith('typing-'));
  const gimme = items.filter(i => i.id.startsWith('gimme-'));
  const errors = items.filter(i => i.id === 'upload-playback-error');
  const messages = items.filter(i => !typing.includes(i) && !gimme.includes(i) && !errors.includes(i));
  const read = find(props.actions, 'read');
  const closeVideo = find(props.actions, 'close-video');

  const list = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [away, setAway] = useState(false);
  const lastId = messages[messages.length - 1]?.id;
  useLayoutEffect(() => {
    const el = list.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lastId, messages.length, typing.length]);
  useEffect(() => { stick.current = true; setAway(false); }, [props.title]);
  function onScroll() {
    const el = list.current;
    if (!el) return;
    const from = el.scrollHeight - el.scrollTop - el.clientHeight;
    stick.current = from < 80;
    setAway(from > 480);
  }

  return (
    <section data-testid="screen-conversation" aria-busy={props.busy} className="cc-convo" aria-labelledby="cc-convo-title">
      <header className="cc-chead">
        <button type="button" className="cc-ibtn cc-chead__nav" aria-label="Open navigation" onClick={() => setUi({ drawer: true })}>
          <Icon name="queue" size={20} />
        </button>
        <h1 id="cc-convo-title" className="cc-chead__title">
          <Icon name="hash" size={18} className="cc-chead__glyph" />
          <span className="cc-display">{props.title}</span>
        </h1>
        <div className="cc-chead__actions">
          {closeVideo && (
            <button type="button" className="cc-btn cc-btn--quiet" aria-label={closeVideo.label} disabled={props.busy || closeVideo.disabled} onClick={() => void emit('close-video')}>
              <Icon name="close" size={16} /><span>Close video</span>
            </button>
          )}
          <button type="button" className="cc-ibtn" aria-label="Open the call for this channel" data-tip="Call" data-tip-at="bottom" disabled={props.busy} onClick={() => void emitAs(props, 'shell', 'voice')}>
            <Icon name="voice" size={19} />
          </button>
          {read && (
            <button type="button" className="cc-ibtn" aria-label={read.label} data-tip={read.label} data-tip-at="bottom" disabled={props.busy || read.disabled} onClick={() => void emit('read')}>
              <Icon name="check" size={18} />
            </button>
          )}
        </div>
      </header>

      <PhaseNote phase={props.phase} />
      <Alert error={props.error} />

      {gimme.length > 0 && (
        <ul className="cc-requests" aria-label="Gimme requests in this channel">
          {gimme.map(g => {
            const p = parseGimme(g.text);
            const tone = gimmeTone(p.status);
            return (
              <li key={g.id} data-item-id={g.id} className={`cc-request is-${tone}`}>
                <Icon name={GIMME_ICON[tone]} size={15} />
                <strong>{p.title}</strong><span className="cc-sr">: </span>
                <span className="cc-request__status">{p.status}</span>
              </li>
            );
          })}
        </ul>
      )}

      <div className="cc-list" ref={list} onScroll={onScroll}>
        <div className="cc-list__start">
          <p className="cc-display">{props.title}</p>
          <p>{messages.length ? 'The beginning of what this server has kept here.' : 'Nobody has said anything yet. Say something, drop a GIF, or start a call.'}</p>
        </div>
        <ul className="cc-msgs" role="log" aria-label={`Messages in ${props.title}`} aria-live="polite" aria-relevant="additions">
          {messages.map((m, i) => (
            <MessageRow key={m.id} item={m} emit={emit} busy={props.busy} me={me} grouped={sameAuthor(messages[i - 1], m)} />
          ))}
          {errors.map(e => (
            <li key={e.id} data-item-id={e.id} className="cc-msg-error" role="status"><Icon name="warn" size={16} /><span>{e.text}</span></li>
          ))}
          {typing.map(t => (
            <li key={t.id} data-item-id={t.id} className="cc-typing"><Dots /><span>{t.text}</span></li>
          ))}
        </ul>
      </div>
      {away && (
        <button type="button" className="cc-jump" onClick={() => list.current?.scrollTo({ top: list.current.scrollHeight, behavior: 'smooth' })}>
          <Icon name="chevronDown" size={15} /><span>Latest</span>
        </button>
      )}
    </section>
  );
}

function sameAuthor(prev: Item | undefined, m: Item) {
  if (!prev) return false;
  const a = parseMessage(prev.text), b = parseMessage(m.text);
  return !!a.author && a.author === b.author && !b.reply;
}
