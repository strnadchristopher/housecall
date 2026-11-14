import { b64u, publicIdentityKey, unb64u } from '../crypto/identity';
import { ctEqual, randomBytes, sharedSecret, unwrap } from '../crypto/common';
import { formatQr, linkKeys, mergePins, newEphemeral, openWrappedKeys, parseQr, sealWrappedKeys, typedCodeMatches, type Pin, type QrPayload } from '../crypto/link';
import { Api, ApiError } from '../transport/api';
import { publicJson } from '../transport/publicApi';
import { secureSession } from '../transport/secureSession';
import { verifyLinkApproval } from '../transport/linkVerification';
import { SecurityApi } from '../adapters/legacy/security';
import { withIdentityLock } from './identityLock';
import { validatePublicKeys } from './pins';
import type { Auth } from '../data/types';
import type { SecurityVault } from './security';

const hex = (b: Uint8Array) => Array.from(b, v => v.toString(16).padStart(2, '0')).join('');
const fromHex = (s: string) => { if (!/^[a-f0-9]{32}$/.test(s)) throw new Error('Invalid link'); return Uint8Array.from(s.match(/../g)!, x => parseInt(x, 16)); };
type Keys = ReturnType<typeof linkKeys>;
function wipeKeys(keys?: Keys) { if (keys) { keys.wrapKey.fill(0); keys.claimTag.fill(0); keys.codeBytes.fill(0); keys.salt.fill(0); keys.code = ''; } }
export type ShowingState =
  | { phase: 'idle' | 'starting' | 'approved' | 'denied' | 'expired' | 'burnt' | 'failed' | 'cancelled'; reason?: string }
  | { phase: 'showing'; expiresAt: number; visibleUntil: number }
  | { phase: 'confirmation' | 'verifying'; deviceName: string; expiresAt: number; browserWarningRequired: true };
