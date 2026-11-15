import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/transport/linkVerification', () => ({ verifyLinkApproval: vi.fn() }));
import { verifyLinkApproval } from '../src/transport/linkVerification';
import { ReceivingLink, ShowingLink } from '../src/core/linkService';
import { IdentityService } from '../src/core/identityService';
import { DmService } from '../src/adapters/legacy/dm';
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
async function fixture(signedIn = false, adopt?: (origin: string, auth: import('../src/data/types').Auth) => Promise<void>, vault = new IdentityStorage()) {
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
  const showing = new ShowingLink(new SecurityApi(api), showingVault, origin, async () => [pin, { ...pin, origin: 'https://other.example.test' }]), receivingVault = vault, receiving = new ReceivingLink(receivingVault, signedIn ? { origin, userId: 'me', sessionId: 'old-session' } : undefined, adopt);
  return { showing, receiving, showingVault, receivingVault, writes, fetch, pin, getClaim: () => claim, setState: (s: string) => { state = s; }, setKeys: (k: PublicKeys) => { keys = k; } };
}
async function claimLink(f: Awaited<ReturnType<typeof fixture>>) {
  await f.showing.start(); f.receiving.scan(f.showing.revealQr(), f.receivingVault.native ? 'native-camera' : 'browser'); await f.receiving.confirmHost('Browser', true);
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

it('separate matched-number screen cannot approve until owner verification resolves, and Deny wins the race', async () => {
  const f = await fixture(), code = await claimLink(f);
  expect(await f.showing.matchNumber(code)).toBe(true);
  expect(f.showing.snapshot().phase).toBe('verifying');
  expect(verifyLinkApproval).not.toHaveBeenCalled(); expect(f.writes).not.toContain('approve');
  let resolveOwner!: (value: boolean) => void;
  vi.mocked(verifyLinkApproval).mockImplementation(() => new Promise(resolve => { resolveOwner = resolve; }));
  const verifying = f.showing.verifyMatched();
  await f.showing.deny(); resolveOwner(true);
  expect(await verifying).toBe(false); expect(f.writes).not.toContain('approve');
  await expect(f.showing.verifyMatched()).rejects.toThrow();
});
it('cancelled verification stays on the separate verification screen; wrong raw paste denies without verification', async () => {
  const f = await fixture(), code = await claimLink(f);
  await f.showing.matchNumber(code); vi.mocked(verifyLinkApproval).mockResolvedValue(false);
  expect(await f.showing.verifyMatched()).toBe(false); expect(f.showing.snapshot().phase).toBe('verifying');
  expect(f.writes).not.toContain('approve'); await f.showing.cancel();
  const another = await fixture(); await claimLink(another);
  await another.showing.matchNumber('094'); expect(another.showing.snapshot()).toMatchObject({ phase: 'denied', reason: 'number-mismatch' });
});

it('signed-in receiving awaits actual auth adoption before old-session DELETE; failed revocation stays retryable', async () => {
  let adopted = false, finishAdoption!: () => void;
  const adoption = new Promise<void>(resolve => { finishAdoption = resolve; });
  const f = await fixture(true, async (target, auth) => {
    expect(target).toBe(origin); expect(auth.user.id).toBe('me');
    expect((await f.receivingVault.loadIdentity())?.seed).toEqual(seed);
    expect(f.writes).not.toContain('revoke-old'); await adoption; adopted = true;
  });
  const fetch = globalThis.fetch;
  let failOnce = true;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    if (new URL(String(input)).pathname === '/api/devices/old-session') {
      expect(adopted).toBe(true);
      if (failOnce) { failOnce = false; return json({ error: 'temporary revoke failure' }, 503); }
    }
    return fetch(input, init);
  });
  const code = await claimLink(f); await f.showing.submitNumber(code);
  const completing = f.receiving.poll();
  await vi.waitFor(() => expect(f.writes).toContain('exposure'));
  expect(f.writes).not.toContain('revoke-old'); finishAdoption();
  expect((await completing)?.user.id).toBe('me');
  expect(f.receiving.snapshot()).toMatchObject({ phase: 'completed', oldSessionRevocationPending: true });
  await f.receiving.retryOldSessionRevocation();
  expect(f.receiving.snapshot()).toMatchObject({ phase: 'completed', oldSessionRevocationPending: false });
  expect(f.writes).toContain('revoke-old');
});

