import { useEffect, useRef, useState } from 'react';
import type { Item, ScreenProps } from '../../contracts/ui';
import { Icon, ObeliskMark } from '../icons/Icon';
import { ActionButton, ContractForm, ItemList, Page, fieldIn, find, setNativeValue, useEmit, type Emit } from '../contract';
import { Avatar, cx } from '../primitives';
import { parseNameId } from '../parse';
import { setUi, useUi } from '../store';

function useView(id: ScreenProps['id']) { useEffect(() => { setUi({ view: id }); }, [id]); }

/* ── Search and pins ─────────────────────────────────────────── */

export function SearchScreen(props: ScreenProps) {
  useView(props.id);
  const pins = props.id === 'pins';
  const channel = useUi(s => s.channelTitle);
  const [ran, setRan] = useState(false);
  const items = props.items ?? [];
  return (
    <Page props={props} icon={pins ? 'pin' : 'search'} subtitle={channel ? <>In <strong>#{channel}</strong>. Unsent messages never show up here.</> : undefined}>
      <div onSubmit={() => setRan(true)}>
        <ContractForm props={props} submitIcon={pins ? 'pin' : undefined} submitVariant={pins ? 'raised' : 'primary'}
          hints={{ query: { icon: 'search', hideLabel: true, placeholder: 'Words, names, links', size: 'l', autoFocus: true, inputMode: 'search' } }}
          render={(f, submit) => <div className="cc-searchbar">{f.query}{submit}</div>} />
      </div>
      {items.length ? (
        <ul className="cc-results" aria-label={pins ? 'Pinned messages' : 'Results'}>
          {items.map(m => (
            <li key={m.id} data-item-id={m.id} className="cc-result">
              <Icon name={pins ? 'pin' : 'chat'} size={16} />
              <p>{m.text}</p>
            </li>
          ))}
        </ul>
      ) : (
        <div className="cc-blank">
          <p className="cc-display">{pins ? (ran ? 'Nothing pinned here' : 'Pins live here') : ran ? 'No matches' : 'Find anything said here'}</p>
          <p>{pins ? 'Pin a message from its actions and it stays one click away for everyone.' : ran ? 'Try fewer words, or a name.' : 'Search covers this conversation.'}</p>
        </div>
      )}
    </Page>
  );
}

/* ── Members ─────────────────────────────────────────────────── */

export function MembersScreen(props: ScreenProps) {
  useView(props.id);
  const items = props.items ?? [];
  return (
    <Page props={props} icon="members" subtitle={`${items.length} ${items.length === 1 ? 'person' : 'people'} on this server`}>
      <ItemList props={props} className="cc-members" label="Members" empty={<div className="cc-blank"><p className="cc-display">Just you so far</p><p>Invitations are how people get in.</p></div>}
        render={item => {
          const owner = item.text.endsWith(' (owner)');
          const name = item.text.replace(/^@/, '').replace(/ \(owner\)$/, '');
          return (
            <>
              <Avatar name={name} size={40} presence={false} />
              <span className="cc-member__name"><span className="cc-sr">@</span>{name}{owner && <span className="cc-sr"> (owner)</span>}</span>
              {owner && <span className="cc-member__role"><ObeliskMark size={13} /><span aria-hidden>Owner</span></span>}
            </>
          );
        }} />
    </Page>
  );
}

/* ── Member picker used by DMs and channel creation ──────────── */

function MemberPicker({ items, form, field, label }: { items: Item[]; form: React.RefObject<HTMLFormElement | null>; field: string; label: string }) {
  const [picked, setPicked] = useState<string[]>([]);
  useEffect(() => {
    const el = fieldIn(form.current, field);
    if (!el) return;
    const sync = () => setPicked(el.value.split(',').map(s => s.trim()).filter(Boolean));
    sync();
    el.addEventListener('input', sync);
    return () => el.removeEventListener('input', sync);
  }, [form, field]);
  function toggle(id: string) {
    const el = fieldIn(form.current, field);
    const next = picked.includes(id) ? picked.filter(x => x !== id) : [...picked, id];
    setNativeValue(el, next.join(', '));
  }
  if (!items.length) return <p className="cc-muted">Nobody else here yet.</p>;
  return (
    <ul className="cc-picker" aria-label={label}>
      {items.map(item => {
        const p = parseNameId(item.text);
        const on = !!p && picked.includes(p.id);
        return (
          <li key={item.id} data-item-id={item.id} className={cx('cc-pick', on && 'is-on')}>
            <Avatar name={p?.name ?? item.text} size={30} presence={false} />
            <span className="cc-pick__text">{p ? <><span className="cc-pick__name">{p.name}</span><span className="cc-sr">: </span><span className="cc-pick__id cc-mono">{p.id}</span></> : item.text}</span>
            {p && (
              <button type="button" className={cx('cc-ibtn', on && 'is-active')} aria-pressed={on} aria-label={on ? `Remove ${p.name}` : `Add ${p.name}`} onClick={() => toggle(p.id)}>
                <Icon name={on ? 'check' : 'plus'} size={17} />
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function DirectMessagesScreen(props: ScreenProps) {
  useView(props.id);
  const form = useRef<HTMLFormElement>(null);
  return (
    <Page props={props} icon="chat" subtitle="One person makes a DM. Two or more make a group. Only the people you pick can read it.">
      <div className="cc-split">
        <ContractForm props={props} formRef={form} submitIcon="arrowUpRight"
          hints={{ name: { placeholder: 'Movie night, Just us' }, member_ids: { hint: 'Fills in as you pick people.' } }} />
        <MemberPicker items={props.items ?? []} form={form} field="member_ids" label="People" />
      </div>
    </Page>
  );
}

export function ChannelsAdminScreen(props: ScreenProps) {
  useView(props.id);
  const form = useRef<HTMLFormElement>(null);
  return (
    <Page props={props} icon="hash" subtitle="Pick who can see it. With nobody picked, only you can.">
      <div className="cc-split">
        <ContractForm props={props} formRef={form} submitIcon="plus"
          hints={{ name: { placeholder: 'film-club' }, member_ids: { hint: 'Fills in as you pick people.' }, server_id: { hint: 'The server this channel belongs to.' } }} />
        <MemberPicker items={props.items ?? []} form={form} field="member_ids" label="Members" />
      </div>
    </Page>
  );
}

/* ── Roles and servers ──────────────────────────────────────── */

export function RolesAdminScreen(props: ScreenProps) {
  useView(props.id);
  return (
    <Page props={props} icon="at" subtitle="Roles are @-mentionable groups. Make one, then add people by ID.">
      <div className="cc-split">
        <ContractForm props={props} submitIcon="plus" />
        <ItemList props={props} className="cc-rows" label="Roles" empty={<p className="cc-muted">No roles yet.</p>}
          render={item => {
            const m = /^(.*): (\S+) \((\d+) members\)$/.exec(item.text);
            return (
              <>
                <Icon name="at" size={18} className="cc-rows__glyph" />
                <span className="cc-rows__main">
                  {m ? <><strong>{m[1]}</strong><span className="cc-sr">: </span><span className="cc-mono cc-muted">{m[2]}</span><span className="cc-rows__meta"> ({m[3]} members)</span></> : item.text}
                </span>
                <RowActions props={props} item={item} />
              </>
            );
          }} />
      </div>
    </Page>
  );
}

export function ServersAdminScreen(props: ScreenProps) {
  useView(props.id);
  return (
    <Page props={props} icon="globe" subtitle="Each server has its own channels, roles and invitations.">
      <ItemList props={props} className="cc-servers" label="Servers" empty={<p className="cc-muted">No servers yet.</p>}
        render={item => {
          const p = parseNameId(item.text);
          return (
            <>
              <ObeliskMark size={22} lit={false} />
              <span className="cc-rows__main">{p ? <><strong>{p.name}</strong><span className="cc-sr">: </span><span className="cc-mono cc-muted">{p.id}</span></> : item.text}</span>
              <RowActions props={props} item={item} primary />
            </>
          );
        }} />
      {props.fields?.length ? (
        <div className="cc-inline-form">
          <ContractForm props={props} submitIcon="plus" render={(f, submit) => <div className="cc-searchbar">{f.name}{submit}</div>} />
        </div>
      ) : null}
    </Page>
  );
}

function RowActions({ props, item, primary }: { props: ScreenProps; item: Item; primary?: boolean }) {
  const emit = useEmit(props);
  return (
    <span className="cc-rows__actions">
      {item.actions?.map(a => (
        <ActionButton key={a.id} action={a} emit={emit} busy={props.busy} itemId={item.id}
          icon={a.id === 'delete' ? 'trash' : a.id === 'select' ? 'arrowUpRight' : a.id === 'revoke' ? 'close' : undefined}
          variant={a.id === 'delete' || a.id === 'revoke' ? 'danger' : primary ? 'raised' : 'quiet'}
          text={a.id === 'select' ? 'Open' : undefined} />
      ))}
    </span>
  );
}

/* ── Devices ─────────────────────────────────────────────────── */

export function DevicesScreen(props: ScreenProps) {
  useView(props.id);
  const emit = useEmit(props);
  const passkey = find(props.actions, 'passkey');
  return (
    <Page props={props} handled={['passkey']} icon="fingerprint" title="Your devices" subtitle="Every place you are signed in. Revoking one signs it out right away.">
      {passkey && (
        <div className="cc-passkey">
          <Icon name="fingerprint" size={28} className="cc-passkey__glyph" />
          <div>
            <h2>Passkeys</h2>
            <p>{passkey.disabled ? 'This server has no passkey support turned on.' : 'Use your fingerprint, face or device PIN instead of a password next time.'}</p>
          </div>
          <ActionButton action={passkey} emit={emit} busy={props.busy} icon="plus" variant="primary" />
        </div>
      )}
      <ItemList props={props} className="cc-devices" label="Sessions"
        empty={<div className="cc-blank"><p className="cc-display">Loading sessions</p></div>}
        render={item => {
          const current = item.text.endsWith(' (this device)');
          const name = item.text.replace(/ \(this device\)$/, '');
          return (
            <>
              <Icon name={/phone|android|iphone/i.test(name) ? 'user' : 'screen'} size={20} className="cc-rows__glyph" />
              <span className="cc-rows__main"><strong>{name}</strong>{current && <span className="cc-device__here"> (this device)</span>}</span>
              {item.actions?.map(a => (
                <ActionButton key={a.id} action={a} emit={emit} busy={props.busy} itemId={item.id} variant="quiet" className={current ? undefined : 'cc-btn--danger-text'} icon="close" />
              ))}
            </>
          );
        }} />
    </Page>
  );
}

/* ── Notifications ───────────────────────────────────────────── */

export function NotificationsScreen(props: ScreenProps) {
  useView(props.id);
  const emit = useEmit(props);
  const enable = find(props.actions, 'enable');
  const permission = typeof Notification === 'undefined' ? 'unavailable' : Notification.permission;
  return (
    <Page props={props} handled={['enable']} icon="bell" subtitle="When someone unsends a message, its notification disappears here and on this device too.">
      {enable && (
        <div className="cc-passkey">
          <Icon name="bell" size={26} className="cc-passkey__glyph" />
          <div>
            <h2>Desktop alerts</h2>
            <p>{permission === 'granted' ? 'Allowed on this device.' : permission === 'denied' ? 'Blocked in this browser. Allow notifications in its site settings.' : permission === 'unavailable' ? 'This browser has no notification support.' : 'Not asked yet.'}</p>
          </div>
          <ActionButton action={enable} emit={emit} busy={props.busy} icon="bell" variant={permission === 'granted' ? 'quiet' : 'primary'} text={permission === 'granted' ? 'Enabled' : undefined} />
        </div>
      )}
      <ItemList props={props} className="cc-rows" label="Notifications"
        empty={<div className="cc-blank"><p className="cc-display">All caught up</p><p>Mentions and replies show up here.</p></div>}
        render={item => <><Icon name="at" size={17} className="cc-rows__glyph" /><span className="cc-rows__main">{item.text}</span></>} />
    </Page>
  );
}

/* ── Invitations ─────────────────────────────────────────────── */

const EXPIRY = [{ s: 3600, label: '1 hour' }, { s: 86400, label: '1 day' }, { s: 604800, label: '7 days' }];

export function InvitesAdminScreen(props: ScreenProps) {
  useView(props.id);
  const form = useRef<HTMLFormElement>(null);
  const [secs, setSecs] = useState(props.fields?.find(f => f.name === 'expires_in_seconds')?.value ?? '3600');
  const [copied, setCopied] = useState(false);
  const issued = props.items?.find(i => i.id === 'issued');
  useEffect(() => setCopied(false), [issued?.text]);
  return (
    <Page props={props} icon="key" subtitle="Each link works once, for one person, until it expires. Nobody can sign up without one.">
      <div className="cc-invite">
        <div className="cc-presets cc-presets--row" role="group" aria-label="Expires after">
          {EXPIRY.map(e => (
            <button key={e.s} type="button" className={cx('cc-preset', secs === String(e.s) && 'is-on')} aria-pressed={secs === String(e.s)}
              onClick={() => { setSecs(String(e.s)); setNativeValue(fieldIn(form.current, 'expires_in_seconds'), String(e.s)); }}>
              <strong>{e.label}</strong>
            </button>
          ))}
        </div>
        <div onInput={e => { const t = e.target as HTMLInputElement; if (t.name === 'expires_in_seconds') setSecs(t.value); }}>
          <ContractForm props={props} formRef={form} submitIcon="key"
            hints={{ expires_in_seconds: { inputMode: 'numeric', hint: 'Seconds until the link stops working.' } }} />
        </div>
      </div>
      {issued && (
        <section className="cc-issued" aria-labelledby="cc-issued-h">
          <h2 id="cc-issued-h" className="cc-section-title">Send this link to one person</h2>
          <ul>
            <li data-item-id={issued.id} className="cc-issued__link">
              <code className="cc-mono">{issued.text}</code>
              <button type="button" className={cx('cc-ibtn', copied && 'is-active')} aria-label={copied ? 'Copied' : 'Copy invitation link'} data-tip={copied ? 'Copied' : 'Copy'}
                onClick={() => { void navigator.clipboard?.writeText(issued.text).then(() => setCopied(true)).catch(() => {}); }}>
                <Icon name={copied ? 'check' : 'copy'} size={18} />
              </button>
            </li>
          </ul>
          <p className="cc-muted">It is shown once. The invite token sits after the # so it never reaches server logs.</p>
        </section>
      )}
    </Page>
  );
}

export { useView };
export type { Emit };
