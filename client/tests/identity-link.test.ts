import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/transport/linkVerification', () => ({ verifyLinkApproval: vi.fn() }));
import { verifyLinkApproval } from '../src/transport/linkVerification';
import { ReceivingLink, ShowingLink } from '../src/core/linkService';
import { IdentityStorage } from '../src/transport/identityStorage';
import { Api } from '../src/transport/api';
import { SecurityApi } from '../src/adapters/legacy/security';
import { b64u, publicIdentityKey } from '../src/crypto/identity';
import { sealBackup } from '../src/crypto/backup';
import type { PublicKeys } from '../src/core/security';
// Native platform stand-in is test-only; production fallback checks the actual bridge.
const nativeMemory = () => Object.assign(new IdentityStorage(), { native: true, availability: 'memory-unavailable' as const });
const origin = 'https://chat.example.test', seed = new Uint8Array(32).fill(29), id = 'ab'.repeat(16), secret = b64u(new Uint8Array(32).fill(30));
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-13T00:00:00Z')); vi.mocked(verifyLinkApproval).mockResolvedValue(true); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
async function fixture() {
  let state = 'started', wrapped: string | null = null, claim: any = null;
  let keys: PublicKeys = { user_id: 'me', identity_key: b64u(publicIdentityKey(seed)), key_rev: 1, history: [{ key_rev: 1, identity_key: b64u(publicIdentityKey(seed)) }] };
  const writes: string[] = [], expires = Date.now() + 120_000;
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname, body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    if (path === '/api/me') return json({ user: { id: 'me' } });
    if (path === '/api/me/key-backup') return json({ key_backup: b64u(sealBackup(seed, 1)) });
    if (path === '/api/link/start') { state = 'started'; writes.push('start'); return json({ link_id: id, secret, expires_at: expires }); }
    if (path === '/api/link/claim') {
      expect(new Headers(init?.headers).get('Authorization')).toBeNull(); expect(body).not.toHaveProperty('showing_pub');
      if (state !== 'started') { state = 'burnt'; return json({ error: 'link already used' }, 409); }
      state = 'claimed'; claim = body; writes.push('claim'); return json({ username: 'alice', display_name: 'Alice' });
    }
    if (path === `/api/link/${id}`) return json({ state, expires_at: expires, claim: claim && { device_name: claim.device_name, ephemeral_pub: claim.ephemeral_pub, claim_tag: claim.claim_tag } });
    if (path === `/api/link/${id}/approve`) { expect(state).toBe('claimed'); wrapped = body.wrapped_keys; state = 'approved'; writes.push('approve'); return json({ state }); }
    if (path === `/api/link/${id}/deny`) { state = 'denied'; writes.push('deny'); return json({ state }); }
    if (path === '/api/link/result') {
      if (state === 'claimed') return json({ error: 'waiting for approval' }, 409);
      if (state === 'denied') return json({ error: 'link denied' }, 403);
      if (state === 'burnt') return json({ error: 'link already used' }, 409);
      if (state !== 'approved') return json({ error: 'link expired' }, 410);
      expect(body.device_key).toBe(claim.device_key); state = 'burnt'; writes.push('result'); return json({ token: 'cd'.repeat(32), user: { id: 'me', username: 'alice', is_owner: false }, expires_at: Date.now() + 86_400_000, wrapped_keys: wrapped });
    }
    if (path === '/api/users/me/keys') { expect(new Headers(init?.headers).get('Authorization')).toMatch(/^Bearer (starter|cd+)/); return json(keys); }
    if (path === '/api/me/key-exposure') { writes.push('exposure'); return json({}); }
    if (path.startsWith('/api/devices/')) { writes.push('revoke-old'); return json({}); }
    throw new Error(`Unexpected route ${path}`);
  });
  vi.stubGlobal('fetch', fetch); const api = new Api(origin); api.authenticate({ token: 'starter', device_key: 'starter-device' });
  const showingVault = nativeMemory(); await showingVault.saveIdentity({ seed, recoveryRev: 1, confirmed: true });
  const pin = { origin, user_id: 'peer', key_rev: 1, identity_key: b64u(publicIdentityKey(new Uint8Array(32).fill(32))), verified: true, history: [{ key_rev: 1, identity_key: b64u(publicIdentityKey(new Uint8Array(32).fill(32))) }] };
  const showing = new ShowingLink(new SecurityApi(api), showingVault, origin, async () => [pin]), receivingVault = new IdentityStorage(), receiving = new ReceivingLink(receivingVault);
  return { showing, receiving, showingVault, receivingVault, writes, fetch, pin, getClaim: () => claim, setState: (s: string) => { state = s; }, setKeys: (k: PublicKeys) => { keys = k; } };
}
async function claimLink(f: Awaited<ReturnType<typeof fixture>>) {
  await f.showing.start(); f.receiving.scan(f.showing.revealQr(), 'browser'); await f.receiving.confirmHost('Browser', true);
  const snap = f.receiving.snapshot(); if (snap.phase !== 'account-confirmation') throw new Error('No confirmation');
  f.receiving.confirmAccount(); expect(f.receiving.snapshot()).toMatchObject({ phase: 'waiting', code: snap.code, username: 'alice' }); await f.showing.poll(); return snap.code;
}
describe('QR flow through REST adapter, crypto and vault', () => {
  it('requires number + current verification, then transfers account-matched identity, full pins and exposure', async () => {
    const f = await fixture(), code = await claimLink(f);
    expect(f.showing.snapshot().phase).toBe('confirmation'); expect(JSON.stringify(f.showing.snapshot())).not.toContain(`"${code}"`); expect(f.writes).not.toContain('approve');
    expect(await f.receiving.poll()).toBeUndefined(); expect(await f.receivingVault.loadIdentity()).toBeNull();
    expect(await f.showing.submitNumber(code)).toBe(true); await vi.advanceTimersByTimeAsync(2000); const auth = await f.receiving.poll();
    expect(auth?.user.id).toBe('me'); expect((await f.receivingVault.loadIdentity())?.seed).toEqual(seed); expect(await f.receivingVault.loadPins(origin, 'me')).toEqual([f.pin]); expect(f.writes).toEqual(['start', 'claim', 'approve', 'result', 'exposure']); expect(f.receiving.snapshot()).toMatchObject({ phase: 'completed', exposureReportPending: false });
    expect(await f.receiving.poll()).toBeUndefined(); await expect(f.showing.submitNumber(code)).rejects.toThrow();
  });
  it('one wrong typed number denies permanently without user verification', async () => {
    const f = await fixture(), code = await claimLink(f); await f.showing.submitNumber(code === '00' ? '01' : '00');
    expect(f.showing.snapshot()).toMatchObject({ phase: 'denied', reason: 'number-mismatch' }); expect(verifyLinkApproval).not.toHaveBeenCalled(); expect(f.writes).toContain('deny'); await expect(f.showing.submitNumber(code)).rejects.toThrow(); await expect(f.receiving.poll()).rejects.toThrow('denied'); expect(f.receiving.snapshot().phase).toBe('denied');
  });
  it('rejects swapped claim tag before exposing a prompt', async () => {
    const f = await fixture(); await f.showing.start(); f.receiving.scan(f.showing.revealQr(), 'browser'); await f.receiving.confirmHost('Browser', true);
    f.getClaim().claim_tag = b64u(new Uint8Array(16)); await f.showing.poll(); expect(f.showing.snapshot()).toMatchObject({ phase: 'denied', reason: 'tag-failed' }); expect(f.writes).not.toContain('approve');
  });
  it('cancelled verification sends nothing; expiry/cancel destroy approval capability', async () => {
    const f = await fixture(), code = await claimLink(f); vi.mocked(verifyLinkApproval).mockResolvedValue(false);
    expect(await f.showing.submitNumber(code)).toBe(false); expect(f.showing.snapshot().phase).toBe('confirmation'); expect(f.writes).not.toContain('approve');
    await vi.advanceTimersByTimeAsync(120_000); expect(f.showing.snapshot().phase).toBe('expired'); await expect(f.showing.submitNumber(code)).rejects.toThrow(); f.receiving.cancel(); expect(await f.receiving.poll()).toBeUndefined();
  });
  it('warning and account confirmation block routes; web cannot show QR; native needs its own camera', async () => {
    const f = await fixture(); await f.showing.start(); const qr = f.showing.revealQr(); f.receiving.scan(qr, 'browser');
    await expect(f.receiving.confirmHost('Browser')).rejects.toThrow('warning'); expect(f.writes).not.toContain('claim');
    await f.receiving.confirmHost('Browser', true); expect(await f.receiving.poll()).toBeUndefined(); expect(f.writes).not.toContain('result');
    const showing = new ShowingLink(new SecurityApi(new Api(origin)), new IdentityStorage(), origin, async () => []); await expect(showing.start()).rejects.toThrow('Native');
    expect(() => new ReceivingLink(nativeMemory()).scan(qr, 'browser')).toThrow('Scan again');
  });
  it('account mismatch refuses identity/pin/session writes', async () => {
    const f = await fixture(), code = await claimLink(f); await f.showing.submitNumber(code);
    const key = b64u(publicIdentityKey(new Uint8Array(32).fill(31))); f.setKeys({ user_id: 'me', key_rev: 1, identity_key: key, history: [{ key_rev: 1, identity_key: key }] });
    await expect(f.receiving.poll()).rejects.toThrow(); expect(await f.receivingVault.loadIdentity()).toBeNull(); expect(await f.receivingVault.loadPins(origin, 'me')).toEqual([]); expect(f.writes).not.toContain('exposure'); expect(f.receiving.snapshot().phase).toBe('failed');
  });
  it('collision holds until explicit install replacement; local pins win', async () => {
    const f = await fixture(); await f.receivingVault.saveIdentity({ seed: new Uint8Array(32).fill(42), recoveryRev: 1, confirmed: true });
    const localPin = { ...f.pin, verified: false }; await f.receivingVault.savePins(origin, 'me', [localPin]);
    const code = await claimLink(f); await f.showing.submitNumber(code); expect(await f.receiving.poll()).toBeUndefined(); expect(f.receiving.snapshot().phase).toBe('collision');
    await expect(f.receiving.acceptInstallReplacement(false)).rejects.toThrow('warning'); expect((await f.receivingVault.loadIdentity())?.seed).not.toEqual(seed);
    await f.receiving.acceptInstallReplacement(true); expect((await f.receivingVault.loadIdentity())?.seed).toEqual(seed); expect(await f.receivingVault.loadPins(origin, 'me')).toEqual([localPin]);
  });
  it('double claim burns both attempts without automatic restart', async () => {
    const f = await fixture(); await f.showing.start(); const qr = f.showing.revealQr(); f.receiving.scan(qr, 'browser'); await f.receiving.confirmHost('first', true);
    const other = new ReceivingLink(new IdentityStorage()); other.scan(qr, 'browser'); await expect(other.confirmHost('second', true)).rejects.toThrow('used'); expect(other.snapshot().phase).toBe('burnt'); await f.showing.poll(); expect(f.showing.snapshot().phase).toBe('burnt'); expect(f.writes.filter(x => x === 'start')).toHaveLength(1);
  });
  it('requires fresh code after 60 second reveal', async () => {
    const f = await fixture(); await f.showing.start(); f.showing.revealQr(); await vi.advanceTimersByTimeAsync(60_000); expect(() => f.showing.revealQr()).toThrow('new code'); await f.showing.cancel(); expect(() => f.showing.revealQr()).toThrow();
  });
});
