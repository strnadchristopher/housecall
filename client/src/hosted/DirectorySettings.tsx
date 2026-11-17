import { useEffect, useState } from 'react';
import { useChat } from '../core/context';
import { Button, ErrorLine, Field } from '../ui/kit';
type Status = { origin: string; dnsName: string; dnsValue: string; listed: boolean; description: string };
/** The server enforces ownership and signs publication. Browser never holds a publication key. */
export function DirectorySettings() {
  const chat = useChat(); const [status, setStatus] = useState<Status>(); const [description, setDescription] = useState(''); const [confirm, setConfirm] = useState(false); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { let live = true; void chat.directoryStatus().then(value => { if (live) { setStatus(value); setDescription(value.description); } }, () => {}); return () => { live = false; }; }, []);
  if (!status) return null;
  const publish = async (listed: boolean) => { setBusy(true); setError(''); try { await chat.publishDirectory(listed, description); setStatus({ ...status, listed, description }); setConfirm(false); } catch (e) { setError(e instanceof Error ? e.message : 'Directory unavailable.'); } finally { setBusy(false); } };
  return <section className="hc-stack hc-directory-settings"><h2>Public listing</h2><Field label="Public description" value={description} maxLength={140} onChange={e => setDescription(e.target.value)} />
    <button type="button" className="hc-switchrow" role="switch" aria-checked={status.listed} disabled={busy} onClick={() => status.listed ? void publish(false) : setConfirm(true)}>List this server publicly</button>
    <p className="hc-note">Shows the name, description and address {status.origin} in HouseCall search. People still need an invite or your approval to join.</p>
    {confirm && <><p>Publish this server at {status.origin}?</p><p className="hc-note">DNS ownership record</p><code>{status.dnsName}</code><code>{status.dnsValue}</code><Button kind="primary" busy={busy} onClick={() => void publish(true)}>Publish</Button><Button kind="text" onClick={() => setConfirm(false)}>Cancel</Button></>}
    {status.listed && <><p role="status">Listed publicly</p><Button busy={busy} onClick={() => void publish(true)}>Update listing</Button></>}
    <ErrorLine text={error} />
  </section>;
}
