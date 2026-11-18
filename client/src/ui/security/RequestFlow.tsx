import { useEffect, useState } from 'react';
import jsQR from 'jsqr';
import { RequestingLink, supportsRequest, requestHousekeeping } from '../../core/requestLink';
import { useIdentity } from '../../core/context';
import { useSecurity } from '../../core/securityContext';
import { deviceName } from '../../hooks/useHousecall';
import { canScanLoginQr } from '../../transport/loginQr';
import { Button, ErrorLine, Field } from '../kit';
import { Sheet } from '../Sheet';
import { SnapCamera } from '../snap/SnapCamera';
import { Qr } from './LinkFlow';
import { useSensitiveSurface } from './sensitiveSurface';
import { copy } from '../copy';

export function useRequestCapability(origin?: string) {
  const [enabled, setEnabled] = useState<string>();
  useEffect(() => {
    setEnabled(undefined); if (!origin) return; let alive = true;
    const timer = setTimeout(() => { void supportsRequest(origin).then(ok => { if (alive && ok) setEnabled(origin); }, () => {}); }, 300);
    return () => { alive = false; clearTimeout(timer); };
  }, [origin]);
  return !!origin && enabled === origin;
}
export function BrowserPhoneLogin({ origin }: { origin?: string }) {
  const identity = useIdentity();
  const enabled = useRequestCapability(!identity.native && !identity.signedIn ? origin : undefined);
  const [controller, setController] = useState<RequestingLink>();
  const [error,setError] = useState('');
  useEffect(() => { setController(undefined); return () => { void controller?.cancel(); }; }, [origin]);
  if (!enabled || !identity.newPhoneLogin) return null;
  return <><Button kind="text" onClick={() => { try { setError('');setController(identity.newPhoneLogin!(origin!)); } catch(e) {setError(String(e));} }}>Log in with your phone</Button><ErrorLine text={error} />{controller && <Sheet open onClose={() => setController(undefined)} title={`Log in to ${new URL(origin!).host}`} testId="screen-phone-login"><RequestPanel controller={controller} onClose={() => setController(undefined)} /></Sheet>}</>;
}
export function RequestPanel({ controller, onClose, unlock = false }: {controller:RequestingLink;onClose:()=>void;unlock?:boolean}) {
  const [state,setState] = useState(controller.snapshot());
  const [typed,setTyped] = useState(''); const [error,setError] = useState(''); const [busy,setBusy] = useState(false);
  const [warning,setWarning] = useState(unlock); const [now,setNow]=useState(Date.now());
  const refresh = () => setState(controller.snapshot());
  const run = async (work:()=>Promise<unknown>) => {setBusy(true);setError('');try {await work();} catch(e){setError(e instanceof Error?e.message:'Could not link this browser.');} finally {refresh();setBusy(false);} };

  useEffect(() => {
    const hide=()=>{if(controller.snapshot().phase==='showing') void controller.cancel().then(refresh);};
    const visibility=()=>{if(document.visibilityState!=='visible') hide();};
    window.addEventListener('blur',hide);document.addEventListener('visibilitychange',visibility);
    const timer=setInterval(()=>{setNow(Date.now()); const s=controller.snapshot(); if(s.phase==='showing' && Date.now()>=s.visibleUntil!) hide();},250);
    return ()=>{clearInterval(timer);window.removeEventListener('blur',hide);document.removeEventListener('visibilitychange',visibility);void controller.cancel();};
  },[controller]);
  useEffect(()=>{if(!['showing','waiting','number'].includes(state.phase))return;const timer=setInterval(()=>{void run(()=>controller.poll());},2000);return()=>clearInterval(timer);},[controller,state.phase]);
  const warningText=`Unlocking encrypted DMs exports your security key to this browser. Code from ${location.origin} can read it. Only continue on a computer you trust. Community server: ${controller.origin}.`;
  if(warning) return <><p>{warningText}</p><Button kind="primary" onClick={()=>setWarning(false)}>Continue</Button><Button kind="text" onClick={onClose}>Cancel</Button></>;
  const qr=controller.qr();
  return <div className="hc-qrlogin"><ErrorLine text={error} />
    {['idle','cancelled','showing','failed','expired','denied','burnt'].includes(state.phase) && <>
      {['failed','expired','denied','burnt'].includes(state.phase) && <p role="status">{state.reason==='number_mismatch'?"The numbers didn't match, so this was cancelled.":state.phase==='expired'?'This code expired.':state.phase==='denied'?'Your phone said no.':'This code was cancelled.'}</p>}
      <div className={`hc-qr ${qr?'':'is-hidden'}`}><Qr text={qr}/>{!qr && <div className="hc-qr__veil"><Button kind="primary" busy={busy} onClick={()=>void run(()=>controller.start(deviceName()))}>{state.phase==='idle' || state.phase==='cancelled'?'Show code':'New code'}</Button></div>}</div>
      {qr && <div className="hc-qrlogin__timer"><span>{copy.link.hidesIn(Math.max(0,Math.ceil((state.visibleUntil!-now)/1000)))}</span><Button kind="text" onClick={()=>void run(()=>controller.cancel())}>Hide</Button></div>}
      <p className="hc-note">In the {copy.app.name} app on your phone, open Settings, then Log in on a computer, and scan this. Update the app if it doesn't recognise this code.</p><p className="hc-note">Never scan a code someone sent you or showed you.</p>
    </>}
    {['waiting','number','account-confirmation'].includes(state.phase) && <strong>{state.username} on {state.phone}</strong>}
    {state.phase==='waiting' && <p role="status">Approve on your phone</p>}
    {state.phase==='number' && <><label className="hc-qrlogin__label" htmlFor="hc-request-number">Type the number shown on your phone</label><span className="hc-codefield"><input id="hc-request-number" autoFocus inputMode="numeric" pattern="[0-9]{2}" maxLength={2} autoComplete="off" value={typed} onChange={e=>{const n=e.target.value;setTyped(n);if(/^[0-9]{2}$/.test(n)){controller.submitNumber(n);setTyped('');refresh();}}}/>{[0,1].map(i=><span key={i} className="hc-plate" aria-hidden="true">{typed[i]}</span>)}</span></>}
    {state.phase==='account-confirmation' && <><p>{unlock?`Unlock DMs for ${state.username}?`:`Log in as ${state.username}?`}</p><Button kind="primary" busy={busy} onClick={()=>void run(()=>controller.confirmAccount())}>Continue</Button><Button kind="text" onClick={()=>void run(()=>controller.cancel())}>Not me</Button></>}
    {state.phase==='completed' && <><p role="status">{unlock?'DMs unlocked in this browser.':`Logged in as ${state.username}`}</p>{state.exposureReportPending && <><p role="alert">{copy.security.pendingExposure}</p><Button kind="primary" onClick={()=>void run(()=>controller.retryExposureReport())}>Retry</Button></>}<Button kind="primary" onClick={onClose}>Done</Button></>}
    {!unlock && <p className="hc-note">{warningText} Your phone leaves DM export off unless you choose it.</p>}
    {state.phase!=='completed' && <Button kind="text" onClick={onClose}>Back</Button>}
  </div>;
}
export function PhoneUnlockFlow() {
  const security=useSecurity()!;
  return security.requester?<Sheet open title="Unlock with your phone" onClose={security.close}><RequestPanel controller={security.requester} onClose={()=>{void security.refresh();security.close();}} unlock/></Sheet>:null;
}
export function ComputerApprovalFlow() {
  const security=useSecurity()!, identity=useIdentity();
  return canScanLoginQr(identity.native) && security.approver?<ApprovalPanel/>:null;
}
function ApprovalPanel() {
  const security=useSecurity()!,controller=security.approver!;
  const [state,setState]=useState(controller.snapshot()); const [scanning,setScanning]=useState(true); const [error,setError]=useState(''); const [busy,setBusy]=useState(false);const [exportKeys,setExportKeys]=useState(false);const [password,setPassword]=useState('');const [needsPassword,setNeedsPassword]=useState(false);
  const [locked,setLocked]=useState(false);
  const run=async(work:()=>Promise<unknown>)=>{setBusy(true);setError('');try{await work();}catch(e){if(e instanceof Error && e.message==='Password required')setNeedsPassword(true);else setError(e instanceof Error?e.message:'Could not approve.');}finally{setPassword('');setState(controller.snapshot());setBusy(false);}};
  const surface=useSensitiveSurface(!scanning,()=>{void controller.cancel().then(()=>setState(controller.snapshot()));});
  useEffect(()=>{
    const hide=()=>{if(document.visibilityState!=='visible')void controller.cancel().then(()=>setState(controller.snapshot()));};
    document.addEventListener('visibilitychange',hide);
    return()=>{document.removeEventListener('visibilitychange',hide);void controller.cancel();};
  },[controller]);
  useEffect(()=>{if(!['confirmation','approved'].includes(state.phase))return;const timer=setInterval(()=>void run(()=>controller.poll()),2000);return()=>clearInterval(timer);},[controller,state.phase]);
  if(scanning)return <SnapCamera mode="scan" wrong={error} onClose={security.close} onPassword={security.close} onFrame={video=>{
    if(locked)return;const canvas=document.createElement('canvas');canvas.width=Math.min(video.videoWidth,800);canvas.height=Math.round(canvas.width*video.videoHeight/video.videoWidth);const ctx=canvas.getContext('2d',{willReadFrequently:true});if(!ctx || !canvas.height)return;ctx.drawImage(video,0,0,canvas.width,canvas.height);const pixels=ctx.getImageData(0,0,canvas.width,canvas.height);const qr=jsQR(pixels.data,pixels.width,pixels.height);pixels.data.fill(0);canvas.width=canvas.height=0;
    if(qr){setLocked(true);void run(async()=>{await controller.scan(qr.data);setScanning(false);}).finally(()=>setLocked(false));}
  }}/>;
  return <Sheet open onClose={security.close} title={state.phase==='confirmation'?`Log in on ${state.deviceName}?`:'Log in on a computer'} sensitive><ErrorLine text={error || surface.error}/>
    {state.phase==='confirmation' && <><p>Server: {new URL(security.origin).host}</p><p>Account: {state.username}</p>{state.kind==='sign-in' && <label className="hc-check"><input type="checkbox" checked={exportKeys} onChange={e=>setExportKeys(e.target.checked)}/>Also unlock encrypted DMs there</label>}<p className="hc-note">Exporting your security key lets the browser app at {state.browserOrigin} read encrypted DMs. Server: {security.origin}. Only approve on a computer you trust.</p>{needsPassword && <Field label="Password" type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)}/>}<Button kind="primary" disabled={!surface.ready} busy={busy} onClick={()=>void run(()=>controller.approve(exportKeys,needsPassword?password:undefined))}>Approve</Button><Button kind="text" onClick={()=>void run(()=>controller.cancel())}>Deny</Button></>}
    {state.phase==='approved' && <><p>Type this number on your computer</p>{surface.ready && <div className="hc-plates" aria-label={state.code}>{state.code?.split('').map((n,i)=><span className="hc-plate" key={i}>{n}</span>)}</div>}<p role="status">Waiting for your computer</p></>}
    {['completed','denied','burnt','expired','cancelled','failed'].includes(state.phase) && <><p role="status">{state.phase==='completed'?'Your computer collected the approval.':'This request ended.'}</p><Button kind="primary" onClick={security.close}>Done</Button></>}
  </Sheet>;
}

export function RequestHousekeepingNotice() {
  const [pending,setPending]=useState(requestHousekeeping.snapshot()); const [error,setError]=useState('');
  useEffect(()=>requestHousekeeping.subscribe(()=>setPending(requestHousekeeping.snapshot())),[]);
  if(!pending.length)return null;
  return <div role="alert"><p>{pending.includes('revocation')?'An abandoned browser login still needs revoking.':copy.security.pendingExposure}</p><ErrorLine text={error}/><Button kind="text" onClick={()=>void requestHousekeeping.retry().then(()=>setPending(requestHousekeeping.snapshot()),e=>setError(e instanceof Error?e.message:'Could not finish.'))}>Retry</Button></div>;
}
