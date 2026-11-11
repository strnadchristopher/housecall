import { useEffect, useState, type ReactNode } from 'react';
import type { Action, ScreenProps } from '../contracts/ui';
import { Icon, ObeliskMark, type IconName } from './icons/Icon';
import { emitAs, find, useEmit } from './contract';
import { Avatar, cx } from './primitives';
import { setUi, useUi } from './store';

const NAV: Record<string, { icon: IconName; short?: string; group: 'ctx' | 'together' | 'owner' | 'you' | 'head' | 'dm' }> = {
  search: { icon: 'search', group: 'ctx' },
  pins: { icon: 'pin', group: 'ctx' },
  members: { icon: 'members', group: 'ctx' },
  voice: { icon: 'voice', group: 'together' },
  activities: { icon: 'disc', group: 'together' },
  gimme: { icon: 'film', short: 'Gimme request', group: 'together' },
  uploads: { icon: 'upload', group: 'together' },
  gifs: { icon: 'sparkle', group: 'together' },
  'invites-admin': { icon: 'key', group: 'owner' },
  'reports-admin': { icon: 'inbox', group: 'owner' },
  'channels-admin': { icon: 'hash', group: 'owner' },
  'roles-admin': { icon: 'at', group: 'owner' },
  notifications: { icon: 'bell', group: 'you' },
  devices: { icon: 'fingerprint', group: 'you' },
  settings: { icon: 'gear', group: 'you' },
  report: { icon: 'flag', group: 'you' },
  logout: { icon: 'logout', group: 'you' },
  'servers-admin': { icon: 'chevronDown', group: 'head' },
  'direct-messages': { icon: 'plus', short: 'New', group: 'dm' },
};

/**
 * The shell: sidebar navigation, the conversation context tools, the phone
 * tab bar and the call dock. Its root is display: contents so each piece
 * takes its own cell in App's layout grid (see styles/app.css).
 */
