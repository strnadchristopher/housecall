import { ApprovingLink, RequestingLink } from '../../core/requestLink';
import { useEffect, useRef, useState } from 'react';
import { ReceivingLink, ShowingLink } from '../../core/linkService';
import type { SecurityUI } from '../../core/securityContext';
import type { IdentityStatus, KeyChangeEvent } from '../../core/security';
import type { HostIdentitySync } from '../../core/identityCoordinator';
import type { Housecall } from './chat';
import { finishLinkHousekeeping, linkIsRetained, pendingLink, retainLink, chooseMemoryOnly, coordinator, exportLinkPins, installVault, securitySession, securityUpdates } from './securityRuntime';
import type { HostEntry, Hosts } from './hosts';
import { copy } from '../../ui/copy';
import { canScanLoginQr } from '../../transport/loginQr';

export function useSecurityUI(c: Housecall, host: HostEntry, hosts: Hosts): SecurityUI {
  const [, bump] = useState(0);
  const [status, setStatus] = useState<IdentityStatus>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [bootstrap, setBootstrap] = useState(false);
  const [flow, setFlow] = useState<SecurityUI['flow']>();
  const [receiver, setReceiver] = useState<ReceivingLink>();
  const [approver, setApprover] = useState<ApprovingLink>();
  const [requester, setRequester] = useState<RequestingLink>();
  const [showing, setShowing] = useState<ShowingLink>();
  const [scanImmediately, setScanImmediately] = useState(false);
  const [outcomes, setOutcomes] = useState<HostIdentitySync[]>([]);
  const [exposures, setExposures] = useState<{ created_at: number }[]>([]);
  const [deviceNotice, setDeviceNotice] = useState<string>();
  const origin = c.api.serverOrigin();
  const session = c.auth ? securitySession(c.api, origin, c.auth.user.id) : undefined;
  const ref = useRef(session); ref.current = session;
  const refresh = async () => {
    if (!ref.current) return;
    const s = ref.current;
    const next = await s.identity.bootstrap();
    if (ref.current !== s) return;
    setStatus(next);
    if (installVault().native) setExposures((await s.identity.remote.exposures()).exposures);
  };
  const act: SecurityUI['act'] = async work => {
    setBusy(true); setError('');
    try { await work(); setStatus(ref.current?.identity.snapshot()); return true; }
    catch (e) { setStatus(ref.current?.identity.snapshot()); setError(e instanceof Error ? e.message === 'this security key was replaced earlier' ? copy.keys.collideRefused(new URL(origin).host) : e.message === 'password required' || e.message === 'Password verification failed' ? copy.link.wrongPassword : e.message === 'INVALID_WORDS' ? copy.recovery.notAKey : e.message === 'AUTH_FAILED' ? copy.recovery.noMatch : e.message === 'IDENTITY_MISMATCH' ? copy.recovery.otherKey : e.message : copy.security.failed); return false; }
    finally { setBusy(false); securityUpdates.emit(); }
  };
  useEffect(() => securityUpdates.subscribe(() => { setStatus(ref.current?.identity.snapshot()); bump(n => n + 1); }), []);
  useEffect(() => {
    setStatus(undefined); setError('');
    if (!session) { receiver?.cancel(); void showing?.cancel(); setReceiver(undefined); setShowing(undefined); setFlow(undefined); setExposures([]); setDeviceNotice(undefined); return; }
    let alive = true;
    void session.identity.bootstrap().then(s => {
      if (!alive) return; setStatus(s);
      if (s.phase !== 'ready' && s.phase !== 'recovery-ahead' && (installVault().native || s.phase !== 'needs-identity')) { setBootstrap(true); setFlow('identity'); }
    }).catch(e => { if (alive) { setError(String(e.message)); setBootstrap(true); setFlow('identity'); } });
    return () => { alive = false; };
  }, [session]);
  useEffect(() => c.securityEvents.subscribe(event => {
    if (event.kind === 'keys.changed' && ref.current) {
      const s = ref.current, payload = event.payload as unknown as KeyChangeEvent;
      void Promise.all([s.identity.onKeysChanged(payload), s.dm.onKeysChanged(payload.user_id)]).then(([next]) => {
        if (ref.current === s) { setStatus(next); securityUpdates.emit(); }
      }).catch(e => setError(String(e.message)));
    }
    if (event.kind === 'device.added') {
      if (event.payload.session_id !== c.sessionId) setDeviceNotice(copy.link.newDevice(String(event.payload.device_name).slice(0, 80)));
      void c.loadDevices().catch(e => setError(String(e.message)));
      if (installVault().native && ref.current) void ref.current.identity.remote.exposures().then(v => setExposures(v.exposures)).catch(e => setError(String(e.message)));
    }
  }), [c.securityEvents, c.sessionId]);
  const adoptReceived = async (target: string, auth: import('../../data/types').Auth) => {
    const existing = hosts.hosts.find(h => h.id !== host.id && h.origin === target);
    if (existing) throw new Error(copy.security.hostAlreadyConnected);
    await c.acceptLinked(target, auth);
    if (installVault().native) hosts.connected(host.id, target);
  };
  const close = () => { void approver?.cancel(); void requester?.cancel(); setApprover(undefined); setRequester(undefined); if (!linkIsRetained(receiver)) receiver?.cancel(); void showing?.cancel(); setReceiver(undefined); setShowing(undefined); setFlow(undefined); setError(''); };
  const openReceive = async (scan = false) => {
    if (!canScanLoginQr(installVault().native)) return;
    let old: { origin: string; userId: string; sessionId: string } | undefined;
    if (c.auth) {
      const me = await c.api.get<{ session_id: string }>('/api/me');
      old = { origin, userId: c.auth.user.id, sessionId: me.session_id };
    }
    receiver?.cancel(); setReceiver(new ReceivingLink(installVault(), old, adoptReceived)); setScanImmediately(scan); setFlow('receive');
  };
  useEffect(() => {
    if (!receiver || !c.auth || receiver.snapshot().phase !== 'completed') return;
    const before = pendingLink(origin, c.auth.user.id);
    retainLink(origin, c.auth.user.id, receiver);
    if (pendingLink(origin, c.auth.user.id) !== before) securityUpdates.emit();
  }, [receiver, c.auth, busy, origin]);
  useEffect(() => () => { if (!linkIsRetained(receiver)) receiver?.cancel(); }, [receiver]);
  useEffect(() => () => { void showing?.cancel(); }, [showing]);
  useEffect(() => () => { void approver?.cancel(); void requester?.cancel(); }, [approver, requester, session]);
  return {
    approver, requester,
    openComputerLogin: () => { if (!session || c.capabilities.link_request !== true || !canScanLoginQr(installVault().native)) return; close(); setApprover(new ApprovingLink(session.identity.remote, installVault(), c.auth!.user.id, exportLinkPins)); setFlow('approve'); },
    openPhoneUnlock: () => { if (!session || installVault().native || !c.auth) return; close(); setRequester(new RequestingLink(origin, installVault(), c.api, async () => { throw new Error('Unlock cannot replace a session'); }, c.auth.user.id)); setFlow('request-unlock'); },
    bootstrap, status, service: session?.identity, origin, busy, error, flow, receiver, showing, scanImmediately, outcomes, exposures, deviceNotice,
    pendingLink: c.auth ? pendingLink(origin, c.auth.user.id) : undefined,
    retryLink: async kind => {
      if (!c.auth) return;
      const link = pendingLink(origin, c.auth.user.id); if (!link) return;
      if (kind === 'exposure') await link.retryExposureReport();
      if (kind === 'revocation') await link.retryOldSessionRevocation();
      if (kind === 'session') await link.retrySessionStorage();
      finishLinkHousekeeping(origin, c.auth.user.id); securityUpdates.emit();
    },
    refresh, act, close,
    synchronize: async password => {
      if (!installVault().native) { await refresh(); securityUpdates.emit(); return; }
      setOutcomes(await coordinator.synchronize(session && password ? new Map([[session.identity, password]]) : undefined));
      await refresh(); securityUpdates.emit();
    },
    openIdentity: () => { setBootstrap(false); setError(''); setFlow('identity'); void act(refresh); },
    openReceive,
    openShowing: () => { if (!session || !installVault().native) return; setShowing(new ShowingLink(session.identity.remote, installVault(), origin, exportLinkPins)); setFlow('show'); },
    acceptReceived: async (target, auth, completion) => {
      const existing = hosts.hosts.find(h => h.id !== host.id && h.origin === target);
      if (existing) throw new Error(copy.security.hostAlreadyConnected);
      if (c.auth?.token !== auth.token) await adoptReceived(target, auth);
      if (completion) retainLink(target, auth.user.id, completion);
      if (installVault().native) { hosts.connected(host.id, target); setOutcomes(await coordinator.synchronize()); }
      await refresh(); securityUpdates.emit();
    },
    memoryOnly: () => { chooseMemoryOnly(); },
    dismissDeviceNotice: () => setDeviceNotice(undefined),
  };
}
