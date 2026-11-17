import { hostedTarget } from "./target";
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useIdentity } from '../core/context';
import { parseServerInput } from '../data/serverInput';
import { Logo } from '../ui/brand/Logo';
import { Button, ErrorLine, Field, IconButton, NavRow } from '../ui/kit';
import { ServerPicker } from '../ui/shell/ServerPicker';
import { useHosted } from './HostedAccount';

export function AccountLogin({ onBack }: { onBack?: () => void }) {
  const h = useHosted()!;
  const errorId = useId();
  const signup = h.view === 'signup';
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const form = useRef<HTMLFormElement>(null);
  const error = /Incorrect|wrong password/i.test(h.error) ? 'Wrong username or password.' : /Username unavailable/i.test(h.error) ? 'That username is taken.' : /unavailable/i.test(h.error) ? "HouseCall accounts aren't available right now. You can still connect directly to a friend's server." : h.error;
  useEffect(() => { if (error) form.current?.querySelector<HTMLInputElement>('input[type=password]')?.focus(); }, [error]);
  const submit = (event: FormEvent) => { event.preventDefault(); void h.authenticate(name, password, signup); setPassword(''); };
  return <main className="hc-onb"><div className="hc-onb__screen">
    <form ref={form} className="hc-onb__form hc-onb__form--compact" onSubmit={submit} onFocus={() => {
      if (matchMedia('(pointer: coarse)').matches) form.current?.querySelector('button[type=submit]')?.scrollIntoView({ block: 'nearest' });
    }}>
      <div className="hc-onb__top">{onBack ? <IconButton icon="back" label="Back" onClick={onBack} /> : <a href="/" aria-label="HouseCall home"><Logo /></a>}</div>
      <header className="hc-onb__title"><h1>{signup ? 'Create a HouseCall account' : 'Log in to HouseCall'}</h1></header>
      <Field label="Username" value={name} onChange={e => setName(e.target.value)} autoFocus autoComplete="username" autoCapitalize="none" spellCheck={false} required pattern="[A-Za-z0-9_]{3,32}" maxLength={32} enterKeyHint="next" onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); form.current?.querySelector<HTMLInputElement>('input[type=password]')?.focus(); } }} />
      <Field label="Password" aria-invalid={!!error} aria-describedby={error ? errorId : undefined} type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete={signup ? 'new-password' : 'current-password'} required minLength={12} maxLength={256} enterKeyHint="go" />
      {signup && <p className="hc-onb__help">3 to 32 letters, numbers or underscores. There's no password reset, so keep your password somewhere safe.</p>}
      <div id={errorId}><ErrorLine text={error} /></div>
      <div className="hc-onb__actions"><Button kind="primary" type="submit" busy={h.busy}>{signup ? 'Create account' : 'Log in'}</Button>
        <Button kind="text" onClick={() => { setPassword(''); h.go(signup ? 'login' : 'signup'); }}>{signup ? 'Have an account? Log in' : 'New here? Create an account'}</Button></div>
      <ul className="hc-navgroup hc-onb__ask"><li><NavRow label="Connect directly to a friend's server" detail="No HouseCall account needed" onClick={() => { setPassword(''); h.go('direct'); }} /></li></ul>
    </form>
  </div></main>;
}

