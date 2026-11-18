import { b64u, publicIdentityKey, unb64u } from '../crypto/identity';
import { ctEqual, randomBytes, sharedSecret, unwrap } from '../crypto/common';
import { formatQr, linkKeys, mergePins, newEphemeral, openWrappedKeys, parseQr, sealWrappedKeys, type Pin, type QrPayload } from '../crypto/link';
import { Api, ApiError } from '../transport/api';
import { publicJson } from '../transport/publicApi';
import { verifyLinkApproval } from '../transport/linkVerification';
import { canScanLoginQr } from '../transport/loginQr';
import { SecurityApi } from '../adapters/legacy/security';
import { validatePublicKeys } from './pins';
import { withIdentityLock } from './identityLock';
import type { Auth } from '../data/types';
import type { SecurityVault } from './security';
const hex = (b: Uint8Array) => Array.from(b, v => v.toString(16).padStart(2, '0')).join('');
const rawId = (id: string) => { if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('Invalid link'); return Uint8Array.from(id.match(/../g)!, x => parseInt(x,16)); };
type Keys = ReturnType<typeof linkKeys>;
function wipe(k?: Keys) { if (k) { k.wrapKey.fill(0); k.claimTag.fill(0); k.codeBytes.fill(0); k.salt.fill(0); k.code = ''; } }
interface Started { link_id: string; secret: string; expires_at: number }
interface Status { state: string; expires_at: number; burn_reason?: string; username?: string; user_id?: string; claim?: { device_name: string; ephemeral_pub: string; claim_tag: string } }
// Memory-only retry queue survives a screen closing during collection/adoption.
const pendingActions = new Map<SecurityApi | Api, {kind: 'exposure' | 'revocation'; run: () => Promise<unknown>}>();
const pendingListeners = new Set<() => void>();
export const requestHousekeeping = {
  subscribe(fn: () => void) { pendingListeners.add(fn); return () => { pendingListeners.delete(fn); }; },
  snapshot() { return [...pendingActions.values()].map(v=>v.kind); },
  async retry() { for(const [key, action] of pendingActions) { await action.run(); pendingActions.delete(key); } for(const fn of pendingListeners) fn(); },
};
function retainAction(key: SecurityApi | Api, kind:'exposure'|'revocation', run:()=>Promise<unknown>) { pendingActions.set(key,{kind,run}); for(const fn of pendingListeners) fn(); }
export interface RequestState { phase: string; username?: string; phone?: string; expiresAt?: number; visibleUntil?: number; exposureReportPending?: boolean; reason?: string }
/** Both hosted and community web call the community origin, never central OPAQUE. */
export async function supportsRequest(origin: string): Promise<boolean> {
  const r = await publicJson<{ capabilities?: { link_request?: boolean } }>(origin, '/api/instance');
  return r.capabilities?.link_request === true;
}
export class RequestingLink {
  private state: RequestState = { phase: 'idle' };
  private link?: Started;
  private ephemeral?: ReturnType<typeof newEphemeral>;
  private keys?: Keys;
  private deviceKey?: string;
  private account?: { id: string; username: string };
  private number?: string;
  private epoch = 0;
  private busy = false;
  private exposure?: SecurityApi;
  private current: () => boolean;
  private requesterApi?: Api;
  constructor(readonly origin: string, private vault: SecurityVault, private api: Api,
    private adopt: (origin: string, auth: Auth, current: () => boolean) => Promise<void>, private unlockUser?: string) {
    this.current = api.captureBinding();
    if (vault.native || (unlockUser ? !api.hasSession() || api.serverOrigin() !== origin : api.hasSession())) throw new Error('Browser session mismatch');
    if (unlockUser) this.requesterApi = api.forkSession();
  }
  snapshot() { return { ...this.state }; }
  private active(epoch: number) { if (epoch !== this.epoch || !this.current()) throw new Error('Link cancelled or account changed'); }
  private path(action: string, l: Started) { return this.unlockUser ? `/api/link/request/${l.link_id}/${action}` : `/api/link/request/${action}`; }
  private proof(l: Started, deviceKey: string) { return { link_id: l.link_id, secret: l.secret, device_key: deviceKey }; }
  private send<T>(action: string, l: Started, key: string, extra = {}): Promise<T> {
    const path = this.path(action,l), body = { ...this.proof(l,key), ...extra };
    return this.unlockUser ? this.requesterApi!.post<T>(path,body) : publicJson<T>(this.origin,path,body);
  }
  async start(deviceName: string) {
    if (this.busy) return;
    this.busy = true; await this.cancel(); const epoch = this.epoch;
    let created: Started | undefined; let key: string | undefined;
    try {
      this.active(epoch); if (!await supportsRequest(this.origin)) throw new Error('Update this server to use phone login'); this.active(epoch);
      const bytes = randomBytes(32); key = hex(bytes); bytes.fill(0);
      const body = { device_name: deviceName, device_key: key, browser_origin: location.origin };
      created = this.unlockUser ? await this.requesterApi!.post<Started>('/api/link/unlock-request',body) : await publicJson<Started>(this.origin,'/api/link/request',body);
      this.active(epoch); rawId(created.link_id); const secret = unwrap(unb64u(created.secret)); if (secret.length !== 32) throw new Error('Invalid link'); secret.fill(0);
      if (!Number.isSafeInteger(created.expires_at) || created.expires_at <= Date.now() || created.expires_at > Date.now()+125000) throw new Error('Invalid link lifetime');
      this.ephemeral = newEphemeral(); this.link = created; this.deviceKey = key;
      this.state = { phase: 'showing', expiresAt: created.expires_at, visibleUntil: Math.min(Date.now()+60000, created.expires_at) };
    } catch (e) { if (created && key) await this.send('cancel',created,key).catch(() => {}); if (epoch === this.epoch) this.state = {phase:'failed'}; throw e; }
    finally { this.busy = false; }
  }
  qr() {
    if (!this.link || !this.ephemeral || this.state.phase !== 'showing' || Date.now() >= this.state.visibleUntil!) return undefined;
    return formatQr(this.origin,rawId(this.link.link_id),unwrap(unb64u(this.link.secret)),this.ephemeral.pub,'hcr1');
  }
  async poll() {
    if (this.busy || !this.link || !this.deviceKey) return;
    const epoch = this.epoch, l = this.link, key = this.deviceKey; this.busy = true;
    try {
      this.active(epoch);
      const r = await this.send<Status>('status',l,key); this.active(epoch);
      if (['denied','burnt','expired'].includes(r.state)) { await this.cancel(); this.state = {phase:r.state, reason:r.burn_reason}; return; }
      if (Date.now() >= l.expires_at && r.state !== 'approved') { await this.cancel(); this.state = {phase:'expired'}; return; }
      if (r.claim && !this.keys) {
        if (!this.ephemeral || !r.user_id || !r.username || (this.unlockUser && r.user_id !== this.unlockUser)) throw new Error('Link account mismatch');
        const ss = sharedSecret(this.ephemeral.priv,unwrap(unb64u(r.claim.ephemeral_pub)));
        let keys: Keys; try { keys = linkKeys({direction:'hcr1',linkId:rawId(l.link_id),secret:unwrap(unb64u(l.secret)),showingPub:this.ephemeral.pub,claimingPub:unwrap(unb64u(r.claim.ephemeral_pub)),sharedSecret:ss}); } finally {ss.fill(0);}
        if (!ctEqual(keys.claimTag,unwrap(unb64u(r.claim.claim_tag)))) { wipe(keys); throw new Error('Invalid phone binding'); }
        this.keys = keys; this.ephemeral.priv.fill(0); this.ephemeral = undefined;
        this.account = {id:r.user_id,username:r.username}; this.state = {phase:'waiting',username:r.username,phone:r.claim.device_name};
      }
      if (this.account && (r.user_id !== this.account.id || r.username !== this.account.username)) throw new Error('Link account changed');
      if (r.state === 'approved' && this.keys) this.state = {...this.state, phase:'number'};
      if (this.state.phase === 'showing' && Date.now() >= this.state.visibleUntil!) await this.cancel();
    } catch (e) { if (epoch === this.epoch) { await this.cancel(); this.state = {phase:'failed'}; } throw e; }
    finally { this.busy = false; }
  }
  submitNumber(number: string) {
    if (this.state.phase !== 'number' || this.number !== undefined || !/^[0-9]{2}$/.test(number)) throw new Error('Confirmation unavailable');
    this.number = number; this.state = {...this.state,phase:'account-confirmation'};
  }
  // Account confirmation precedes collection, so "Not me" never mints a session.
  async confirmAccount() {
    if (this.busy || this.state.phase !== 'account-confirmation' || !this.link || !this.keys || !this.deviceKey || !this.account) throw new Error('Account confirmation required');
    const epoch = this.epoch, l = this.link, key = this.deviceKey, keys = this.keys, account = this.account; this.busy = true;
    let minted: Api | undefined;
    let seed: Uint8Array | undefined;
    try {
      this.active(epoch);
      const r = await this.send<{ token?: string; user?: Auth['user']; expires_at?: number; wrapped_keys: string | null; user_id?: string }>('collect',l,key,{confirmation:this.number});
      // Capture/revoke a minted credential even if the generation changed while collection ran.
      if (!this.unlockUser && typeof r.token === 'string' && /^[a-f0-9]{64}$/.test(r.token)) { minted = new Api(this.origin); minted.authenticate({token:r.token,device_key:key}); }
      this.active(epoch);
      if (this.unlockUser ? r.user_id !== account.id || r.token !== undefined || r.user !== undefined : !minted || r.user?.id !== account.id || r.user.username !== account.username || typeof r.user.is_owner !== 'boolean' || !Number.isSafeInteger(r.expires_at) || r.expires_at! <= Date.now()) throw new Error('Link account mismatch');
      const api = minted ?? this.requesterApi!, remote = new SecurityApi(api);
      const own = await remote.keys(account.id); this.active(epoch); validatePublicKeys(own,this.origin,account.id);
      if (r.wrapped_keys !== null) {
        if (!own.identity_key) throw new Error('Account identity unavailable');
        const opened = unwrap(openWrappedKeys(keys.wrapKey,rawId(l.link_id),unwrap(unb64u(r.wrapped_keys)),unwrap(unb64u(own.identity_key)))); seed = opened.seed;
        await withIdentityLock(this.vault,async () => {
          const local = await this.vault.loadIdentity();
          try { if (local && !ctEqual(publicIdentityKey(local.seed),publicIdentityKey(opened.seed))) throw new Error('Existing device security key differs'); } finally {local?.seed.fill(0);}
          const updates: {origin:string;account:string;pins:Pin[]}[] = [];
          for (const origin of new Set(opened.pins.map(p=>p.origin))) {
            const user = origin === this.origin ? account.id : '__linked__';
            updates.push({origin,account:user,pins:unwrap(mergePins(await this.vault.loadPins(origin,user),opened.pins.filter(p=>p.origin===origin)))});
          }
          this.active(epoch); await remote.synchronizeTransferred(account.id,this.origin,opened.seed,opened.recoveryRev); this.active(epoch);
          await this.vault.importIdentity({seed:opened.seed,recoveryRev:opened.recoveryRev,confirmed:true,wordsRequirePassword:true},updates,()=>epoch===this.epoch && this.current()); this.active(epoch);
        });
        this.exposure = remote;
        try { await remote.exposure(); this.exposure = undefined; } catch { retainAction(remote,'exposure',()=>remote.exposure()); }
        this.active(epoch);
      } else if (this.unlockUser) throw new Error('Security key was not transferred');
      if (!this.unlockUser) {
        this.active(epoch); const auth={token:r.token!,device_key:key,user:r.user!,expires_at:r.expires_at!};
        try { await this.adopt(this.origin,auth,()=>epoch===this.epoch && this.current()); } finally { if(this.api.isSession(auth)) minted=undefined; }
        // Auth adoption unmounts sign-in UI. Its cleanup is expected once this credential is active.
        if (!this.api.isSession(auth)) throw new Error('Session was not adopted');
      } else this.active(epoch);
      this.clear(); this.state = {phase:'completed',username:account.username,exposureReportPending:!!this.exposure};
    } catch (e) { if (epoch === this.epoch) { await this.cancel(); this.state = {phase:'failed'}; } throw e; }
    finally { seed?.fill(0); this.busy = false; if (minted) { const abandoned = minted; try { await this.revoke(abandoned); } catch { retainAction(abandoned,'revocation',()=>this.revoke(abandoned)); } } }
  }
  private async revoke(api: Api) {
    try {
      const me = await api.get<{session_id:string}>('/api/me');
      await api.delete(`/api/devices/${encodeURIComponent(me.session_id)}`);
    } catch(e) { if (!(e instanceof ApiError && [401,404].includes(e.status))) throw e; }
  }
  async retryExposureReport() { if (!this.exposure) return; await this.exposure.exposure(); pendingActions.delete(this.exposure); for(const fn of pendingListeners) fn(); this.exposure = undefined; this.state = {...this.state,exposureReportPending:false}; }
  private clear() { this.link = undefined; this.ephemeral?.priv.fill(0); this.ephemeral = undefined; wipe(this.keys); this.keys = undefined; this.deviceKey = undefined; this.account = undefined; this.number = undefined; }
  async cancel() {
    const l = this.link, key = this.deviceKey; this.epoch++; this.clear(); this.state = {phase:'cancelled'};
    if (l && key) await this.send('cancel',l,key).catch(() => {});
  }
}

