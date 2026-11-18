import { canScanLoginQr } from "../../transport/loginQr";
import { useEffect, useRef, useState } from 'react';
import { useChat, useIdentity } from '../../core/context';
import { useSecurity } from '../../core/securityContext';
import { copy } from '../copy';
import { Button, ErrorLine, Icon } from '../kit';
import { Sheet } from '../Sheet';
const C = copy.e2e;
export function DmSecurityLabel() {
  const chat = useChat(), identity = useIdentity(), security = useSecurity();
  const [open, setOpen] = useState(false);
  const request = useRef(0);
  useEffect(() => { request.current++; setOpen(false); setNumber(undefined); }, [chat.current?.id, identity.me?.id]);
  const [number, setNumber] = useState<{ number: string; verified: boolean; state: string }>();
  const dm = chat.dmSecurity;
  // Channels and group DMs aren't end-to-end encrypted by design; Settings → Security explains
  // that once. Repeating it under every group name crowded the title, so only DMs get a line.
  if (!chat.current || !dm) return null;
  const name = chat.current.name;
  const label = !dm ? C.label.group : dm.label === 'key-problem' ? C.label.problem : dm.label === 'key-changed' ? C.label.changed : dm.label === 'end-to-end-encrypted' ? C.label.encrypted : dm.label === 'encrypted-in-browser' ? C.label.browser : dm.label === 'not-encrypted-yet' ? C.label.notYet : security?.status?.keyRev ? identity.native ? C.label.locked : C.label.lockedBrowser : C.label.none;
  const show = () => { const generation = ++request.current; setOpen(true); setNumber(undefined); void security?.act(async () => { const result = await chat.safetyNumber?.(); if (generation === request.current) setNumber(result); }); };
  return <><button className={`hc-lockline ${dm?.peer.state === 'KEY_ROLLBACK' || dm?.peer.state === 'CHANGED_UNACKNOWLEDGED' ? 'is-alert' : ''}`} onClick={show}><Icon name={dm?.label === 'end-to-end-encrypted' || dm?.label === 'encrypted-in-browser' ? 'lock' : 'info'} /><span>{label}{dm?.peer.state === 'PINNED' && dm.peer.pin?.verified && dm.label === 'end-to-end-encrypted' ? ` · ${C.verified}` : ''}</span></button>
    <Sheet open={open} onClose={() => { request.current++; setOpen(false); setNumber(undefined); }} title={label} sensitive testId="dm-security-details">
      <ErrorLine text={security?.error || chat.error} />
      {(security?.error || chat.error) && <Button onClick={show}>{copy.common.retry}</Button>}
      <p className="hc-sheet__text">{!dm ? C.sheet.group : dm.label === 'encrypted-in-browser' ? C.sheet.browser : dm.label === 'end-to-end-encrypted' ? copy.security.encryptedDetail(name) : dm.label === 'key-problem' ? `${C.rollbackTitle(name)}. ${C.rollbackBody}` : dm.label === 'key-changed' ? `${C.changedTitle(name)}. ${C.changedBody}` : dm.label === 'not-encrypted-yet' ? copy.security.notYetDetail(name) : C.sheet.none}</p>
      {number && <><p>{C.safetyFor(name)}</p><div className="hc-safety__grid" aria-label={C.safety}>{number.number.split(' ').map((n, i) => <span key={i}>{n}</span>)}</div>{number.state === 'CHANGED_UNACKNOWLEDGED' && <p>{copy.security.safetyChanged}</p>}<p>{C.safetyHow(name)}</p><p>{number.verified ? copy.security.checkedNumber(name) : C.notVerifiedHere}</p>{!number.verified && number.state === 'PINNED' && <Button kind="primary" onClick={() => void chat.verifySafety?.(number.number).then(() => chat.safetyNumber?.().then(setNumber))}>{C.markVerified}</Button>}<Button onClick={() => void navigator.clipboard.writeText(number.number)}>{C.copyNumber}</Button></>}
      <Button kind="text" onClick={() => { setOpen(false); setNumber(undefined); }}>{copy.common.done}</Button>
    </Sheet>
  </>;
}
export function DmSecurityBanner() {
  const chat = useChat(), identity = useIdentity(), security = useSecurity();
  const dm = chat.dmSecurity;
  if (!dm) return null;
  const name = chat.current?.name ?? '';
  const changed = dm.peer.state === 'CHANGED_UNACKNOWLEDGED', rollback = dm.peer.state === 'KEY_ROLLBACK';
  const replacement = security?.status?.replacementDeviceName;
  if (dm.removalAcknowledged) return <section className="hc-keybanner is-alert" role="alert"><Icon name="warn" /><strong>{C.label.changed}</strong><p>{C.noteNoKey(name)}</p><div className="hc-keybanner__actions"><Button onClick={() => document.querySelector<HTMLButtonElement>('.hc-header .hc-lockline')?.click()}>{C.compare}</Button></div></section>;
  if (changed || rollback) return <section className="hc-keybanner is-alert" role="alert"><Icon name="warn" /><strong>{rollback ? C.rollbackTitle(name) : C.changedTitle(name)}</strong><p>{rollback ? C.rollbackBody : C.changedBody}</p><div className="hc-keybanner__actions"><Button onClick={() => document.querySelector<HTMLButtonElement>('.hc-header .hc-lockline')?.click()}>{C.compare}</Button>{changed && dm.peer.canAcknowledge && <Button kind="text" onClick={() => void chat.acknowledgeKey?.()}>{C.accept}</Button>}</div></section>;
  if (!dm.canSend && security?.status?.keyRev === 0) return <section className="hc-keybanner"><Icon name="key" /><strong>{C.noteSetUp}</strong><p>{identity.native ? C.sheet.none : copy.link.useApp}</p>{identity.native && <div className="hc-keybanner__actions"><Button kind="primary" onClick={security.openIdentity}>{copy.security.setUp}</Button></div>}</section>;
  if (!dm.canSend) return <section className="hc-keybanner"><Icon name="key" /><strong>{replacement ? copy.keys.replacedOn(replacement) : C.lockedTitle}</strong><p>{dm.peer.pin && !dm.peer.canSendEncrypted ? C.noteNoKey(name) : identity.native ? canScanLoginQr(identity.native) ? C.lockedBody : C.lockedRecovery : C.lockedBrowser}</p><div className="hc-keybanner__actions">{canScanLoginQr(identity.native) && <Button kind="primary" onClick={() => void security?.act(() => security.openReceive())}>{C.useDevice}</Button>}<Button onClick={() => security?.openIdentity()}>{C.enterKey}</Button>{chat.error && <Button onClick={chat.retrySecurity}>{copy.common.retry}</Button>}</div></section>;
  return null;
}