export function DirectLogin() {
  const h = useHosted()!; const identity = useIdentity();
  const [address, setAddress] = useState(''); const [name, setName] = useState(''); const [password, setPassword] = useState('');
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError('');
    try {
      const { origin } = hostedTarget(address);
      await identity.checkServer(origin);
      await identity.signIn({ address: origin, username: name.trim(), password });
      setPassword('');
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not connect.'); }
    finally { setBusy(false); }
  };
  return <main className="hc-onb"><div className="hc-onb__screen"><form className="hc-onb__form hc-onb__form--compact" onSubmit={e => void submit(e)} onFocus={e => { if (matchMedia('(pointer: coarse)').matches) e.currentTarget.querySelector('button[type=submit]')?.scrollIntoView({ block: 'nearest' }); }}>
    <div className="hc-onb__top"><IconButton icon="back" label="Back" onClick={() => h.go('login')} /></div>
    <header className="hc-onb__title"><h1>Connect to a friend's server</h1></header>
    <Field label="Server address" value={address} onChange={e => setAddress(e.target.value)} placeholder="chat.example.com" autoFocus inputMode="url" autoCapitalize="none" autoComplete="off" required />
    <Field label="Username" name="server-username" value={name} onChange={e => setName(e.target.value)} autoCapitalize="none" autoComplete="section-server username" required />
    <Field label="Password" name="server-password" type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="section-server current-password" required enterKeyHint="go" />
    <p className="hc-onb__help">Your username and password go only to this server.</p>
    {h.account.list && <label className="hc-check"><input type="checkbox" checked={h.saveAfterLogin} onChange={e => h.setSaveAfterLogin(e.target.checked)} />Save to my HouseCall list</label>}
    <ErrorLine text={error || identity.error} />
    {error && address && <a href={(() => { try { return parseServerInput(address).origin; } catch { return undefined; } })()} rel="noreferrer noopener">Open server directly</a>}
    <div className="hc-onb__actions"><Button kind="primary" type="submit" busy={busy || identity.busy}>Log in</Button>
      <Button kind="text" onClick={() => { try { identity.addServer(address); } catch (e) { setError(String(e)); } }}>Have an invite? Join instead</Button></div>
  </form></div></main>;
}

export function HostedHome() {
  const h = useHosted()!; const [settings, setSettings] = useState(false);
  return <div className="hc-shell hc-hosted-home"><nav className="hc-left" aria-label="HouseCall"><ServerPicker /><Button kind="text" onClick={() => setSettings(true)}>HouseCall account</Button></nav>
    <main className="hc-center"><div className="hc-hosted-stage">{settings ? <><IconButton icon="back" label="Back" onClick={() => setSettings(false)} /><AccountSettings /></> : h.view === 'discover' ? <Discover /> : <><h1>No servers yet</h1><ul className="hc-navgroup"><li><NavRow label="Add server" detail="Address or invite" onClick={() => h.go('direct')} /></li><li><NavRow label="Discover servers" detail="Search public servers" onClick={() => h.go('discover')} /></li></ul></>}</div></main></div>;
}

