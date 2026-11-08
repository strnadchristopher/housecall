import { useEffect } from 'react';
import type { Action, ScreenProps } from '../../contracts/ui';
import { Icon, type IconName } from '../icons/Icon';
import { ContractForm, Page, find, useEmit } from '../contract';
import { cx } from '../primitives';
import { clockMs, parseSnapshot } from '../parse';
import { setUi } from '../store';

const KINDS: Record<string, { name: string; line: string; icon: IconName }> = {
  plex: { name: 'Watch party', line: 'Pick something from the Plex library. Play, pause and seek stay in step for everyone in the room.', icon: 'film' },
  dj: { name: 'Steve Forever', line: 'A shared queue with a radio DJ between songs. Search, paste a YouTube, SoundCloud or Spotify link, vote to skip.', icon: 'disc' },
  vm: { name: 'Shared VM', line: 'A Debian machine everyone watches. One person drives at a time; ask for the keyboard and it is handed over.', icon: 'vm' },
};

/**
 * App lists every activity's controls on every activity, disabled when they do
 * not apply (Vote to skip on a watch party). Those stay out of the way; any
 * enabled control for another kind still renders at the foot of the page.
 */
const KIND_ACTIONS = ['browse-plex', 'subtitles', 'browse-dj', 'vote_skip', 'request_control'];
function DISABLED_ELSEWHERE(props: ScreenProps) {
  return (props.actions ?? []).filter(a => KIND_ACTIONS.includes(a.id) && a.disabled).map(a => a.id);
}

