import { useRef, useState } from 'react';
import type { ScreenProps } from '../../contracts/ui';
import { Icon } from '../icons/Icon';
import { ActionButton, ContractForm, Page, fieldIn, find, setNativeValue, useEmit } from '../contract';
import { bytes, fraction } from '../format';
import { Progress, cx } from '../primitives';
import { clockMs, gimmeTone, hashOf, parseDuration, parseGimme, parseKind, parseReport, parseUpload } from '../parse';
import { useView } from './People';

/* ── Plex library ────────────────────────────────────────────── */

export function PlexScreen(props: ScreenProps) {
  useView(props.id);
  const emit = useEmit(props);
  const items = props.items ?? [];
  const libraries = items.filter(i => i.actions?.some(a => a.id === 'library'));
  const titles = items.filter(i => i.actions?.some(a => a.id === 'choose'));
  return (
    <Page props={props} icon="film" wide subtitle="Picking a title starts it for everyone in the watch party. Only the host can pick.">
      {libraries.length > 0 && (
        <ul className="cc-libs" aria-label="Libraries">
          {libraries.map(l => {
            const a = l.actions!.find(x => x.id === 'library')!;
            return (
              <li key={l.id} data-item-id={l.id}>
                <button type="button" className="cc-lib" aria-label={a.label} disabled={props.busy || a.disabled} onClick={() => void emit('library', l.id)}>
                  <Icon name="film2" size={16} /><span>{l.text}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {titles.length > 0 ? (
        <ul className="cc-posters" aria-label="Titles">
          {titles.map(t => {
            const p = parseKind(t.text);
            const a = t.actions!.find(x => x.id === 'choose')!;
            return (
              <li key={t.id} data-item-id={t.id} className="cc-poster" style={{ ['--tilt' as string]: `${(hashOf(t.id) % 5) - 2}`, ['--ph' as string]: `${[30, 60, 95, 150, 185, 215, 15, 5][(Math.imul(hashOf(p.title), 2654435761) >>> 29) % 8]}` }}>
                <div className="cc-poster__face" aria-hidden>
                  <span className="cc-poster__title cc-display">{p.title}</span>
                  {p.kind && <span className="cc-poster__kind">{p.kind}</span>}
                </div>
                <span className="cc-sr">{t.text}</span>
                <button type="button" className="cc-btn cc-btn--raised" aria-label={a.label} disabled={props.busy || a.disabled} title={a.disabled ? 'Only the host can pick' : undefined} onClick={() => void emit('choose', t.id)}>
                  <Icon name="play" size={15} /><span>Watch together</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="cc-blank">
          <p className="cc-display">{libraries.length ? 'Open a library' : 'No libraries'}</p>
          <p>{libraries.length ? 'Titles from that library show up here.' : 'The server could not list any Plex libraries.'}</p>
        </div>
      )}
    </Page>
  );
}

/* ── DJ search ───────────────────────────────────────────────── */

export function DjScreen(props: ScreenProps) {
  useView(props.id);
  const emit = useEmit(props);
  const items = props.items ?? [];
  return (
    <Page props={props} icon="disc" title="Steve Forever" subtitle={<>Search a song or paste a YouTube, SoundCloud or Spotify link. The DJ voice is a placeholder until the reference clip arrives.<span className="cc-sr"> {props.title}</span></>}>
      <ContractForm props={props} submitIcon="search"
        hints={{ query: { icon: 'disc', hideLabel: true, size: 'l', autoFocus: true, placeholder: 'Song, artist, or a link', inputMode: 'search' } }}
        render={(f, submit) => <div className="cc-searchbar">{f.query}{submit}</div>} />
      {items.length > 0 ? (
        <ul className="cc-tracks" aria-label="Results">
          {items.map(r => {
            const p = parseDuration(r.text);
            const a = r.actions?.find(x => x.id === 'choose');
            return (
              <li key={r.id} data-item-id={r.id} className="cc-track">
                <Icon name="note" size={18} className="cc-rows__glyph" />
                <span className="cc-track__title">{p.title}</span>
                <span className="cc-sr">{r.text.slice(p.title.length)}</span>
                {p.seconds !== undefined && <span className="cc-track__len cc-num" aria-hidden>{clockMs(p.seconds * 1000)}</span>}
                {a && <ActionButton action={a} emit={emit} busy={props.busy} itemId={r.id} icon="plus" text="Queue" />}
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="cc-blank"><p className="cc-display">What are we playing?</p><p>Preparing a song takes a moment: the DJ writes a line, records it, and the track is checked like any upload.</p></div>
      )}
    </Page>
  );
}

/* ── GIF picker ──────────────────────────────────────────────── */

export function GifsScreen(props: ScreenProps) {
  useView(props.id);
  const emit = useEmit(props);
  const items = props.items ?? [];
  const unavailable = props.phase === 'unavailable';
  return (
    <Page props={props} icon="sparkle" title="GIFs" subtitle={<span className="cc-giphy">Powered by GIPHY<span className="cc-sr"> {props.title}</span></span>}>
      {unavailable ? (
        <ul className="cc-blank" aria-label="Status">
          {items.map(i => <li key={i.id} data-item-id={i.id}><p className="cc-display">GIFs are switched off</p><p>{i.text}</p></li>)}
        </ul>
      ) : (
        <>
          <ContractForm props={props} submitIcon="search"
            hints={{ query: { icon: 'search', hideLabel: true, size: 'l', autoFocus: true, placeholder: 'Search GIPHY', inputMode: 'search' } }}
            render={(f, submit) => <div className="cc-searchbar">{f.query}{submit}</div>} />
          {items.length ? (
            <ul className="cc-gifs" aria-label="GIFs">
              {items.map(g => {
                const a = g.actions?.find(x => x.id === 'choose');
                return (
                  <li key={g.id} data-item-id={g.id} className="cc-gif" style={{ ['--h' as string]: hashOf(g.id) % 360 }}>
                    <span className="cc-gif__title">{g.text || 'Untitled GIF'}</span>
                    {a && <ActionButton action={a} emit={emit} busy={props.busy} itemId={g.id} icon="plus" text="Use" variant="quiet" />}
                  </li>
                );
              })}
            </ul>
          ) : <div className="cc-blank"><p className="cc-display">Search for a reaction</p><p>Picking one drops its link into your message.</p></div>}
        </>
      )}
    </Page>
  );
}

/* ── Gimme ───────────────────────────────────────────────────── */

const TONE_ICON = { preview: 'film', ok: 'check', wait: 'diamond', warn: 'warn', fail: 'warn' } as const;

export function GimmeScreen(props: ScreenProps) {
  useView(props.id);
  const dry = /dry run/i.test(props.title);
  const items = props.items ?? [];
  return (
    <Page props={props} icon="film" title="Gimme" subtitle={<>
      Ask for a movie or a show and the status lands in this channel.{dry && <strong> Dry run: nothing is sent to Gimme yet.</strong>}
      <span className="cc-sr"> {props.title}</span>
    </>}>
      <ContractForm props={props} submitIcon="arrowUpRight"
        hints={{ query: { icon: 'film', size: 'l', hideLabel: true, placeholder: 'Arrival, Severance, Paddington 2', autoFocus: true }, tv: { hint: 'Shows subscribe to new episodes instead of one download.' } }}
        render={(f, submit) => <><div className="cc-searchbar">{f.query}{submit}</div>{f.tv}</>} />
      <p className="cc-muted cc-gimme__tip">Shortcut from any message box: <code className="cc-code">/gimme movie Arrival</code></p>
      {items.length ? (
        <ul className="cc-rows cc-gimme" aria-label="Requests">
          {items.map(r => {
            const p = parseGimme(r.text);
            const tone = gimmeTone(p.status);
            return (
              <li key={r.id} data-item-id={r.id} className={`cc-item is-${tone}`}>
                <Icon name={TONE_ICON[tone]} size={17} className="cc-rows__glyph" />
                <span className="cc-rows__main"><strong>{p.title}</strong><span className="cc-sr">: </span><span className="cc-rows__meta">{p.status}</span></span>
              </li>
            );
          })}
        </ul>
      ) : <div className="cc-blank"><p className="cc-display">No requests yet</p></div>}
    </Page>
  );
}

/* ── Uploads ─────────────────────────────────────────────────── */

const UPLOAD_COPY: Record<string, string> = { uploading: 'Uploading', ready: 'Ready', quarantined: 'Blocked by the scanner. Nobody can open it.', paused: 'Paused' };
const VIDEO_COPY: Record<string, string> = { queued: 'Waiting to make a streamable copy', running: 'Making a streamable copy and a thumbnail', ready: 'Video ready to stream', failed: 'Video preparation failed' };

export function UploadsScreen(props: ScreenProps) {
  useView(props.id);
  const emit = useEmit(props);
  const items = props.items ?? [];
  const pause = find(props.actions, 'pause');
  const derive = find(props.actions, 'derive');
  const attach = find(props.actions, 'attach');
  return (
    <Page props={props} handled={['pause', 'derive', 'attach']} icon="upload" title="Upload" subtitle={<>Any size. It goes up in pieces, so a dropped connection picks up where it stopped. Files are scanned before anyone can open them.<span className="cc-sr"> {props.title}</span></>}>
      <ContractForm props={props} submitIcon="upload" render={(f, submit) => <div className="cc-upload-pick">{f.file}{submit}</div>} />
      {items.map(item => {
        const u = parseUpload(item.text);
        const tone = u?.status === 'quarantined' ? 'danger' : u?.status === 'ready' ? 'ok' : undefined;
        const f = u ? fraction(u.sent, u.total) : 0;
        return (
          <ul key={item.id} className="cc-uploads">
            <li data-item-id={item.id} className={cx('cc-upload', tone && `is-${tone}`)}>
              <span className="cc-sr">{item.text}</span>
              {u ? (
                <div aria-hidden className="cc-upload__vis">
                  <div className="cc-upload__top">
                    <Icon name={tone === 'danger' ? 'shield' : 'upload'} size={18} />
                    <strong>{u.name}</strong>
                    <span className="cc-num cc-upload__pct">{Math.round(f * 100)}%</span>
                  </div>
                  <Progress value={f} label={`${u.name} upload`} tone={tone} />
                  <p className="cc-upload__meta">
                    <span>{UPLOAD_COPY[u.status] ?? u.status}</span>
                    <span className="cc-num">{bytes(u.sent)} of {bytes(u.total)}</span>
                  </p>
                  {u.video && <p className={cx('cc-upload__video', u.video === 'failed' && 'is-failed')}><Icon name="film" size={15} />{VIDEO_COPY[u.video] ?? u.video}{u.videoError ? `: ${u.videoError}` : ''}</p>}
                </div>
              ) : <p>{item.text}</p>}
            </li>
          </ul>
        );
      })}
      <div className="cc-upload__actions">
        {pause && <ActionButton action={pause} emit={emit} busy={props.busy} icon="pause" variant="quiet" />}
        {derive && <ActionButton action={derive} emit={emit} busy={props.busy} icon="film" />}
        {attach && <ActionButton action={attach} emit={emit} busy={props.busy} icon="link" variant="primary" />}
      </div>
    </Page>
  );
}

/* ── Link preview ────────────────────────────────────────────── */

export function LinkPreviewScreen(props: ScreenProps) {
  useView(props.id);
  const by = (id: string) => props.items?.find(i => i.id === id);
  const host = by('host'), title = by('title'), desc = by('description'), url = by('url');
  return (
    <Page props={props} icon="link" title="Link preview" subtitle={<>Fetched by the server on your request. No images or scripts from the site are loaded.<span className="cc-sr"> {props.title}</span></>}>
      {url ? (
        <ul className="cc-embed">
          {host && <li data-item-id="host" className="cc-embed__site">{host.text}</li>}
          {title && <li data-item-id="title" className="cc-embed__title cc-display">{title.text}</li>}
          {desc && <li data-item-id="description" className="cc-embed__desc">{desc.text}</li>}
          <li data-item-id="url" className="cc-embed__url">
            {/^https:\/\//.test(url.text) ? <a className="cc-link" href={url.text} target="_blank" rel="noopener noreferrer nofollow">{url.text}</a> : url.text}
          </li>
        </ul>
      ) : <div className="cc-blank"><p className="cc-display">No preview</p></div>}
    </Page>
  );
}

/* ── Report a problem ────────────────────────────────────────── */

export function ReportScreen(props: ScreenProps) {
  useView(props.id);
  const form = useRef<HTMLFormElement>(null);
  const [feature, setFeature] = useState(false);
  const [extras, setExtras] = useState({ logs: false, logsOk: false, shot: false, shotOk: false });
  const sync = () => {
    const f = form.current;
    if (!f) return;
    const v = (n: string) => f.elements.namedItem(n) as HTMLInputElement | null;
    setExtras({ logs: !!v('logs')?.value.trim(), logsOk: !!v('logs_consent')?.checked, shot: !!v('report_screenshot')?.files?.length, shotOk: !!v('screenshot_consent')?.checked });
  };
  return (
    <Page props={props} icon={feature ? 'bulb' : 'bug'} title={feature ? 'Suggest something' : 'Report a problem'}
      subtitle={<>Goes straight to Christopher. Nothing is attached unless you add it and tick its consent box.<span className="cc-sr"> {props.title}</span></>}>
      <div onChange={e => { const t = e.target as HTMLInputElement; if (t.name === 'feature') setFeature(t.checked); sync(); }} onInput={sync}>
        <ContractForm props={props} formRef={form} submitIcon="arrowUpRight"
          hints={{
            feature: { hint: 'Leave off for a bug report.' },
            body: { multiline: true, placeholder: feature ? 'What would make Housecall better?' : 'What happened, and what did you expect?' },
            logs: { multiline: true, placeholder: 'Paste only what helps. Remove tokens, passwords and private messages.', hint: 'Lines that look like secrets are redacted again before they are stored.' },
            report_screenshot: { accept: 'image/png,image/jpeg,image/webp', placeholder: 'PNG, JPEG or WebP' },
          }}
          render={(f, submit) => (
            <>
              <div className="cc-report__kindbox">{f.feature}</div>
              {f.body}
              <fieldset className="cc-attach">
                <legend>Optional extras</legend>
                {f.logs}{f.logs_consent}
                {extras.logs && !extras.logsOk && <p className="cc-consent-warn" role="status"><Icon name="warn" size={15} />Without the tick, these logs stay on this device and are not sent.</p>}
                {f.report_screenshot}{f.screenshot_consent}
                {extras.shot && !extras.shotOk && <p className="cc-consent-warn" role="status"><Icon name="warn" size={15} />Tick the box to send the screenshot, or the report will not go out.</p>}
              </fieldset>
              <div className="cc-form__go">{submit}</div>
            </>
          )} />
      </div>
    </Page>
  );
}

/* ── Reports (owner) ─────────────────────────────────────────── */

export function ReportsAdminScreen(props: ScreenProps) {
  useView(props.id);
  const emit = useEmit(props);
  const items = props.items ?? [];
  const open = items.filter(i => !/\(resolved\)( — Consented logs:|$)/.test(i.text)).length;
  return (
    <Page props={props} icon="inbox" subtitle={`${open} open of ${items.length}. Logs and screenshots are here only because the reporter agreed to send them.`}>
      {items.length ? (
        <ul className="cc-reports" aria-label="Reports">
          {items.map(item => {
            const r = parseReport(item.text);
            const resolved = r?.status === 'resolved';
            return (
              <li key={item.id} data-item-id={item.id} className={cx('cc-report', resolved && 'is-resolved')}>
                <span className="cc-sr">{item.text}</span>
                <div className="cc-report__head" aria-hidden>
                  <Icon name={r?.kind === 'feature' ? 'bulb' : 'bug'} size={18} />
                  <strong>{r?.kind === 'feature' ? 'Idea' : 'Problem'}</strong>
                  <span className={cx('cc-report__status', resolved && 'is-done')}>{r?.status ?? ''}</span>
                </div>
                <p className="cc-report__body" aria-hidden>{r?.body ?? item.text}</p>
                {r?.logs && <pre className="cc-pre cc-report__logs" aria-hidden>{r.logs}</pre>}
                <div className="cc-report__actions">
                  {item.actions?.map(a => <ActionButton key={a.id} action={a} emit={emit} busy={props.busy} itemId={item.id} icon={a.id === 'resolve' ? 'check' : 'download'} variant={a.id === 'resolve' ? 'raised' : 'quiet'} />)}
                </div>
              </li>
            );
          })}
        </ul>
      ) : <div className="cc-blank"><p className="cc-display">Inbox zero</p><p>Nobody has reported anything.</p></div>}
    </Page>
  );
}