interface LinkPoll { state: 'started' | 'claimed' | 'approved' | 'denied' | 'expired' | 'burnt'; expires_at: number; claim: { device_name: string; ephemeral_pub: string; claim_tag: string } | null }
/** Only snapshots are UI data: the showing device's number is never exposed. */
export class ShowingLink {
  private state: ShowingState = { phase: 'idle' };
  private link?: { id: string; rawId: Uint8Array; secret: Uint8Array; ephemeral: ReturnType<typeof newEphemeral>; expiresAt: number; visibleUntil: number };
  private keys?: Keys;
  private epoch = 0;
  private busy = false;
  private expiryTimer?: ReturnType<typeof setTimeout>;
  constructor(private remote: SecurityApi, private vault: SecurityVault, private origin: string, private exportPins: () => Promise<Pin[]>) {}
  snapshot(): ShowingState { this.expire(); return { ...this.state }; }
  private expire() { if (this.link && Date.now() >= this.link.expiresAt) this.end('expired'); }
  private end(phase: 'approved' | 'denied' | 'expired' | 'burnt' | 'failed' | 'cancelled', reason?: string) {
    if (this.expiryTimer) clearTimeout(this.expiryTimer); this.expiryTimer = undefined;
    this.epoch++; this.link?.ephemeral.priv.fill(0); this.link?.secret.fill(0); wipeKeys(this.keys); this.keys = undefined; this.link = undefined; this.state = { phase, reason };
  }
  async start() {
    if (!this.vault.native) throw new Error('Native app required');
    if (this.busy) throw new Error('Link operation in progress');
    await this.cancel(); const epoch = this.epoch; this.state = { phase: 'starting' }; this.busy = true;
    try {
      const me = await this.remote.api.get<{ user: { id: string } }>('/api/me');
      const own = await this.remote.keys(me.user.id); validatePublicKeys(own, this.origin, me.user.id);
      const local = await this.vault.loadIdentity();
      try {
        if (local && (!local.confirmed || own.identity_key !== b64u(publicIdentityKey(local.seed)))) throw new Error('Finish security key setup on this host before linking');
        if (!local && own.identity_key) throw new Error('Import the account security key before linking');
      } finally { local?.seed.fill(0); }
      if (epoch !== this.epoch) return;

      const r = await this.remote.api.post<{ link_id: string; secret: string; expires_at: number }>('/api/link/start', {});
      if (epoch !== this.epoch) { await this.remote.api.post(`/api/link/${encodeURIComponent(r.link_id)}/deny`, {}).catch(() => {}); return; }
      const rawId = fromHex(r.link_id), secret = unwrap(unb64u(r.secret));
      if (secret.length !== 32 || !Number.isSafeInteger(r.expires_at) || r.expires_at <= Date.now() || r.expires_at > Date.now() + 120_000) throw new Error('Invalid link');
      this.link = { id: r.link_id, rawId, secret, ephemeral: newEphemeral(), expiresAt: r.expires_at, visibleUntil: 0 };
      this.state = { phase: 'showing', expiresAt: r.expires_at, visibleUntil: 0 };
      this.expiryTimer = setTimeout(() => this.end('expired'), r.expires_at - Date.now());
    } catch (error) { this.end('failed'); throw error; } finally { this.busy = false; }
  }
  /** Explicit reveal; UI must blur at visibleUntil. A reveal after 60s requires a fresh start. */
  revealQr(): string {
    this.expire(); if (!this.link || this.state.phase !== 'showing') throw new Error('Link unavailable');
    if (this.link.visibleUntil && Date.now() >= this.link.visibleUntil) throw new Error('Start a new code');
    this.link.visibleUntil ||= Math.min(Date.now() + 60_000, this.link.expiresAt);
    this.state = { phase: 'showing', expiresAt: this.link.expiresAt, visibleUntil: this.link.visibleUntil };
    return formatQr(this.origin, this.link.rawId, this.link.secret, this.link.ephemeral.pub);
  }
  async poll() {
    this.expire(); const link = this.link, epoch = this.epoch; if (!link || this.busy) return this.snapshot();
    this.busy = true;
    try {
      const r = await this.remote.api.get<LinkPoll>(`/api/link/${link.id}`); if (epoch !== this.epoch) return this.snapshot();
      if (['denied', 'expired', 'burnt'].includes(r.state)) { this.end(r.state as 'denied' | 'expired' | 'burnt'); return this.snapshot(); }
      if (r.state === 'claimed' && r.claim) {
        if (typeof r.claim.device_name !== 'string' || new TextEncoder().encode(r.claim.device_name).length > 80 || !r.claim.device_name.trim() || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(r.claim.device_name)) throw new Error('Invalid claiming device');
        const pub = unwrap(unb64u(r.claim.ephemeral_pub)), tag = unwrap(unb64u(r.claim.claim_tag));
        const ss = sharedSecret(link.ephemeral.priv, pub); let keys: Keys;
        try { keys = linkKeys({ linkId: link.rawId, secret: link.secret, showingPub: link.ephemeral.pub, claimingPub: pub, sharedSecret: ss }); } finally { ss.fill(0); }
        if (!ctEqual(tag, keys.claimTag)) { wipeKeys(keys); await this.deny('tag-failed'); return this.snapshot(); }
        wipeKeys(this.keys); this.keys = keys;
        this.state = { phase: 'confirmation', deviceName: r.claim.device_name.slice(0, 80), expiresAt: link.expiresAt, browserWarningRequired: true };
      } else if (r.state !== 'started') { this.end('failed', 'unexpected-state'); }
      return this.snapshot();
    } catch (error) { if (epoch === this.epoch) { if (error instanceof ApiError && error.status === 410) this.end('expired'); else { await this.deny('invalid-claim').catch(() => {}); } } throw error; }
    finally { this.busy = false; }
  }
  async submitNumber(typed: string, password?: string) {
    this.expire(); if (!this.link || !this.keys || this.state.phase !== 'confirmation' || this.busy) throw new Error('Confirmation unavailable');
    if (!typedCodeMatches(typed, this.keys.code)) { await this.deny('number-mismatch'); return false; }
    const prompt = this.state, epoch = this.epoch; this.state = { ...prompt, phase: 'verifying' }; this.busy = true;
    try {
      if (!await verifyLinkApproval(this.remote, prompt.deviceName, password)) { if (epoch === this.epoch) this.state = prompt; return false; }
      this.expire(); if (!this.link || epoch !== this.epoch) return false;
      const local = await this.vault.loadIdentity(); let wrapped: Uint8Array | undefined;
      try {
        if (local && !local.confirmed) throw new Error('Confirm recovery words first');
        const pins = local ? await this.exportPins() : [];
        if (epoch !== this.epoch || !this.link || Date.now() >= this.link.expiresAt) { this.expire(); return false; }
        wrapped = local ? sealWrappedKeys(this.keys!.wrapKey, this.link.rawId, local.seed, local.recoveryRev, pins) : undefined;
        await this.remote.api.post(`/api/link/${this.link.id}/approve`, { wrapped_keys: wrapped ? b64u(wrapped) : null });
        if (epoch === this.epoch) this.end('approved'); return true;
      } finally { local?.seed.fill(0); wrapped?.fill(0); }
    } catch (error) {
      if (epoch === this.epoch) {
        if (error instanceof ApiError && error.status === 410) this.end('expired');
        else if (error instanceof ApiError && [404, 409].includes(error.status)) this.end('burnt');
        else this.state = prompt;
      }
      throw error;
    }
    finally { this.busy = false; }
  }
  async deny(reason?: string) { const id = this.link?.id; this.end('denied', reason); if (id) await this.remote.api.post(`/api/link/${id}/deny`, {}); }
  async cancel() { const id = this.link?.id; this.end('cancelled'); if (id) await this.remote.api.post(`/api/link/${id}/deny`, {}).catch(() => {}); }
}
export type ReceivingState =
  | { phase: 'idle' | 'claiming' | 'completed' | 'cancelled' | 'denied' | 'expired' | 'burnt' | 'failed' | 'collision'; exposureReportPending?: boolean; sessionSecure?: boolean; oldSessionRevocationPending?: boolean; recoveryAhead?: boolean }
  | { phase: 'host-confirmation'; origin: string; browserWarningRequired: boolean }
  | { phase: 'account-confirmation' | 'waiting'; username: string; displayName: string | null; code: string };