export function ShellScreen(props: ScreenProps) {
  const emit = useEmit(props);
  const view = useUi(s => s.view);
  const current = useUi(s => s.channelTitle);
  const drawer = useUi(s => s.drawer);
  const streams = useUi(s => s.streams);
  const phone = usePhone();
  const me = props.title.split(' — ').slice(1).join(' — ') || undefined;
  useEffect(() => { setUi({ me }); }, [me]);
  useEffect(() => {
    if (!drawer) return;
    const close = (e: KeyboardEvent) => { if (e.key === 'Escape') setUi({ drawer: false }); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [drawer]);

  const actions = props.actions ?? [];
  const group = (g: string) => actions.filter(a => NAV[a.id]?.group === g);
  const unknown = actions.filter(a => !NAV[a.id]);
  const go = (a: Action) => { setUi({ drawer: false }); void emit(a.id); };

  const navButton = (a: Action, extra?: ReactNode) => {
    const n = NAV[a.id];
    const visible = n?.short ?? a.label;
    return (
      <button key={a.id} type="button" className={cx('cc-nav', view === a.id && 'is-current')} aria-current={view === a.id ? 'page' : undefined}
        aria-label={visible === a.label ? undefined : a.label} disabled={props.busy || a.disabled} onClick={() => go(a)}>
        {n && <Icon name={n.icon} size={18} />}
        <span className="cc-nav__label">{visible}</span>
        {a.id === 'gimme' && /dry run/.test(a.label) && <small className="cc-nav__note">dry run</small>}
        {extra}
      </button>
    );
  };

  const servers = find(actions, 'servers-admin');
  const newDm = find(actions, 'direct-messages');
  const owner = group('owner');

  return (
    <nav data-testid="screen-shell" aria-busy={props.busy} className="cc-shell" aria-label="Housecall">
      <div className={cx('cc-side cc-grain', drawer && 'is-open')} id="cc-side">
        <header className="cc-side__head">
          <ObeliskMark size={26} />
          <div className="cc-side__brand">
            <span className="cc-display">Housecall</span>
            <span className="cc-side__phase" role="status">{props.phase === 'offline' ? 'Reconnecting' : props.phase === 'ready' ? 'Connected' : props.phase}</span>
          </div>
          {servers && (
            <button type="button" className={cx('cc-ibtn', view === 'servers-admin' && 'is-active')} aria-label={servers.label} data-tip={servers.label} data-tip-at="bottom" disabled={props.busy || servers.disabled} onClick={() => go(servers)}>
              <Icon name="globe" size={18} />
            </button>
          )}
          <button type="button" className="cc-ibtn cc-side__close" aria-label="Close navigation" onClick={() => setUi({ drawer: false })}><Icon name="close" size={18} /></button>
        </header>

        <div className="cc-side__scroll">
          <section className="cc-side__sec" aria-labelledby="cc-sec-convos">
            <div className="cc-side__label">
              <h2 id="cc-sec-convos">Conversations</h2>
              {newDm && (
                <button type="button" className="cc-side__new" aria-label={newDm.label} disabled={props.busy || newDm.disabled} onClick={() => go(newDm)}>
                  <Icon name="plus" size={14} /><span>New DM</span>
                </button>
              )}
            </div>
            {(props.items ?? []).length === 0
              ? <p className="cc-side__empty">No conversations yet. Christopher adds you to channels, or start a DM.</p>
              : (
                <ul className="cc-channels">
                  {(props.items ?? []).map(ch => {
                    const open = ch.actions?.find(a => a.id === 'select');
                    const here = view === 'conversation' && ch.text === current;
                    return (
                      <li key={ch.id} data-item-id={ch.id}>
                        {open ? (
                          <button type="button" className={cx('cc-channel', here && 'is-current')} aria-current={here ? 'page' : undefined} aria-label={open.label}
                            disabled={props.busy || open.disabled} onClick={() => { setUi({ drawer: false }); void emit('select', ch.id); }}>
                            <Icon name="hash" size={16} />
                            <span>{ch.text}</span>
                          </button>
                        ) : <span className="cc-channel">{ch.text}</span>}
                      </li>
                    );
                  })}
                </ul>
              )}
          </section>

          {(view !== 'conversation' || phone) && group('ctx').length > 0 && (
            <section className="cc-side__sec" aria-labelledby="cc-sec-ctx">
              <div className="cc-side__label"><h2 id="cc-sec-ctx">In this conversation</h2></div>
              {group('ctx').map(a => navButton(a))}
            </section>
          )}

          {group('together').length > 0 && (
            <section className="cc-side__sec" aria-labelledby="cc-sec-together">
              <div className="cc-side__label"><h2 id="cc-sec-together">Together</h2></div>
              {group('together').map(a => navButton(a))}
            </section>
          )}

          {owner.length > 0 && (
            <section className="cc-side__sec" aria-labelledby="cc-sec-owner">
              <div className="cc-side__label"><h2 id="cc-sec-owner">Run the place</h2></div>
              {owner.map(a => navButton(a))}
            </section>
          )}

          {unknown.length > 0 && (
            <section className="cc-side__sec" aria-label="More">
              {unknown.map(a => navButton(a))}
            </section>
          )}
        </div>

        <footer className="cc-plate">
          <div className="cc-plate__me">
            <Avatar name={me ?? '?'} size={34} presence={false} />
            <div className="cc-plate__who">
              <strong>{me ?? 'Signed in'}</strong>
              <span className={props.phase === 'offline' ? 'is-off' : 'is-on'}>{props.phase === 'offline' ? 'Offline, retrying' : 'Online'}</span>
            </div>
          </div>
          <div className="cc-plate__tools">
            {group('you').map(a => (
              <button key={a.id} type="button" className={cx('cc-ibtn', view === a.id && 'is-active', a.id === 'logout' && 'cc-plate__out')} aria-label={a.label} data-tip={a.label}
                disabled={props.busy || a.disabled} onClick={() => go(a)}>
                <Icon name={NAV[a.id].icon} size={18} />
              </button>
            ))}
          </div>
        </footer>
      </div>
      {drawer && <div className="cc-side__scrim" onClick={() => setUi({ drawer: false })} aria-hidden />}

      {view === 'conversation' && !phone && group('ctx').length > 0 && (
        <div className="cc-ctx" role="toolbar" aria-label="Conversation tools">
          {group('ctx').map(a => (
            <button key={a.id} type="button" className="cc-ibtn" aria-label={a.label} data-tip={a.label} data-tip-at="bottom" disabled={props.busy || a.disabled} onClick={() => go(a)}>
              <Icon name={NAV[a.id].icon} size={18} />
            </button>
          ))}
        </div>
      )}

      {streams > 0 && view !== 'voice' && (
        <div className="cc-calldock" role="status">
          <Icon name="voice" size={16} />
          <span><strong>In a call</strong> {streams} live {streams === 1 ? 'stream' : 'streams'}</span>
          <button type="button" className="cc-btn cc-btn--quiet" onClick={() => void emit('voice')}>Return to call</button>
        </div>
      )}

      <div className="cc-tabs" role="toolbar" aria-label="Sections">
        <MobileTab icon="chat" text="Chats" current={view === 'conversation'} onClick={() => {
          if (view === 'conversation') setUi({ drawer: true });
          else if (view) void emitAs(props, view, 'back');
        }} />
        <MobileTab icon="voice" text="Call" current={view === 'voice'} onClick={() => void emit('voice')} />
        <MobileTab icon="disc" text="Together" current={view === 'activities' || view === 'plex' || view === 'dj'} onClick={() => void emit('activities')} />
        <MobileTab icon="queue" text="More" current={drawer} onClick={() => setUi({ drawer: !drawer })} />
      </div>
    </nav>
  );
}

/** Phone layout breakpoint, kept in sync with the 760px media queries in styles/. */
function usePhone() {
  const query = '(max-width: 760px)';
  const [phone, setPhone] = useState(() => typeof matchMedia !== 'undefined' && matchMedia(query).matches);
  useEffect(() => {
    const mq = matchMedia(query);
    const on = () => setPhone(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return phone;
}

function MobileTab({ icon, text, current, onClick }: { icon: IconName; text: string; current?: boolean; onClick: () => void }) {
  return (
    <button type="button" className={cx('cc-tab', current && 'is-current')} aria-current={current ? 'page' : undefined} onClick={onClick}>
      <Icon name={icon} size={20} />
      <span>{text}</span>
    </button>
  );
}
