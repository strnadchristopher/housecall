import { useEffect, useRef, useState } from 'react';
import qrcode from 'qrcode-generator';
import jsQR from 'jsqr';
import { useIdentity } from '../../core/context';
import { useSecurity } from '../../core/securityContext';
import type { ReceivingState, ShowingState } from '../../core/linkService';
import type { Auth } from '../../data/types';
import { copy } from '../copy';
import { Button, ErrorLine } from '../kit';
import { Field } from '../kit';
import { Sheet } from '../Sheet';
import { SnapCamera } from '../snap/SnapCamera';
import { deviceName } from '../../hooks/useHousecall';
import { useSensitiveSurface } from './sensitiveSurface';

function Qr({ text }: { text?: string }) {
  const code = qrcode(0, 'M'); code.addData(text ?? 'Housecall: hidden decoy'); code.make();
  const count = code.getModuleCount();
  let path = '';
  for (let y = 0; y < count; y++) for (let x = 0; x < count; x++) if (code.isDark(y, x)) path += `M${x + 4} ${y + 4}h1v1h-1z`;
  return <svg className="hc-qr__svg" viewBox={`0 0 ${count + 8} ${count + 8}`} aria-hidden="true"><path d={path} /></svg>;
}
export function ShowingFlow() {
  const security = useSecurity()!, identity = useIdentity(), controller = security.showing;
  const [state, setState] = useState<ShowingState>({ phase: 'idle' });
  const [qr, setQr] = useState<string>();
  const [typed, setTyped] = useState('');
  const [password, setPassword] = useState('');
  const [needsPassword, setNeedsPassword] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [localError, setLocalError] = useState('');
  const [approvedName, setApprovedName] = useState('');
  const [ownerBusy, setOwnerBusy] = useState(false);
  const active = security.flow === 'show' && !!controller && identity.native;
  const surface = useSensitiveSurface(active, () => { setQr(undefined); if (controller?.snapshot().phase === 'showing') void controller.cancel().then(() => setState(controller.snapshot())); });
  const refresh = () => { if (controller) setState(controller.snapshot()); setNow(Date.now()); };
  useEffect(() => {
    if (!active) return;
    const hide = () => { setQr(undefined); if (controller?.snapshot().phase === 'showing') void controller.cancel().then(refresh); };
    const visibility = () => { if (document.visibilityState !== 'visible') hide(); };
    window.addEventListener('blur', hide); document.addEventListener('visibilitychange', visibility);
    const clock = setInterval(() => {
      refresh();
      const s = controller!.snapshot();
      if (s.phase === 'showing' && Date.now() >= s.visibleUntil) { setQr(undefined); void controller!.cancel().then(refresh); }
    }, 250);
    return () => { clearInterval(clock); window.removeEventListener('blur', hide); document.removeEventListener('visibilitychange', visibility); setQr(undefined); setTyped(''); setPassword(''); };
  }, [active, controller]);
  useEffect(() => {
    if (!active || state.phase !== 'showing') return;
    let stopped = false;
    const timer = setInterval(() => {
      void controller!.poll().then(s => { if (!stopped) { setState(s); if (s.phase !== 'showing') setQr(undefined); } }).catch(() => { if (!stopped) { setLocalError(copy.link.startFailed); refresh(); } });
    }, 2000);
    return () => { stopped = true; clearInterval(timer); };
  }, [active, controller, state.phase]);
  useEffect(() => {
    if (!qr || state.phase !== 'showing') return;
    const timer = setTimeout(() => { setQr(undefined); if (controller?.snapshot().phase === 'showing') void controller.cancel().then(refresh); }, Math.max(0, state.visibleUntil - Date.now()));
    return () => clearTimeout(timer);
  }, [qr, state.phase, state.phase === 'showing' ? state.visibleUntil : 0]);
  const start = () => void security.act(async () => {
    if (!surface.ready) throw new Error(copy.security.surfaceUnavailable);
    setLocalError(''); setTyped(''); setPassword(''); setNeedsPassword(false);
    await controller!.start(); setQr(controller!.revealQr()); refresh();
  });
  const verify = async (pw?: string) => {
    if (!controller || ownerBusy) return;
    setOwnerBusy(true); setLocalError('');
    try { if (await controller.verifyMatched(pw)) setApprovedName(name); refresh(); }
    catch (e) {
      if (e instanceof Error && e.message === 'Password required') setNeedsPassword(true);
      else setLocalError(needsPassword ? copy.link.wrongPassword : copy.security.verificationFailed);
      refresh();
    } finally { setOwnerBusy(false); setPassword(''); }
  };
  const name = 'deviceName' in state ? state.deviceName : '';
  return <Sheet open={security.flow === 'show'} onClose={security.close} title={copy.link.title} sensitive testId="screen-qr">
    {!identity.native ? <p>{copy.link.useApp}</p> : <div className="hc-qrlogin">
      <div className="hc-qrlogin__card">
        <ErrorLine text={security.error || localError || surface.error} />
        {['idle', 'cancelled', 'starting', 'showing'].includes(state.phase) && <>
          <div className={`hc-qr ${qr && surface.ready ? '' : 'is-hidden'}`}><Qr text={qr && surface.ready ? qr : undefined} />{!qr && <div className="hc-qr__veil"><Button kind="primary" busy={security.busy} disabled={!surface.ready} onClick={start}>{copy.link.show}</Button></div>}</div>
          {qr && state.phase === 'showing' && <div className="hc-qrlogin__timer"><span>{copy.link.hidesIn(Math.max(0, Math.ceil((state.visibleUntil - now) / 1000)))}</span><Button kind="text" onClick={() => { setQr(undefined); void controller!.cancel().then(refresh); }}>{copy.link.hide}</Button></div>}
        </>}
        {state.phase === 'confirmation' && <><strong>{copy.link.wants(name)}</strong><label className="hc-qrlogin__label" htmlFor="hc-link-code">{copy.link.typeNumber(name)}</label><span className="hc-codefield">
          <input id="hc-link-code" inputMode="numeric" pattern="[0-9]*" maxLength={2} autoComplete="off" autoFocus value={typed} onPaste={e => {
            e.preventDefault(); const raw = e.clipboardData.getData('text'); setTyped(raw);
            void security.act(async () => { const match = await controller!.matchNumber(raw); setTyped(''); setQr(undefined); refresh(); if (match) void verify(); });
          }} onChange={e => {
            const raw = e.target.value; setTyped(raw);
            if (raw.length >= 2) void security.act(async () => { const match = await controller!.matchNumber(raw); setTyped(''); setQr(undefined); refresh(); if (match) void verify(); });
          }} />
          {[0, 1].map(i => <span className={`hc-plate ${typed.length === i ? 'is-next' : ''}`} aria-hidden="true" key={i}>{/^[0-9]$/.test(typed[i] ?? '') ? typed[i] : ''}</span>)}
        </span></>}
        {state.phase === 'verifying' && <><strong>{copy.link.wants(name)}</strong>{needsPassword ? <form className="hc-qrlogin__verify" onSubmit={e => { e.preventDefault(); void verify(password); }}><Field label={copy.link.password} type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} /><Button kind="primary" type="submit" busy={ownerBusy} disabled={!password}>{copy.link.verifyGo(name)}</Button></form> : <Button kind="primary" busy={ownerBusy} onClick={() => void verify()}>{copy.link.unlockGo(name)}</Button>}</>}
        {(state.phase === 'confirmation' || state.phase === 'verifying') && <><p>{copy.link.left(Math.max(0, Math.ceil((state.expiresAt - now) / 1000)))}</p><Button kind="text" onClick={() => { void controller!.deny().then(refresh); }}>{copy.link.deny}</Button></>}
        {state.phase === 'approved' && <><strong>{copy.link.approved(approvedName)}</strong><p>{copy.link.approvedBody}</p><Button kind="primary" onClick={security.close}>{copy.common.done}</Button></>}
        {['denied', 'expired', 'burnt', 'failed'].includes(state.phase) && <><strong>{state.phase === 'expired' ? copy.link.expired : state.phase === 'denied' && 'reason' in state && state.reason === 'number-mismatch' ? copy.link.mismatchTitle : copy.link.cancelledTitle}</strong><p>{'reason' in state && state.reason === 'number-mismatch' ? copy.link.mismatchBody : 'reason' in state && state.reason === 'tag-failed' ? copy.link.tagFailed : state.phase === 'burnt' ? copy.link.burnt : ''}</p><Button kind="primary" onClick={start}>{copy.link.newCode}</Button></>}
      </div>
      <p className="hc-note">{state.phase === 'confirmation' || state.phase === 'verifying' ? copy.link.keyNote : copy.link.care}</p>
      {/iphone|ipad/i.test(navigator.userAgent) && <p className="hc-note">{copy.security.captureLimit}</p>}
    </div>}
  </Sheet>;
}