interface LinkResult { token: string; user: Auth['user']; expires_at: number; wrapped_keys: string | null }
/** New devices receive only. A result is never stored before account-key validation. */
export class ReceivingLink {
  private state: ReceivingState = { phase: 'idle' };
  private qr?: QrPayload;
  private ephemeral?: ReturnType<typeof newEphemeral>;
  private keys?: Keys;
  private deviceKey?: string;
  private username?: string;
  private pending?: { auth: Auth; api: Api; identity?: { seed: Uint8Array; recoveryRev: number; pins: Pin[] } };
  private epoch = 0;
  private busy = false;
  private nextPoll = 0;
  private expiryTimer?: ReturnType<typeof setTimeout>;
  private completionApi?: Api;
  private revocationPending = false;
  constructor(private vault: SecurityVault, private oldSession?: { origin: string; userId: string; sessionId: string }) {}
  snapshot(): ReceivingState { return { ...this.state }; }
  scan(text: string, source: 'native-camera' | 'browser') {
    if (this.vault.native && source !== 'native-camera') throw new Error('Scan again inside the native app');
    this.cancel(); this.qr = unwrap(parseQr(text));
    if (this.oldSession && this.qr.origin !== this.oldSession.origin) { this.cancel(); throw new Error('Scan a code from this host'); }
    this.state = { phase: 'host-confirmation', origin: this.qr.origin, browserWarningRequired: !this.vault.native };
  }
  async confirmHost(deviceName: string, browserWarningAcknowledged = false) {
    if (this.state.phase !== 'host-confirmation' || !this.qr || this.busy) throw new Error('Host confirmation required');
    if (!this.vault.native && !browserWarningAcknowledged) throw new Error('Browser exposure warning required');
    const qr = this.qr, epoch = this.epoch; this.busy = true; this.state = { phase: 'claiming' };
    try {
      this.ephemeral = newEphemeral(); const ss = sharedSecret(this.ephemeral.priv, qr.showingPub);
      try { this.keys = linkKeys({ ...qr, claimingPub: this.ephemeral.pub, sharedSecret: ss }); } finally { ss.fill(0); }
      const deviceBytes = randomBytes(32); try { this.deviceKey = hex(deviceBytes); } finally { deviceBytes.fill(0); }
      const r = await publicJson<{ username: string; display_name: string | null }>(qr.origin, '/api/link/claim', { link_id: hex(qr.linkId), secret: b64u(qr.secret), device_name: deviceName, device_key: this.deviceKey, ephemeral_pub: b64u(this.ephemeral.pub), claim_tag: b64u(this.keys.claimTag) });
      if (epoch !== this.epoch) return;
      if (!r.username || typeof r.username !== 'string') throw new Error('Invalid link account');
      this.expiryTimer = setTimeout(() => { this.cancel(); this.state = { phase: 'expired' }; }, 180_000);
      this.username = r.username; this.state = { phase: 'account-confirmation', username: r.username, displayName: r.display_name, code: this.keys.code };
      this.ephemeral.priv.fill(0); this.ephemeral = undefined;
    } catch (error) { if (epoch === this.epoch) this.fail(error); throw error; } finally { this.busy = false; }
  }
  confirmAccount() { if (this.state.phase !== 'account-confirmation') throw new Error('Account confirmation required'); this.state = { ...this.state, phase: 'waiting' }; }
  async poll(): Promise<Auth | undefined> {
    if (this.state.phase !== 'waiting' || !this.qr || !this.deviceKey || !this.keys || this.busy || Date.now() < this.nextPoll) return;
    const qr = this.qr, epoch = this.epoch; this.busy = true; this.nextPoll = Date.now() + 2000;
    try {
      const r = await publicJson<LinkResult>(qr.origin, '/api/link/result', { link_id: hex(qr.linkId), secret: b64u(qr.secret), device_key: this.deviceKey });
      if (epoch !== this.epoch) return;
      if (!r.user || typeof r.user.id !== 'string' || !r.user.id || r.user.id.length > 128 || typeof r.user.is_owner !== 'boolean' || r.user.username !== this.username || !/^[a-f0-9]{64}$/.test(r.token) || !Number.isSafeInteger(r.expires_at) || r.expires_at <= Date.now() || (this.oldSession && r.user.id !== this.oldSession.userId)) throw new Error('Link account mismatch');
      const auth: Auth = { token: r.token, device_key: this.deviceKey, user: r.user, expires_at: r.expires_at };
      const api = new Api(qr.origin); api.authenticate(auth); const remote = new SecurityApi(api);
      const own = await remote.keys(r.user.id); validatePublicKeys(own, qr.origin, r.user.id);
      let identity: { seed: Uint8Array; recoveryRev: number; pins: Pin[] } | undefined;
      if (r.wrapped_keys !== null) identity = unwrap(openWrappedKeys(this.keys.wrapKey, qr.linkId, unwrap(unb64u(r.wrapped_keys)), own.identity_key ? unwrap(unb64u(own.identity_key)) : undefined));
      else if (own.identity_key) throw new Error('Account security key was not transferred');
      if (epoch !== this.epoch) { identity?.seed.fill(0); return; }
      this.pending = { auth, api, identity }; this.cleanupEphemeral();
      if (identity) {
        const local = await this.vault.loadIdentity();
        try { if (local && !ctEqual(publicIdentityKey(local.seed), publicIdentityKey(identity.seed))) { this.state = { phase: 'collision' }; return; } }
        finally { local?.seed.fill(0); }
      }
      return await this.finish();
    } catch (error) {
      if (epoch === this.epoch && error instanceof ApiError && error.status === 409 && error.message === 'waiting for approval') return;
      if (epoch === this.epoch) this.fail(error); throw error;
    } finally { this.busy = false; }
  }
  async acceptInstallReplacement(noticeAcknowledged: boolean) {
    if (this.state.phase !== 'collision' || !noticeAcknowledged) throw new Error('Install replacement warning required');
    return this.finish();
  }
  private finish(): Promise<Auth> { return withIdentityLock(this.vault, () => this.finishUnlocked()); }
  private async finishUnlocked(): Promise<Auth> {
    const pending = this.pending; if (!pending || !this.qr) throw new Error('Link result unavailable');
    const { auth, api, identity } = pending, origin = this.qr.origin, epoch = this.epoch;
    const active = () => { if (epoch !== this.epoch) throw new Error('Link cancelled'); };
    let recoveryAhead = false;
    if (identity) {
      // Validate/merge every origin before making any write. Unknown host account namespaces
      // use a secure linked-pin inbox; the next authenticated account adopts them with local pins winning.
      const updates: { origin: string; account: string; pins: Pin[] }[] = [];
      for (const host of new Set(identity.pins.map(p => p.origin))) {
        const account = host === origin ? auth.user.id : '__linked__';
        updates.push({ origin: host, account, pins: unwrap(mergePins(await this.vault.loadPins(host, account), identity.pins.filter(p => p.origin === host))) });
      }
      active(); recoveryAhead = (await new SecurityApi(api).synchronizeTransferred(auth.user.id, origin, identity.seed, identity.recoveryRev)).recoveryAhead;
      active(); await this.vault.saveIdentity({ seed: identity.seed, recoveryRev: identity.recoveryRev, confirmed: true, wordsRequirePassword: true });
      for (const update of updates) { active(); await this.vault.savePins(update.origin, update.account, update.pins); }
    }
    active(); let sessionSecure = false;
    if (this.vault.native) sessionSecure = await secureSession.set(origin, { token: auth.token, device_key: auth.device_key, username: auth.user.username, expires_at: auth.expires_at });
    active(); let exposureReportPending = false;
    if (identity && !this.vault.native) { try { await new SecurityApi(api).exposure(); } catch { exposureReportPending = true; } }
    active(); this.completionApi = api;
    if (this.oldSession) {
      try { await api.delete(`/api/devices/${encodeURIComponent(this.oldSession.sessionId)}`); }
      catch { this.revocationPending = true; }
    }
    active(); if (this.expiryTimer) clearTimeout(this.expiryTimer); this.expiryTimer = undefined;
    this.pending = undefined; identity?.seed.fill(0); this.qr.secret.fill(0); this.qr = undefined;
    this.state = { phase: 'completed', sessionSecure, exposureReportPending, oldSessionRevocationPending: this.revocationPending, recoveryAhead }; return auth;
  }
  async retryExposureReport() {
    if (this.state.phase !== 'completed' || !this.completionApi || !this.state.exposureReportPending) throw new Error('No exposure report pending');
    await new SecurityApi(this.completionApi).exposure(); this.state = { ...this.state, exposureReportPending: false };
  }
  async retryOldSessionRevocation() {
    if (this.state.phase !== 'completed' || !this.completionApi || !this.oldSession || !this.revocationPending) throw new Error('No session revocation pending');
    await this.completionApi.delete(`/api/devices/${encodeURIComponent(this.oldSession.sessionId)}`);
    this.revocationPending = false; this.state = { ...this.state, oldSessionRevocationPending: false };
  }
  private cleanupEphemeral() { this.ephemeral?.priv.fill(0); this.ephemeral = undefined; wipeKeys(this.keys); this.keys = undefined; this.deviceKey = undefined; }
  private fail(error: unknown) { this.cancel(); this.state = { phase: error instanceof ApiError && error.status === 410 ? 'expired' : error instanceof ApiError && error.status === 403 ? 'denied' : error instanceof ApiError && error.status === 409 ? 'burnt' : 'failed' }; }
  cancel() { if (this.expiryTimer) clearTimeout(this.expiryTimer); this.expiryTimer = undefined; this.completionApi = undefined; this.revocationPending = false; this.epoch++; this.cleanupEphemeral(); this.qr?.secret.fill(0); this.qr = undefined; this.pending?.identity?.seed.fill(0); this.pending = undefined; this.username = undefined; this.state = { phase: 'cancelled' }; }
}
