import { SecurityIllustration } from "./SecurityIllustration";
import { useLayoutEffect, useEffect, useRef, useState } from 'react';
import { useIdentity } from '../../core/context';
import { useSecurity } from '../../core/securityContext';
import { copy } from '../copy';
import { Button, ErrorLine, Field, Icon, NavRow } from '../kit';
import { Sheet } from '../Sheet';

const C = copy;
export function SecurityPane() {
  const security = useSecurity(), identity = useIdentity();
  const [explanation, setExplanation] = useState(false);
  useEffect(() => { void security?.act(security.refresh); }, []);
  if (!security) return null;
  const completion = security.pendingLink?.snapshot();
  const ready = security.status?.phase === 'ready' || security.status?.phase === 'recovery-ahead';
  return <div className="hc-stack" data-testid="screen-security">
    <div className={`hc-status ${ready ? '' : 'is-off'}`}><Icon name={ready ? 'lock' : 'key'} /><span><strong>{ready ? identity.native ? C.security.on : C.e2e.label.browser : C.e2e.lockedTitle}</strong><small>{ready ? identity.native ? C.security.onBody : C.e2e.sheet.browser : identity.native ? C.e2e.lockedBody : C.e2e.lockedBrowser}</small></span></div>
    {security.status?.replacementDeviceName && <p role="alert">{C.keys.replacedOn(security.status.replacementDeviceName)}</p>}
    <ErrorLine text={security.error} />
    {completion?.phase === 'completed' && completion.exposureReportPending && <><p role="alert">{C.security.pendingExposure}</p><Button onClick={() => void security.act(() => security.retryLink('exposure'))}>{C.common.retry}</Button></>}
    {completion?.phase === 'completed' && completion.oldSessionRevocationPending && <><p role="alert">{C.security.pendingRevocation}</p><Button onClick={() => void security.act(() => security.retryLink('revocation'))}>{C.common.retry}</Button></>}
    {security.pendingLink?.nativeSessionPending() && <><p role="alert">{C.security.sessionNotStored}</p><Button onClick={() => void security.act(() => security.retryLink('session'))}>{C.security.sessionRetry}</Button></>}
    {security.status?.storage === 'memory-unavailable' && <p className="hc-note">{C.security.storageFailed}</p>}
    <ul className="hc-navgroup">
      <li><NavRow label={ready ? identity.native ? C.security.view : C.security.title : C.keys.getTitle} lead={<Icon name="key" />} onClick={security.openIdentity} /></li>
      <li><NavRow label={C.security.how} lead={<Icon name="info" />} onClick={() => setExplanation(true)} /></li>
    </ul>
    {security.status?.exposure === 'report-pending' && <><p role="alert">{C.security.pendingExposure}</p><Button onClick={() => void security.act(() => security.service!.reportExposure())}>{C.common.retry}</Button></>}
    {identity.native && security.exposures.map((e, i) => <p className="hc-status is-off" key={i}>{C.security.exposed(new URL(security.origin).host, new Date(e.created_at).toLocaleDateString())}</p>)}
    {security.outcomes.filter(o => o.outcome !== 'synced').map(o => <p key={o.origin} role="status">{new URL(o.origin).host}: {o.outcome === 'failed' ? C.security.syncFailed : C.security.syncRequired}</p>)}
    <SecurityExplanation open={explanation} onClose={() => setExplanation(false)} />
  </div>;
}

export function SecurityExplanation({ open, onClose }: { open: boolean; onClose(): void }) {
  const [slide, setSlide] = useState<number>();
  const slides = [C.security.slide1, C.security.slide2, C.security.slide3];
  return <Sheet open={open} onClose={onClose} title={C.security.how}>
    {slide !== undefined ? <><h3>{slides[slide].title}</h3><p>{slides[slide].lede}</p><p>{slides[slide].body}</p><Button kind="primary" onClick={() => slide === 2 ? setSlide(undefined) : setSlide(slide + 1)}>{slide === 2 ? C.common.done : C.security.slides.next}</Button></> : <div className="hc-explain">
      {slides.map(s => <div className="hc-point" key={s.title}><SecurityIllustration slide={slides.indexOf(s)} /><span><strong>{s.title}</strong><small>{s.lede} {s.body}</small></span></div>)}
      <table className="hc-hostsees"><caption>{C.security.tableCaption}</caption><tbody>{C.security.hostTable.map(([where, answer]) => <tr key={where}><th scope="row">{where}</th><td>{answer}</td></tr>)}</tbody></table>
      <p>{C.security.joinBody}</p><p className="hc-note">{C.security.status}</p><Button onClick={() => setSlide(0)}>{C.security.again}</Button>
    </div>}
  </Sheet>;
}