export function ActivitiesScreen(props: ScreenProps) {
  const emit = useEmit(props);
  useEffect(() => { setUi({ view: 'activities' }); }, []);
  const items = props.items ?? [];
  const launchers = items.filter(i => i.actions?.some(a => a.id === 'start'));
  const snapItem = items.find(i => i.id === 'snapshot');
  const snap = snapItem ? parseSnapshot(snapItem.text) : null;
  const errors = items.filter(i => i.id === 'plex-error' || i.id === 'dj-error');
  const queue = items.filter(i => i !== snapItem && !errors.includes(i) && !launchers.includes(i));
  const a = (id: string) => find(props.actions, id);
  const kind = snap?.kind ?? '';
  const meta = KINDS[kind];
  /** App titles the screen this way when the server syncs state but has no playback provider. */
  const controlOnly = /provider playback unavailable|coming soon/i.test(props.title);

  const btn = (act: Action | undefined, icon: IconName, opts: { text?: string; variant?: string; big?: boolean } = {}) => act && (
    <button type="button" className={cx('cc-btn', `cc-btn--${opts.variant ?? 'raised'}`, opts.big && 'cc-btn--l')} disabled={props.busy || act.disabled}
      aria-label={opts.text && opts.text !== act.label ? act.label : undefined} onClick={() => void emit(act.id)}>
      <Icon name={icon} size={18} /><span>{opts.text ?? act.label}</span>
    </button>
  );
  const seek = (delta: number) => snap && void emit('submit', undefined, { command: 'seek', position_ms: String(Math.max(0, snap.positionMs + delta)), media_id: '', duration_ms: '', title: '', source: '', user_id: '' });

  if (launchers.length) {
    return (
      <Page props={props} icon="disc" title="Together" subtitle="Everyone in this channel sees the same thing at the same moment. Start one; anyone here can join in.">
        <ul className="cc-launch">
          {launchers.map(l => {
            const k = KINDS[l.text] ?? { name: l.text, line: '', icon: 'sparkle' as IconName };
            const start = l.actions!.find(x => x.id === 'start')!;
            return (
              <li key={l.id} data-item-id={l.id} className={`cc-launch__item is-${l.text}`}>
                <Icon name={k.icon} size={30} className="cc-launch__glyph" />
                <h2 className="cc-display">{k.name}</h2>
                <p>{k.line}</p>
                <span className="cc-sr">{l.text}</span>
                <button type="button" className="cc-btn cc-btn--primary" aria-label={start.label} disabled={props.busy || start.disabled} onClick={() => void emit('start', l.id)}>
                  <Icon name="play" size={16} /><span>Start</span>
                </button>
              </li>
            );
          })}
        </ul>
      </Page>
    );
  }

  return (
    <Page props={props} icon={meta?.icon ?? 'disc'} wide title={props.title} className={`cc-act cc-act--${kind}`}
      handled={['play', 'pause', 'stop', ...(kind === 'plex' ? ['browse-plex', 'subtitles'] : []), ...(kind === 'dj' ? ['browse-dj', 'vote_skip'] : []), ...(kind === 'vm' ? ['request_control'] : []), ...(kind ? DISABLED_ELSEWHERE(props) : [])]}>
      {snapItem && (
        <ul className="cc-act__now" aria-label="Shared state">
          <li data-item-id={snapItem.id} className="cc-now">
            <span className="cc-sr">{snapItem.text}</span>
            {snap ? (
              <div className="cc-now__grid" aria-hidden>
                <div className="cc-now__kind"><Icon name={meta?.icon ?? 'sparkle'} size={18} /><span>{meta?.name ?? kind}</span></div>
                <p className="cc-now__time cc-display cc-num">{clockMs(snap.positionMs)}</p>
                <p className={cx('cc-now__state', snap.playing && !controlOnly && 'is-playing')}>
                  <span className="cc-now__bars" aria-hidden><i /><i /><i /></span>
                  {controlOnly
                    ? `Shared controls say ${snap.playing ? 'playing' : 'paused'}. Nothing plays: no provider is configured here.`
                    : snap.playing ? 'Playing for everyone' : 'Paused for everyone'}
                </p>
                <dl className="cc-now__facts">
                  <div><dt>Revision</dt><dd className="cc-num">{snap.revision}</dd></div>
                  <div><dt>{kind === 'vm' ? 'Driving' : 'Control'}</dt><dd>{snap.controller ?? 'nobody'}</dd></div>
                </dl>
              </div>
            ) : <p>{snapItem.text}</p>}
          </li>
        </ul>
      )}

      <div className="cc-transport" role="toolbar" aria-label="Playback">
        {snap && <button type="button" className="cc-ibtn" aria-label="Back 10 seconds" data-tip="Back 10 s" disabled={props.busy} onClick={() => seek(-10000)}><Icon name="rewind" size={18} /></button>}
        {btn(a('play'), 'play', { variant: snap && !snap.playing ? 'primary' : 'raised' })}
        {btn(a('pause'), 'pause', { variant: snap?.playing ? 'primary' : 'raised' })}
        {snap && <button type="button" className="cc-ibtn" aria-label="Forward 10 seconds" data-tip="Forward 10 s" disabled={props.busy} onClick={() => seek(10000)}><Icon name="forward" size={18} /></button>}
        <span className="cc-transport__gap" />
        {kind === 'plex' && btn(a('browse-plex'), 'film')}
        {kind === 'plex' && btn(a('subtitles'), 'subtitles')}
        {kind === 'dj' && btn(a('browse-dj'), 'search')}
        {kind === 'dj' && btn(a('vote_skip'), 'skip')}
        {kind === 'vm' && btn(a('request_control'), 'handoff', { variant: 'primary' })}
      </div>

      {errors.length > 0 && (
        <ul className="cc-act__errors">
          {errors.map(e => <li key={e.id} data-item-id={e.id} className="cc-note cc-note--danger"><Icon name="warn" size={16} /><span>{e.text}</span></li>)}
        </ul>
      )}

      {kind === 'dj' || queue.length ? (
        <section className="cc-queue" aria-labelledby="cc-queue-h">
          <h2 id="cc-queue-h" className="cc-section-title">{kind === 'plex' ? 'Up next' : 'Queue'}</h2>
          {queue.length ? (
            <ol>
              {queue.map((q, i) => (
                <li key={q.id} data-item-id={q.id}>
                  <span className="cc-queue__n cc-num" aria-hidden>{i + 1}</span>
                  <span className="cc-queue__t">{q.text}</span>
                </li>
              ))}
            </ol>
          ) : <p className="cc-muted">Nothing queued. Search for a song or paste a link.</p>}
        </section>
      ) : null}

      {kind === 'vm' && (
        <p className="cc-vm__note"><Icon name="shield" size={16} /> The machine only reaches the internet through the VPN. If the VPN drops, it has no network at all.</p>
      )}

      {props.fields?.length ? (
        <details className="cc-desk" open={typeof matchMedia === 'undefined' || matchMedia('(min-width: 761px)').matches}>
          <summary><Icon name="gear" size={16} /><span>Control desk</span><small>Direct commands, applied for everyone</small></summary>
          <ContractForm props={props} submitVariant="raised"
            hints={{ duration_ms: { inputMode: 'numeric' }, position_ms: { inputMode: 'numeric' }, source: { inputMode: 'url' } }}
            render={(f, submit) => (
              <div className="cc-desk__grid">
                {Object.values(f)}
                <div className="cc-desk__go">{submit}</div>
              </div>
            )} />
        </details>
      ) : null}

      <div className="cc-act__end">
        {a('stop')?.disabled && <p className="cc-muted cc-act__why">Only the person who started it can stop it.</p>}
        {btn(a('stop'), 'close', { variant: 'danger' })}
      </div>
    </Page>
  );
}