export function ReceivingFlow() {
  const security = useSecurity()!, identity = useIdentity(), r = security.receiver;
  const [state, setState] = useState<ReceivingState>(() => r?.snapshot() ?? { phase: 'idle' });
  const [scanning, setScanning] = useState(security.scanImmediately);
  const [wrong, setWrong] = useState('');
  const [receiveError, setReceiveError] = useState('');
  const [found, setFound] = useState(false);
  const foundTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [browserWarning, setBrowserWarning] = useState(false);
  const [completedAuth, setCompletedAuth] = useState<Auth>();
  const [origin, setOrigin] = useState('');
  const locked = useRef(false);
  const alive = useRef(true);
  const wrongTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => { alive.current = true; return () => { alive.current = false; clearTimeout(wrongTimer.current); clearTimeout(foundTimer.current); }; }, []);
  const refresh = () => { if (alive.current && r) setState(r.snapshot()); };
  useEffect(() => { if (state.phase === 'host-confirmation') setOrigin(state.origin); }, [state]);
  useEffect(() => {
    if (state.phase !== 'waiting' || !r) return;
    let stopped = false;
    const timer = setInterval(() => { void security.act(async () => { let auth: Auth | undefined;
      try { auth = await r.poll(); } catch (error) {
        if (error instanceof Error && (error.message === 'IDENTITY_MISMATCH' || /account.*match|account key changed/i.test(error.message))) setReceiveError(copy.link.new.accountMismatch);
        else if (error instanceof Error && error.name === 'CryptoError') setReceiveError(copy.link.new.keyUnreadable);
        refresh(); throw error;
      }
      if (stopped) return; if (auth) setCompletedAuth(auth); refresh(); }); }, 2000);
    return () => { stopped = true; clearInterval(timer); };
  }, [state.phase, r]);
  const run = (work: () => Promise<void>) => void security.act(async () => {
    setReceiveError('');
    try { await work(); }
    catch (error) {
      if (error instanceof Error && (error.message === 'IDENTITY_MISMATCH' || /account.*match|account key changed/i.test(error.message))) setReceiveError(copy.link.new.accountMismatch);
      else if (error instanceof Error && error.name === 'CryptoError') setReceiveError(copy.link.new.keyUnreadable);
      throw error;
    } finally { refresh(); }
  });
  const cancel = () => { security.close(); };
  if (scanning) return <SnapCamera mode="scan" found={found} onPassword={cancel} onClose={() => { clearTimeout(foundTimer.current); setFound(false); locked.current = false; r?.cancel(); refresh(); setScanning(false); }} wrong={wrong} scanAgain={security.scanImmediately} onFrame={video => {
    if (locked.current || !r) return;
    const canvas = document.createElement('canvas'), size = Math.min(video.videoWidth, video.videoHeight);
    canvas.width = canvas.height = Math.min(size, 800);
    const context = canvas.getContext('2d', { willReadFrequently: true }); if (!context) return;
    context.drawImage(video, (video.videoWidth - size) / 2, (video.videoHeight - size) / 2, size, size, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    const found = jsQR(pixels.data, pixels.width, pixels.height); pixels.data.fill(0); canvas.width = canvas.height = 0;
    if (!found) return;
    try { r.scan(found.data, identity.native ? 'native-camera' : 'browser'); locked.current = true; setFound(true); foundTimer.current = setTimeout(() => { setScanning(false); setFound(false); refresh(); }, 320); }
    catch { setWrong(copy.camera.scanWrong); clearTimeout(wrongTimer.current); wrongTimer.current = setTimeout(() => setWrong(''), 3000); }
  }} />;
  const phase = state.phase;
  const title = phase === 'host-confirmation' ? `${copy.link.newOn(new URL(state.origin).host)}` : browserWarning ? copy.link.new.browserTitle : phase === 'account-confirmation' || phase === 'waiting' ? copy.link.newAs(state.username) : phase === 'completed' ? copy.link.new.in : phase === 'expired' ? copy.link.new.expiredTitle : phase === 'denied' ? copy.link.new.deniedTitle : phase === 'burnt' ? copy.link.new.burntTitle : copy.link.title;
  return <Sheet open onClose={cancel} title={title} testId="screen-link-receive" fullScreen>
    <ErrorLine text={receiveError || security.error} />
    {phase === 'idle' || phase === 'cancelled' ? <><ol className="hc-qrsteps">{copy.link.new.steps.map((t, i) => <li key={t}><span className="hc-qrsteps__n">{i + 1}</span><span>{t}</span></li>)}</ol><Button kind="primary" onClick={() => { locked.current = false; setFound(false); setScanning(true); }}>{copy.link.new.scan}</Button><Button kind="text" onClick={cancel}>{copy.link.new.password}</Button></> : null}
    {phase === 'host-confirmation' && (browserWarning ? <><p>{copy.link.new.browserBody(new URL(state.origin).host)}</p><Button kind="primary" busy={security.busy} onClick={() => run(async () => { await r!.confirmHost(deviceName(), true); setBrowserWarning(false); })}>{copy.link.new.continue}</Button></> : <><p>{copy.link.new.chose}</p><Button kind="primary" onClick={() => identity.native ? run(() => r!.confirmHost(deviceName())) : setBrowserWarning(true)}>{copy.link.new.continue}</Button></>)}
    {(phase === 'account-confirmation' || phase === 'waiting') && <div className="hc-qrnew"><p>{copy.link.new.typeThere}</p><div className="hc-plates" aria-label={state.code}>{state.code.split('').map((d, i) => <span className="hc-plate" key={i}>{d}</span>)}</div>{phase === 'account-confirmation' ? <Button kind="primary" onClick={() => { r!.confirmAccount(); refresh(); }}>{copy.link.new.continue}</Button> : <p className="hc-qrnew__wait" role="status">{copy.link.new.waiting}</p>}</div>}
    {phase === 'claiming' && <p role="status">{copy.common.loading}</p>}
    {phase === 'collision' && <><p>{copy.keys.installWarning}</p><Button kind="primary" onClick={() => run(async () => { setCompletedAuth(await r!.acceptInstallReplacement(true)); })}>{copy.link.new.continue}</Button></>}
    {phase === 'completed' && <>
      {state.sessionSecure === false && identity.native && <><p role="alert">{copy.security.sessionNotStored}</p><Button onClick={() => run(() => r!.retrySessionStorage())}>{copy.security.sessionRetry}</Button></>}
      {state.exposureReportPending && <><p role="alert">{copy.security.pendingExposure}</p><Button onClick={() => run(() => r!.retryExposureReport())}>{copy.common.retry}</Button></>}
      {state.oldSessionRevocationPending && <><p role="alert">{copy.security.pendingRevocation}</p><Button onClick={() => run(() => r!.retryOldSessionRevocation())}>{copy.common.retry}</Button></>}
      {state.recoveryAhead && <p>{copy.security.viewReplaced}</p>}
      <Button kind="primary" onClick={() => run(async () => { if (completedAuth) { await security.acceptReceived(origin, completedAuth, r); security.close(); } })}>{copy.common.done}</Button>
    </>}
    {['failed', 'expired', 'denied', 'burnt'].includes(phase) && <><p>{phase === 'denied' ? copy.link.new.deniedBody : phase === 'burnt' ? copy.link.new.burntBody : copy.link.new.failedBody}</p><Button kind="primary" onClick={() => { r?.cancel(); refresh(); locked.current = false; setFound(false); setScanning(true); }}>{copy.link.new.again}</Button><Button kind="text" onClick={cancel}>{copy.link.new.password}</Button></>}
    {phase !== 'idle' && phase !== 'completed' && <Button kind="text" onClick={cancel}>{copy.common.cancel}</Button>}
  </Sheet>;
}