export interface ApproverState { phase:string; deviceName?:string; username?:string; kind?:'sign-in'|'unlock'; code?:string; browserOrigin?:string }
/** Only the exact already-authenticated community Api may be used after a scan. */
export class ApprovingLink {
  private state: ApproverState = {phase:'idle'};
  private qr?: QrPayload;
  private keys?: Keys;
  private epoch = 0;
  private busy = false;
  private current: () => boolean;
  private cleanupApi: Api;
  constructor(private remote: SecurityApi,private vault: SecurityVault,private userId:string,private exportPins:()=>Promise<Pin[]>) { this.current = remote.api.captureBinding(); this.cleanupApi = remote.api.forkSession(); }
  snapshot() { return {...this.state}; }
  private active(epoch:number) { if (epoch !== this.epoch || !this.current()) throw new Error('Account changed or link cancelled'); }
  async scan(text:string) {
    if (!canScanLoginQr(this.vault.native) || !this.remote.api.hasSession() || !this.current()) throw new Error('Signed-in phone required');
    const qr = unwrap(parseQr(text,'hcr1'));
    // This check is before cancellation, capability discovery, keys, or ANY phone network request.
    if (qr.origin !== this.remote.api.serverOrigin()) throw new Error(`${new URL(qr.origin).host} isn't signed in on this phone. Switch to that server first.`);
    if (this.busy) return; this.busy=true; await this.cancel(); const epoch=this.epoch;
    const ephemeral=newEphemeral();
    try {
      this.active(epoch); if (!await supportsRequest(qr.origin)) throw new Error('Server does not support phone approval'); this.active(epoch);
      const ss=sharedSecret(ephemeral.priv,qr.showingPub); let keys:Keys;
      try {keys=linkKeys({...qr,direction:'hcr1',claimingPub:ephemeral.pub,sharedSecret:ss});} finally {ss.fill(0);}
      this.qr=qr; this.keys=keys;
      const r=await this.remote.api.post<{kind:'sign-in'|'unlock';device_name:string;username:string;user_id:string;expires_at:number;browser_origin:string}>(`/api/link/request/${hex(qr.linkId)}/claim`,{secret:b64u(qr.secret),ephemeral_pub:b64u(ephemeral.pub),claim_tag:b64u(keys.claimTag)});
      if (epoch!==this.epoch || !this.current()) { await this.cleanupApi.post(`/api/link/request/${hex(qr.linkId)}/deny`,{}); throw new Error('Link cancelled'); }
      if (r.user_id!==this.userId || !['sign-in','unlock'].includes(r.kind) || typeof r.device_name!=='string' || r.device_name.length>80 || !r.username) throw new Error('Invalid link account');
      this.state={phase:'confirmation',deviceName:r.device_name,username:r.username,kind:r.kind,browserOrigin:r.browser_origin};
    } catch(e) { if(epoch===this.epoch) {await this.cancel();this.state={phase:'failed'};} throw e; }
    finally {ephemeral.priv.fill(0);this.busy=false;}
  }
  async approve(exportKeys=false,password?:string) {
    if (this.busy || this.state.phase!=='confirmation' || !this.qr || !this.keys) throw new Error('Phone confirmation required');
    const epoch=this.epoch,qr=this.qr,keys=this.keys,prompt=this.state;this.busy=true;
    let local: Awaited<ReturnType<SecurityVault['loadIdentity']>> = null; let wrapped: Uint8Array | undefined;
    try {
      this.active(epoch); if (!await verifyLinkApproval(this.remote,prompt.deviceName!,password)) return; this.active(epoch);
      const own=await this.remote.keys(this.userId);this.active(epoch);validatePublicKeys(own,qr.origin,this.userId);
      if (exportKeys || prompt.kind==='unlock') {
        local=await this.vault.loadIdentity();this.active(epoch);
        if (!local?.confirmed || own.identity_key!==b64u(publicIdentityKey(local.seed))) throw new Error('Confirm this account security key before exporting');
        const pins=await this.exportPins();this.active(epoch);wrapped=sealWrappedKeys(keys.wrapKey,qr.linkId,local.seed,local.recoveryRev,pins);
      }
      // Uniform random two digits, independent of the public ephemeral transcript.
      let b:Uint8Array;do {b=randomBytes(1);} while(b[0]>=200);
      const code=(b[0]%100).toString().padStart(2,'0');b.fill(0);
      this.active(epoch);await this.remote.api.post(`/api/link/request/${hex(qr.linkId)}/approve`,{confirmation:code,wrapped_keys:wrapped?b64u(wrapped):null});this.active(epoch);
      wipe(this.keys);this.keys=undefined;this.state={...prompt,phase:'approved',code};
    } finally {local?.seed.fill(0);wrapped?.fill(0);this.busy=false;}
  }
  async poll() {
    if (!this.qr || this.busy || !['confirmation','approved'].includes(this.state.phase)) return;
    const epoch=this.epoch;this.active(epoch);
    const r=await this.remote.api.get<{state:string;burn_reason?:string}>(`/api/link/request/${hex(this.qr.linkId)}`);this.active(epoch);
    if (['denied','burnt','expired'].includes(r.state)) { const phase=r.state==='burnt' && r.burn_reason==='used'?'completed':r.state;this.clear();this.state={phase}; }
  }
  private clear() {wipe(this.keys);this.keys=undefined;this.qr?.secret.fill(0);this.qr=undefined;}
  async cancel() {const id=this.qr && hex(this.qr.linkId);this.epoch++;this.clear();this.state={phase:'cancelled'};if(id) await this.cleanupApi.post(`/api/link/request/${id}/deny`,{}).catch(()=>{});}
}
