import { memo, useRef, useState } from 'react';
import type { Item } from '../../contracts/ui';
import { Icon, ObeliskMark } from '../icons/Icon';
import { Avatar, Sheet, cx } from '../primitives';
import { ACTION_ICON, type Emit } from '../contract';
import { parseMessage } from '../parse';
import { MessageBody, excerpt, plainText } from './Markdown';

/**
 * One message, rendered from a contract Item. The text content of the row is
 * kept equal to item.text (author, ": ", body, flags, reactions) so search,
 * screen readers and the E2E suite read the same sentence; the visible
 * treatment is layered on with aria-hidden decoration.
 */
export const MessageRow = memo(function MessageRow({ item, emit, busy, grouped, me, owner }: {
  item: Item; emit: Emit; busy?: boolean; grouped: boolean; me?: string; owner?: boolean;
}) {
  const [sheet, setSheetState] = useState<false | 'actions' | 'confirm'>(false);
  const closedAt = useRef(0);
  const setSheet = (s: false | 'actions' | 'confirm') => { if (!s) closedAt.current = Date.now(); setSheetState(s); };
  const p = parseMessage(item.text, item.richText ? plainText(item.richText) : undefined);
  const actions = item.actions ?? [];
  const plays = actions.filter(a => a.id.startsWith('play-attachment:'));
  const tools = actions.filter(a => !a.id.startsWith('play-attachment:') && a.id !== 'unsend');
  const unsend = actions.find(a => a.id === 'unsend');
  const mine = !!me && p.author === me;
  const mentionsMe = !mine && !!me && new RegExp(`(^|[^\\w@])@(${escapeRe(me)}|everyone|here)(?![\\w-])`, 'i').test(p.body);

  return (
    <li data-item-id={item.id}
      className={cx('cc-msg', grouped && 'is-grouped', mentionsMe && 'is-mention', mine && 'is-mine', sheet && 'is-open', p.pinned && 'is-pinned')}
      onClick={e => {
        // Touch: tapping a message opens its actions as a bottom sheet (no hover toolbar on phones).
        if ((e.target as HTMLElement).closest('button, a, .cc-scrim') || Date.now() - closedAt.current < 450) return;
        if (matchMedia('(hover: none)').matches && (tools.length || unsend)) setSheet('actions');
      }}>
      {mentionsMe && <span className="cc-msg__shard" aria-hidden />}
      <div className="cc-msg__gutter" aria-hidden>
        {!grouped && <Avatar name={p.author || '?'} size={36} presence={false} />}
      </div>
      <div className="cc-msg__main">
        {p.reply && <span className="cc-msg__replymark" aria-hidden><Icon name="reply" size={13} /> reply</span>}
        <div className={cx('cc-msg__head', grouped && 'cc-sr')}>
          <span className="cc-msg__name">{p.author}</span>
          <span className="cc-sr">: </span>
          {owner && <span className="cc-msg__owner" aria-hidden><ObeliskMark size={12} /></span>}
          {p.pinned && <Icon name="pin" size={12} className="cc-msg__pinmark" />}
        </div>
        <MessageBody nodes={item.richText} text={p.body} me={me} />
        <span className="cc-sr">{p.suffix}</span>
        {p.reactions.length > 0 && (
          <div className="cc-reacts" aria-hidden>
            {p.reactions.map(r => <span key={r.emoji} className="cc-react"><span className="cc-react__e">{r.emoji}</span><span className="cc-num">{r.count}</span></span>)}
          </div>
        )}
        {plays.map(a => {
          const name = a.label.replace(/^Play /, '');
          return (
            <div key={a.id} className="cc-file cc-file--video">
              <Icon name="film" size={20} />
              <div><strong>{name}</strong><span>Video, streamed from this server</span></div>
              <button type="button" className="cc-file__play" aria-label={a.label} disabled={busy || a.disabled} onClick={() => void emit(a.id, item.id)}>
                <Icon name="play" size={16} /><span aria-hidden>Play</span>
              </button>
            </div>
          );
        })}
      </div>
      {(tools.length > 0 || unsend) && (
        <div className="cc-msg__bar" role="toolbar" aria-label="Message actions">
          {tools.map(a => (
            <button key={a.id} type="button" className="cc-ibtn" aria-label={a.label} data-tip={a.label} disabled={busy || a.disabled} onClick={() => void emit(a.id, item.id)}>
              <Icon name={ACTION_ICON[a.id] ?? 'diamond'} size={17} />
            </button>
          ))}
          {unsend && (
            <button type="button" className="cc-ibtn cc-ibtn--danger cc-msg__unsend" aria-label={unsend.label} data-tip="Unsend for everyone" disabled={busy || unsend.disabled} onClick={() => void emit(unsend.id, item.id)}>
              <Icon name="unsend" size={17} />
            </button>
          )}
        </div>
      )}
      {sheet && (
        <Sheet title={sheet === 'confirm' ? 'Unsend for everyone?' : `${p.author || 'Message'}`} onClose={() => setSheet(false)}>
          {sheet === 'actions' ? (
            <div className="cc-actsheet">
              <p className="cc-actsheet__quote">{excerpt(p.body, 120)}</p>
              {tools.map(a => (
                <button key={a.id} type="button" className="cc-actsheet__btn" disabled={busy || a.disabled} onClick={() => { setSheet(false); void emit(a.id, item.id); }}>
                  <Icon name={ACTION_ICON[a.id] ?? 'diamond'} size={20} /><span>{a.label}</span>
                </button>
              ))}
              {unsend && (
                <button type="button" className="cc-actsheet__btn is-danger" disabled={busy || unsend.disabled} onClick={() => setSheet('confirm')}>
                  <Icon name="unsend" size={20} /><span>{unsend.label}</span>
                </button>
              )}
            </div>
          ) : (
            <div className="cc-actsheet">
              <p className="cc-actsheet__note">It disappears from every device, and its notifications are pulled back where the device allows.</p>
              <button type="button" className="cc-actsheet__btn is-danger is-solid" disabled={busy} onClick={() => { setSheet(false); void emit(unsend!.id, item.id); }}>
                <Icon name="unsend" size={20} /><span>Unsend for everyone</span>
              </button>
              <button type="button" className="cc-actsheet__btn" onClick={() => setSheet('actions')}>
                <Icon name="chevronLeft" size={20} /><span>Keep it</span>
              </button>
            </div>
          )}
        </Sheet>
      )}
    </li>
  );
});

function escapeRe(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
