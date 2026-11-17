import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Account } from '../../../portal/src/account-client.mjs';
import { serverList } from '../../../portal/src/direct.mjs';
import type { Hosts } from '../adapters/legacy/hosts';
import { webSession } from '../transport/webSession';
import { parseServerInput } from '../data/serverInput';
import { hosted } from './config';

type View = 'login' | 'signup' | 'direct' | 'home' | 'discover';
function initial(): View { return location.hash === '#signup' ? 'signup' : location.hash === '#direct' ? 'direct' : 'login'; }
function useAccount(hosts: Hosts) {
  const [account] = useState(() => new Account());
  const [view, setView] = useState<View>(initial);
  const [saveAfterLogin, setSaveAfterLogin] = useState(true);
  const [overlay, setOverlay] = useState(false);
  const [version, update] = useState(0);
  const [epoch, reset] = useState(0);
  const [restoring, setRestoring] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const navigated = useRef(false);
  const channel = useRef<BroadcastChannel | null>(null);
  const alive = useRef(0);
  const go = (next: View) => { navigated.current = true; setError(''); setView(next); history.replaceState(null, '', location.pathname + (['login', 'signup', 'direct'].includes(next) ? '#' + next : '')); };
  const lock = <T,>(fn: () => Promise<T>) => navigator.locks ? navigator.locks.request('housecall-account', fn) : fn();
  const changed = () => { update(v => v + 1); };
  const act = async (fn: () => Promise<void>) => {
    if (working.current) return;
    working.current = true;
    const generation = alive.current;
    const binding = account.binding;
    setBusy(true); setError('');
    try { await lock(fn); if (generation === alive.current) changed(); }
    catch (e) {
      if (generation !== alive.current) return;
      const failure = e as Error & { status?: number; code?: string };
      if (failure.status === 401 || failure.code === 'account_changed') {
        await account.forgetDevice(binding).catch(() => account.clear());
        changed();
      }
      setError(failure.message);
    } finally { working.current = false; setBusy(false); }
  };
  useEffect(() => {
    if (!hosted) { setRestoring(false); return; }
    const bus = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('housecall-account'); channel.current = bus;
    if (bus) bus.onmessage = async event => {
      if (!['changed', 'logout'].includes(event.data)) return;
      alive.current++; account.clear();
      if (event.data === 'changed') {
        // A new central binding must never revoke independent community sessions.
        changed();
        await lock(async () => {
          try { await account.restore(); } catch { account.clear(); }
          changed();
        });
        return;
      }
      const pending: Promise<void>[] = []; window.dispatchEvent(new CustomEvent('housecall-clear-sessions', { detail: pending }));
      await Promise.allSettled(pending);
      hosts.reset(); reset(v => v + 1); changed(); go('login');
    };
    const validate = () => {
      if (document.visibilityState !== 'visible' || !account.binding) return;
      void act(async () => { await account.load(); });
    };
    document.addEventListener('visibilitychange', validate);
    window.addEventListener('focus', validate);
    const timer = setInterval(validate, 60000);
    void lock(async () => { try { if (await account.restore()) { if (!navigated.current && initial() !== 'direct') go('home'); changed(); } } catch { /* guest remains independent of the account service */ } }).finally(() => setRestoring(false));
    return () => { bus?.close(); clearInterval(timer); window.removeEventListener('focus', validate); document.removeEventListener('visibilitychange', validate); };
  }, []); // One account runtime per application.
  const authenticate = (name: string, password: string, signup: boolean) => act(async () => {
    await account.forgetDevice();
    await account.authenticate(name, password, signup);
    // Browsers without IndexedDB remain usable for this tab.
    await account.remember().catch(() => {});
    channel.current?.postMessage('changed'); setOverlay(false); go('home');
  });
  const saveOrigin = (input: string) => act(async () => {
    const origin = parseServerInput(input).origin + '/';
    // Refresh before editing. CAS still detects a competing writer; never retry over it.
    const list = await account.load();
    if (!list.servers.some(saved => new URL(saved).origin === new URL(origin).origin)) await account.save(serverList({ format: 1, servers: [...list.servers, origin] }));
  });
  const unlink = (origin: string) => act(async () => {
    const list = await account.load();
    await account.save({ format: 1, servers: list.servers.filter(s => s !== origin) });
  });
  const finish = async (remove: boolean) => {
    // A stale delete must fail without logging other tabs out of the new account.
    // Explicit logout still clears local sessions even if the service is offline.
    let clearSessions = !remove;
    try {
      if (remove) await account.delete(); else await account.logout();
      clearSessions = true;
    } finally {
      if (clearSessions) {
        const pending: Promise<void>[] = []; window.dispatchEvent(new CustomEvent('housecall-clear-sessions', { detail: pending }));
        await Promise.allSettled(pending);
        await account.forgetDevice().catch(() => {});
        await webSession.clear();
        channel.current?.postMessage('logout'); hosts.reset(); reset(v => v + 1); go('login');
      }
    }
  };
  return { account, saveAfterLogin, setSaveAfterLogin, overlay, setOverlay, view, go, version, epoch, restoring, busy, error, act, authenticate, saveOrigin, unlink,
    logout: () => act(() => finish(false)), deleteAccount: () => act(() => finish(true)),
    importList: (value: unknown) => act(async () => { const incoming = serverList(value); const old = await account.load(); await account.save(serverList({ format: 1, servers: [...new Set([...old.servers, ...incoming.servers])] })); }),
    hosts };
}
type Runtime = ReturnType<typeof useAccount>;
const Context = createContext<Runtime | null>(null);
export function HostedProvider({ hosts, children }: { hosts: Hosts; children: ReactNode }) {
  return hosted ? <AccountRuntime hosts={hosts}>{children}</AccountRuntime> : <>{children}</>;
}
function AccountRuntime({ hosts, children }: { hosts: Hosts; children: ReactNode }) {
  const value = useAccount(hosts);
  return <Context.Provider value={hosted ? value : null}>{children}</Context.Provider>;
}
export const useHosted = () => useContext(Context);