// Persisted bridge records survive new vault/service instances; no native-runtime claim.
it.each(['before-pins', 'after-first-pins', 'before-journal-clear'])('recovers interrupted QR import across restart: %s', async failure => {
  const records = new Map<string, unknown>(), writes: string[] = [];
  let blocked = true, pinWrites = 0;
  const invoke = async <T,>(command: string, args: Record<string, any> = {}): Promise<T> => {
    const name = command.split('|')[1], key = JSON.stringify([args.origin, args.userId]);
    if (name === 'identity_get') return { identity: structuredClone(records.get('identity')) } as T;
    if (name === 'identity_set') {
      writes.push('identity');
      if (blocked && failure === 'before-journal-clear' && records.has('identity')) throw new Error('power lost');
      records.set('identity', structuredClone(args.identity)); return { ok: true } as T;
    }
    if (name === 'pins_get') return { pins: structuredClone(records.get(key)) } as T;
    if (name === 'pins_set') {
      writes.push('pins');
      if (blocked && (failure === 'before-pins' || (failure === 'after-first-pins' && pinWrites >= 1))) throw new Error('power lost');
      records.set(key, structuredClone(args.pins)); pinWrites++; return { ok: true } as T;
    }
    if (name === 'bindings_get') return { bindings: [] } as T;
    if (name === 'bindings_set') return { ok: true } as T;
    throw new Error('Unexpected bridge call ' + name);
  };
  const f = await fixture(false, undefined, new IdentityStorage(invoke)), code = await claimLink(f);
  await f.showing.submitNumber(code);
  await expect(f.receiving.poll()).rejects.toThrow();
  expect(writes[0]).toBe('identity'); // Exact former failure window: identity durable before pins.
  expect(f.receiving.snapshot().phase).toBe('failed'); expect(f.writes).not.toContain('exposure');
  f.receiving.cancel();
  const restarted = new IdentityStorage(invoke), api = new Api(origin); api.authenticate({ token: 'starter', device_key: 'device' });
  await expect(new IdentityService(restarted, new SecurityApi(api), origin, 'me').bootstrap()).rejects.toThrow();
  const dm = new DmService(api, restarted, origin, 'me'), context = { id: 'dm', kind: 'dm' as const, memberIds: ['me', 'peer'] };
  // A malicious host claims the established peer has no key. No outgoing path may adopt TOFU.
  const originalFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: any, init?: RequestInit) => new URL(String(input)).pathname === '/api/users/peer/keys'
    ? json({ user_id: 'peer', identity_key: null, key_rev: 0, history: [] }) : originalFetch(input, init));
  await expect(dm.send(context, 'blocked')).rejects.toThrow();
  await expect(dm.sendLegacyPlaintext(context, { body: 'blocked' })).rejects.toThrow();
  expect(f.fetch.mock.calls.some(([input]) => String(input).includes('/messages'))).toBe(false);
  blocked = false;
  const recovered = new IdentityStorage(invoke);
  expect((await new IdentityService(recovered, new SecurityApi(api), origin, 'me').bootstrap()).phase).toBe('ready');
  expect(await recovered.loadPins(origin, 'me')).toEqual([f.pin]);
  expect(await recovered.loadPins('https://other.example.test', 'other-account')).toEqual([{ ...f.pin, origin: 'https://other.example.test' }]);
  expect(records.get('identity')).not.toHaveProperty('pin_import');
  const restoredDm = new DmService(api, recovered, origin, 'me');
  await expect(restoredDm.sendLegacyPlaintext(context, { body: 'still blocked' })).rejects.toThrow('Pinned peer');
});