export function AccountSettings() {
  const h = useHosted()!; const identity = useIdentity(); const [confirm, setConfirm] = useState(''); const [deletion, setDeletion] = useState('');
  if (!h.account.list) return <div className="hc-stack"><p>Log in to keep your server list on every device.</p><Button kind="primary" onClick={() => { h.setOverlay(true); h.go('login'); }}>Log in</Button><Button kind="text" onClick={() => { h.setOverlay(true); h.go('signup'); }}>Create an account</Button></div>;
  const download = () => { const url = URL.createObjectURL(new Blob([JSON.stringify(h.account.list, null, 2)], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = 'housecall-servers.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); };
  const origin = identity.address ? parseServerInput(identity.address).origin + '/' : '';
  return <div className="hc-stack"><p>Username: {h.account.name}</p><h2>Your server list</h2><ErrorLine text={h.error} />
    <ul className="hc-tiles">{h.account.list.servers.map(server => <li className="hc-tile-row" key={server}><span className="hc-tile-row__text">{confirm === server ? `Remove ${new URL(server).host} from your list? Your community account and messages stay.` : new URL(server).host}</span><Button kind="text" busy={h.busy} onClick={() => confirm === server ? void h.unlink(server).then(() => setConfirm('')) : setConfirm(server)}>Remove</Button>{confirm === server && <Button kind="text" onClick={() => setConfirm('')}>Cancel</Button>}</li>)}</ul>
    {identity.signedIn && origin && !h.account.list.servers.some(saved => new URL(saved).origin === new URL(origin).origin) && <Button onClick={() => void h.saveOrigin(origin)} busy={h.busy}>Save this server</Button>}
    <Button onClick={download}>Download server list</Button><p className="hc-note">The downloaded list contains unencrypted server addresses.</p>
    <label className="hc-field">Import server list<input type="file" accept="application/json" onChange={e => { const file = e.target.files?.[0]; if (file && file.size > 65536) void h.act(async () => { throw new Error('Server list is too large.'); }); if (file && file.size <= 65536) void file.text().then(text => h.importList(JSON.parse(text))).catch(() => h.act(async () => { throw new Error('Invalid server list.'); })); e.target.value = ''; }} /></label>
    <p className="hc-note">There's no password reset. If you forget your password, your saved list can't be recovered.</p>
    {confirm === 'logout' ? <><p>Log out of HouseCall and every server in this browser?</p><Button kind="danger" onClick={() => void h.logout()}>Log out</Button><Button kind="text" onClick={() => setConfirm('')}>Cancel</Button></> : <Button kind="danger" onClick={() => setConfirm('logout')}>Log out of HouseCall</Button>}
    <a href="/source/housecall-public-source.tar.gz">Source code</a>
    <details><summary>Delete HouseCall account</summary><p>Deletes your HouseCall login and encrypted saved list. Community accounts and messages stay.</p><Field label="Type DELETE to confirm" value={deletion} onChange={e => setDeletion(e.target.value)} /><Button kind="danger" disabled={deletion !== 'DELETE'} onClick={() => void h.deleteAccount()}>Delete account</Button></details>
  </div>;
}

type Listing = { origin: string; name: string; description: string };
export function Discover() {
  const h = useHosted()!; const [query, setQuery] = useState(''); const [rows, setRows] = useState<Listing[]>([]); const [next, setNext] = useState<number | null>(null); const [state, setState] = useState('Searching');
  const generation = useRef(0);
  const results = useRef<HTMLUListElement>(null);
  const focusNew = useRef<number | null>(null);
  useEffect(() => { if (focusNew.current !== null) { results.current?.children[focusNew.current]?.querySelector('button')?.focus(); focusNew.current = null; } }, [rows]);
  const search = async (offset = 0) => {
    const current = ++generation.current; setState('Searching');
    try {
      const response = await fetch('/api/directory?q=' + encodeURIComponent(query) + '&offset=' + offset, { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(12000) });
      if (!response.ok) throw new Error(); const result = await response.json() as { listings: Listing[]; next: number | null };
      if (current !== generation.current) return;
      if (offset) focusNew.current = rows.length;
      setRows(old => offset ? [...old, ...result.listings] : result.listings); setNext(result.next); setState(result.listings.length ? '' : 'No public servers match your search.');
    } catch { if (current === generation.current) setState("Search isn't available right now."); }
  };
  useEffect(() => { const t = setTimeout(() => void search(), 300); return () => { clearTimeout(t); generation.current++; }; }, [query]);
  useEffect(() => { const key = (e: KeyboardEvent) => { if (e.key === 'Escape') h.go('home'); }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key); }, []);
  return <div className="hc-stack"><div><IconButton icon="back" label="Back" onClick={() => h.go('home')} /><h1>Discover servers</h1></div>
    <form onSubmit={e => { e.preventDefault(); void search(); }}><Field label="Search public servers" type="search" value={query} maxLength={100} autoFocus onChange={e => setQuery(e.target.value)} /></form>
    <p className="hc-onb__help">Listed by their owners. Joining still needs an invite or the owner's approval.</p>
    <p role="status">{state}</p>{state.includes("isn't") && <Button kind="text" onClick={() => void search()}>Retry</Button>}
    <ul ref={results} className="hc-tiles">{rows.map(row => <li className="hc-tile-row" key={row.origin}><span className="hc-tile-row__text"><strong>{row.name}</strong><span>{row.description}</span><small>{new URL(row.origin).host}</small></span><Button kind="text" onClick={() => { h.hosts.add(row.origin); h.go('home'); }}>Open</Button></li>)}</ul>
    {next !== null && <Button onClick={() => void search(next)}>Show more</Button>}
  </div>;
}