export function IdentityFlow() {
  const security = useSecurity()!, identity = useIdentity();
  const s = security.service;
  const status = security.status;
  const [step, setStep] = useState('home');
  const [slide, setSlide] = useState(0);
  const [words, setWords] = useState('');
  const [typed, setTyped] = useState('');
  const [password, setPassword] = useState('');
  const [positions, setPositions] = useState<readonly [number, number]>();
  const [answers, setAnswers] = useState<[string, string]>(['', '']);
  const [wordErrors, setWordErrors] = useState<readonly number[]>([]);
  const [copied, setCopied] = useState(false);
  const [resetAcknowledged, setResetAcknowledged] = useState(false);
  const [viewUntil, setViewUntil] = useState(0);
  const [now, setNow] = useState(Date.now());
  const open = security.flow === 'identity';
  const swipeStart = useRef<{ x: number; y: number } | undefined>(undefined);
  const secretTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const displayEpoch = useRef(0);
  const displayScope = useRef({ open, service: s, account: identity.me?.id, flow: security.flow });
  displayScope.current = { open, service: s, account: identity.me?.id, flow: security.flow };
  const clearSecrets = () => {
    displayEpoch.current++; clearTimeout(secretTimer.current); secretTimer.current = undefined;
    setStep('home'); setWords(''); setTyped(''); setPassword(''); setPositions(undefined);
    setAnswers(['', '']); setWordErrors([]); setCopied(false); setResetAcknowledged(false); setViewUntil(0);
  };
  useLayoutEffect(() => {
    clearSecrets();
    const inactive = () => { if (document.visibilityState !== 'visible') clearSecrets(); };
    window.addEventListener('blur', clearSecrets); document.addEventListener('visibilitychange', inactive);
    return () => {
      displayEpoch.current++; clearTimeout(secretTimer.current);
      window.removeEventListener('blur', clearSecrets); document.removeEventListener('visibilitychange', inactive);
    };
  }, [open, s, identity.me?.id, security.flow]);
  useEffect(() => {
    if (!words) return;
    secretTimer.current = setTimeout(clearSecrets, 60_000);
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearTimeout(secretTimer.current); clearInterval(timer); };
  }, [words]);
  useEffect(() => {
    if (step === 'reset' || step === 'remove') document.querySelector<HTMLButtonElement>('[data-testid="security-flow"] button[autofocus]')?.focus();
    if (step !== 'slides') return;
    const heading = document.querySelector<HTMLElement>('[data-testid="security-flow"] h1, [data-testid="security-flow"] h2');
    heading?.setAttribute('tabindex', '-1'); heading?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') { e.preventDefault(); setSlide(n => Math.max(0, n - 1)); }
      if (e.key === 'ArrowRight') { e.preventDefault(); setSlide(n => Math.min(2, n + 1)); }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [step, slide]);
  const run = (work: () => Promise<void>) => { void security.act(work); };
  const show = async (view = false, expectedEpoch = displayEpoch.current) => {
    if (!s || expectedEpoch !== displayEpoch.current) return;
    const epoch = ++displayEpoch.current, scope = displayScope.current;
    if (!scope.open || scope.service !== s) return;
    const value = await s.showWords(password || undefined);
    const latest = displayScope.current;
    if (epoch !== displayEpoch.current || !latest.open || latest.service !== scope.service || latest.account !== scope.account || latest.flow !== scope.flow) return;
    if (view) setPassword('');
    setWords(value); setTyped(''); setAnswers(['', '']); setWordErrors([]); setViewUntil(Date.now() + 60_000); setNow(Date.now()); setStep(view ? 'view' : 'words');
  };
  const importStart = () => {
    setTyped('');
    if (status?.phase === 'collision') setStep('install-warning');
    else setStep(s?.canEnterRecovery() ? 'import' : 'browser-warning');
  };
  const nativeOnly = !identity.native;
  const slides = [C.security.slide1, C.security.slide2, C.security.slide3];
  const count = typed.trim() ? typed.trim().split(/\s+/).length : 0;
  const title = step === 'slides' ? slides[slide].title : step === 'words' || step === 'view' ? C.recovery.title : step === 'check' ? C.recovery.checkTitle : step === 'import' ? C.recovery.enterTitle : step === 'browser-warning' ? C.link.new.browserTitle : step === 'reset' || step === 'reset-password' ? C.security.resetTitle : step === 'replace' ? C.security.replaceTitle : step === 'view-password' ? C.security.viewAsk : status?.phase === 'collision' ? C.keys.collide(new URL(security.origin).host) : status?.phase === 'ready' || status?.phase === 'recovery-ahead' ? C.security.title : status?.phase === 'pending-confirmation' ? C.recovery.title : status?.phase === 'needs-identity' && identity.native ? C.recovery.newThing : C.keys.getTitle;
  return <Sheet open={open} onClose={security.close} title={title} sensitive testId="security-flow" fullScreen={security.bootstrap} dismissible={!(security.bootstrap && ['slides', 'words', 'check', 'publish'].includes(step))}>
    <ErrorLine text={security.error === 'Current recovery key required' ? C.security.viewReplaced : security.error} />
    {identity.native && security.error === 'Secure storage unavailable' && <><p>{C.security.storageFailed}</p><Button onClick={security.memoryOnly}>{C.security.memoryChoice}</Button></>}
    {!status && <><p role="status">{security.error ? C.security.failed : C.common.loading}</p><Button onClick={() => run(security.refresh)}>{C.common.retry}</Button></>}
    {status && step === 'home' && <>
      {status.phase === 'backup-pending' && <><p role="alert">{C.security.syncFailed}</p><Button busy={security.busy} onClick={() => run(security.refresh)}>{C.common.retry}</Button></>}
      {status.replacementDeviceName && <p role="alert">{C.keys.replacedOn(status.replacementDeviceName)}</p>}
      {status.storage === 'memory-unavailable' && <><p>{C.security.storageFailed}</p></>}
      {status.exposure === 'report-pending' && <><p role="alert">{C.security.pendingExposure}</p><Button onClick={() => run(() => s!.reportExposure())}>{C.common.retry}</Button></>}
      {status.phase === 'needs-identity' && <>
        {nativeOnly ? <p>{C.link.useApp}</p> : status.requiredNotices?.includes('cross-host-linkability') ? <><p>{C.security.joinBody}</p><Button kind="primary" busy={security.busy} onClick={() => run(async () => { s!.acknowledgeNotice('cross-host-linkability'); await s!.publish(); await security.synchronize(); setStep('home'); })}>{C.keys.useExisting}</Button></> : <Button kind="primary" onClick={() => { setSlide(0); setStep('slides'); }}>{C.security.how}</Button>}
      </>}
      {status.phase === 'pending-confirmation' && !nativeOnly && <>{status.wordDisplayRequiresPassword && <Field label={C.link.password} type="password" value={password} onChange={e => setPassword(e.target.value)} />}<Button kind="primary" busy={security.busy} disabled={status.wordDisplayRequiresPassword && !password} onClick={() => run(() => show())}>{C.security.showKey}</Button></>}
      {['needs-import', 'collision', 'ready', 'recovery-ahead'].includes(status.phase) && <>
        {status.phase === 'ready' || status.phase === 'recovery-ahead' ? <>
          {nativeOnly ? <p>{C.e2e.sheet.browser}</p> : <><Button kind="primary" onClick={() => setStep('view-password')}>{C.security.view}</Button><Button onClick={() => setStep('replace')}>{C.security.replace}</Button></>}
          {status.phase === 'recovery-ahead' && <ErrorLine text={C.security.viewReplaced} />}
        </> : <><p>{nativeOnly ? C.e2e.lockedBrowser : C.e2e.lockedBody}</p><Button kind="primary" onClick={() => run(() => security.openReceive())}>{C.keys.getScan}</Button><Button onClick={importStart}>{C.keys.getWords}</Button></>}
        {identity.native && <Button kind="text" onClick={() => setStep('reset')}>{status.phase === 'needs-import' ? C.keys.getNeither : C.security.reset}</Button>}
        {status.phase === 'collision' && identity.native && <Button onClick={() => setStep('use-existing')}>{C.keys.collideThis}</Button>}
      </>}
      {identity.native && ['ready', 'recovery-ahead'].includes(status.phase) && <Button onClick={() => run(async () => { await s!.publish(); await security.synchronize(); })}>{C.keys.publish}</Button>}
      {identity.native && status.keyRev > 0 && <Button kind="danger" onClick={() => setStep('remove')}>{C.security.remove}</Button>}
    </>}
    {step === 'slides' && <section className="hc-slide" onTouchStart={e => { swipeStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }; }} onTouchEnd={e => {
      const start = swipeStart.current; swipeStart.current = undefined; if (!start) return;
      const dx = e.changedTouches[0].clientX - start.x, dy = e.changedTouches[0].clientY - start.y;
      if (Math.abs(dx) >= 40 && Math.abs(dx) > Math.abs(dy)) setSlide(n => Math.max(0, Math.min(2, n + (dx < 0 ? 1 : -1))));
    }}>
      <ol className="hc-slides__steps" role="img" aria-label={C.security.slideStep(slide + 1)}>{[0, 1, 2].map(n => <li className={n === slide ? "is-current" : n < slide ? "is-done" : undefined} key={n} />)}</ol><SecurityIllustration slide={slide} /><p className="hc-slide__lede">{slides[slide].lede}</p><p>{slides[slide].body}</p>
      <Button kind="primary" onClick={() => slide < 2 ? setSlide(slide + 1) : run(async () => { const epoch = displayEpoch.current; s!.acknowledgeNotice('security-introduction'); await s!.beginCreation(); await show(false, epoch); })}>{slide === 2 ? C.security.slides.last : C.security.slides.next}</Button>
      {slide > 0 && <Button kind="text" onClick={() => setSlide(slide - 1)}>{C.common.back}</Button>}
    </section>}
    {step === 'browser-warning' && <><p>{C.keys.browserWords(new URL(security.origin).host)}</p><Button kind="primary" onClick={() => { s!.acknowledgeNotice('browser-exposure'); if (s!.canEnterRecovery()) setStep('import'); }}>{C.link.new.continue}</Button></>}
    {step === 'install-warning' && <><p>{C.keys.installWarning}</p><Button kind="primary" onClick={() => { s!.acknowledgeNotice('replace-install-affects-other-hosts'); setStep(s!.canEnterRecovery() ? 'import' : 'browser-warning'); }}>{C.link.new.continue}</Button></>}
    {step === 'import' && s?.canEnterRecovery() && <form className="hc-stack" onSubmit={e => { e.preventDefault(); run(async () => { try { await s.importRecovery(typed); await security.synchronize(); } finally { if (s.snapshot().phase === 'ready') { setTyped(''); setStep('home'); } } }); }}>
      <p>{C.recovery.enterBody}</p><label className="hc-field"><span>{C.recovery.field} · {C.recovery.count(count)}</span><textarea rows={5} autoComplete="off" autoCapitalize="none" spellCheck={false} value={typed} onChange={e => setTyped(e.target.value)} /></label>
      {identity.native && <p className="hc-note">{C.recovery.local}</p>}
      <Button kind="primary" type="submit" disabled={count !== 24} busy={security.busy}>{C.recovery.unlock}</Button>
      <Button kind="text" onClick={() => { setTyped(''); run(() => security.openReceive()); }}>{C.recovery.otherDevice}</Button>
    </form>}
    {(step === 'words' || step === 'view') && words && <>
      <p>{C.recovery.body}</p><ol className="hc-words" aria-label={C.recovery.field}>{words.split(' ').map((word, i) => <li key={i}>{word}</li>)}</ol><p className="hc-note">{C.recovery.care}</p>
      <Button kind="primary" onClick={() => { if (step === 'view') { setWords(''); setStep('home'); } else { setWords(''); setPositions(s!.confirmationChallenge()); setStep('check'); } }}>{step === 'view' ? C.common.done : C.recovery.wrote}</Button>
      <Button kind="text" onClick={() => run(async () => { await navigator.clipboard.writeText(words); setCopied(true); setTimeout(() => setCopied(false), 2000); })}>{copied ? C.common.copied : C.recovery.copy}</Button>
      {step === 'view' && <p role="status">{C.link.hidesIn(Math.max(0, Math.ceil((viewUntil - now) / 1000)))}</p>}
    </>}
    {step === 'check' && positions && <form className="hc-stack" onSubmit={e => { e.preventDefault(); run(async () => {
      if (!await s!.confirmWords(answers)) { setWordErrors(s!.confirmationFailures()); return; }
      setStep('publish'); await s!.publish(password || undefined); await security.synchronize(password || undefined); setPassword(''); setAnswers(['', '']); setStep('home');
    }); }}>
      <p>{C.recovery.checkBody(...positions)}</p><div className="hc-recovery__pair">{positions.map((position, i) => <div key={position}><Field label={C.recovery.word(position)} autoComplete="off" autoCapitalize="none" spellCheck={false} value={answers[i]} onChange={e => setAnswers(i === 0 ? [e.target.value, answers[1]] : [answers[0], e.target.value])} />{wordErrors.includes(position) && <ErrorLine text={C.recovery.wrongWord(position)} />}</div>)}</div>
      <Button kind="primary" type="submit" busy={security.busy} disabled={!answers.every(Boolean)}>{C.recovery.finish}</Button><Button kind="text" onClick={() => run(() => show())}>{C.recovery.again}</Button>
    </form>}
    {step === 'publish' && <Button kind="primary" busy={security.busy} onClick={() => run(async () => { await s!.publish(password || undefined); await security.synchronize(password || undefined); setPassword(''); setStep('home'); })}>{C.keys.publish}</Button>}
    {step === 'reset' && <><ul className="hc-consequences">{[C.security.resetLose, C.security.resetPeers, C.security.resetWhen].map(t => <li key={t}><Icon name="warn" /><span>{t}</span></li>)}</ul><Button kind="text" autoFocus onClick={() => setStep('home')}>{C.common.cancel}</Button><Button className="hc-btn--danger-solid" onClick={() => { s!.acknowledgeNotice('reset-loses-history'); setResetAcknowledged(true); setStep('reset-password'); }}>{C.security.resetGo}</Button></>}
    {['reset-password', 'replace', 'view-password', 'use-existing'].includes(step) && !nativeOnly && <form className="hc-stack" onSubmit={e => { e.preventDefault(); run(async () => {
      const epoch = displayEpoch.current;
      if (step === 'view-password') { await show(true, epoch); }
      else if (step === 'replace') { s!.acknowledgeNotice('replace-does-not-revoke-leaked-words'); await s!.replaceRecovery(password); await show(false, epoch); }
      else if (step === 'reset-password' && resetAcknowledged) { await s!.beginReset(password); await show(false, epoch); }
      else if (step === 'use-existing') { s!.acknowledgeNotice('reset-loses-history'); await s!.publish(password); await security.synchronize(password); setPassword(''); setStep('home'); }
    }); }}>
      {step === 'replace' && <p>{C.security.replaceBody}</p>}{step === 'use-existing' && <p>{C.security.resetLose} {C.security.resetPeers} {C.security.joinBody}</p>}
      <Field label={C.link.password} type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} />
      <Button kind="primary" type="submit" disabled={!password} busy={security.busy}>{step === 'view-password' ? C.security.showKey : step === 'replace' ? C.security.replaceGo : C.security.resetGo}</Button>
    </form>}
    {step === 'remove' && <><p>{C.security.removeWarning}</p><Button kind="text" autoFocus onClick={() => setStep('home')}>{C.common.cancel}</Button><Button kind="danger" onClick={() => run(async () => { await s!.removeDeviceKey(); await security.refresh(); setStep('home'); })}>{C.security.remove}</Button></>}
    {step !== 'reset' && step !== 'words' && step !== 'check' && <Button kind="text" onClick={security.close}>{C.common.cancel}</Button>}
  </Sheet>;
}
