import { afterEach, describe, expect, it, vi } from 'vitest';
import vectors from './vectors/dm-v1.json';
import { IdentityStorage } from '../src/transport/identityStorage';
import { IdentityService } from '../src/core/identityService';
import { SecurityApi } from '../src/adapters/legacy/security';
import { Api } from '../src/transport/api';
import { b64u, publicIdentityKey } from '../src/crypto/identity';
import { sealBackup, recoveryKey, recoveryWords } from '../src/crypto/backup';
import { acknowledgePeer, evaluatePeer } from '../src/core/pins';
import { plaintextMessage, replyStatus } from '../src/core/dm';
import type { Pin } from '../src/crypto/link';
import type { PublicKeys } from '../src/core/security';
import { IdentityCoordinator } from '../src/core/identityCoordinator';
import { parseBackup } from '../src/crypto/backup';
import { unwrap } from '../src/crypto/common';
import { unb64u } from '../src/crypto/identity';
import { secureSession } from '../src/transport/secureSession';
// Native platform stand-in is test-only; production fallback checks the actual bridge.
const nativeMemory = () => Object.assign(new IdentityStorage(), { native: true, availability: 'memory-unavailable' as const });
const origin = 'https://chat.example.test', peerId = 'peer';
const d: any = vectors;
const bytes = (s: string) => new Uint8Array(Buffer.from(s, 'hex'));
const seed = bytes(d.identities[0].seed);
const noKeys = (id = 'me'): PublicKeys => ({ user_id: id, identity_key: null, key_rev: 0, history: [] });
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('closed pin history integration vectors (formerly crypto TODOs)', () => {
  for (const v of d.negative.filter((v: any) => v.kind === 'pin_state')) it(v.name, () => {
    const pin: Pin = { origin, user_id: peerId, ...v.pin };
    const server: PublicKeys = { user_id: peerId, ...v.server, identity_key: v.server.history.at(-1).identity_key };
    const state = evaluatePeer(pin, server, origin, peerId);
    if (v.name.includes('forged older')) { expect(state.state).toBe('PINNED'); expect(state.pin?.history.find(h => h.key_rev === v.envelope_peer_rev)).toBeUndefined(); expect(state.pin).toEqual(pin); }
    else if (v.name.includes('above the pin')) { expect(state.state).toBe('PINNED'); expect(state.pin).toEqual(pin); }
    else if (v.name.startsWith('genuine reset')) { expect(state.state).toBe('CHANGED_UNACKNOWLEDGED'); expect(state.canSendEncrypted).toBe(false); expect(state.canAcknowledge).toBe(true); const next = acknowledgePeer(pin, server); expect(next.history).toEqual(server.history); expect(next.verified).toBe(false); }
    else { expect(state.state).toBe('KEY_ROLLBACK'); expect(state.canAcknowledge).toBe(false); expect(state.canSendPlaintext).toBe(false); expect(() => acknowledgePeer(pin, server)).toThrow(); }
  });
  for (const v of d.negative.filter((v: any) => v.kind === 'reply_binding')) it(v.name, () => {
    const payload = { v: 1 as const, text: 'reply', re: b64u(bytes(v.payload_re_hex)) };
    const row = { id: 'reply', channel_id: 'dm', author_id: 'me', body: '', enc: 1, reply_to: v.server_reply_to_nonce_hex ? 'target' : null };
    const target = v.server_reply_to_nonce_hex ? { ...row, id: 'target', reply_to: null } : undefined;
    const opened = target ? { status: 'opened' as const, payload: { v: 1 as const, text: 'target' }, nonce: b64u(bytes(v.server_reply_to_nonce_hex)), encrypted: true as const, reply: 'none' as const } : undefined;
    expect(replyStatus(payload, row, target, opened)).toBe('unchecked');
  });
  for (const v of d.negative.filter((v: any) => v.kind === 'plaintext_in_encrypted_dm')) it(v.name, () => {
    const pin: Pin = { origin, user_id: peerId, identity_key: d.identities[1].identity_key_b64u, key_rev: 1, verified: false, history: [{ key_rev: 1, identity_key: d.identities[1].identity_key_b64u }] };
    for (const state of ['PINNED', 'CHANGED_UNACKNOWLEDGED', 'KEY_ROLLBACK'] as const) expect(plaintextMessage(v.message.body, { state, pin, canAcknowledge: false, canSendEncrypted: false, canSendPlaintext: false })).toMatchObject({ encrypted: false, marker: 'not-encrypted' });
  });
  it('removal never unlocks plaintext and malformed TOFU is rollback', () => {
    const pin: Pin = { origin, user_id: peerId, identity_key: d.identities[1].identity_key_b64u, key_rev: 1, verified: true, history: [{ key_rev: 1, identity_key: d.identities[1].identity_key_b64u }] };
    expect(evaluatePeer(pin, noKeys(peerId), origin, peerId)).toMatchObject({ state: 'CHANGED_UNACKNOWLEDGED', canSendPlaintext: false });
    expect(() => acknowledgePeer(pin, noKeys(peerId))).toThrow();
    expect(evaluatePeer(undefined, { ...noKeys(peerId), key_rev: 1 }, origin, peerId).state).toBe('KEY_ROLLBACK');
  });
});

describe('identity lifecycle through authenticated REST', () => {
  function host(initial: PublicKeys = noKeys()) {
    let keys = initial, backup: string | null = null, failBackup = false;
    const writes: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input).replace(origin, ''), body = init?.body ? JSON.parse(String(init.body)) : {};
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer session');
      expect(new Headers(init?.headers).get('X-Device-Key')).toBe('device');
      if (path === '/api/users/me/keys') return response(keys);
      if (path === '/api/me/password-check') return body.password === 'correct' ? response({ ok: true }) : response({ error: 'password required' }, 403);
      if (path === '/api/me/key-backup' && init?.method !== 'PUT') return response({ key_backup: backup });
      if (path === '/api/me/keys') { writes.push('keys'); keys = { user_id: 'me', identity_key: body.identity_key, key_rev: keys.key_rev || 1, history: [{ key_rev: keys.key_rev || 1, identity_key: body.identity_key }] }; return response({ key_rev: keys.key_rev }); }
      if (path === '/api/me/key-backup') { if (failBackup) return response({ error: 'fixture interrupted backup upload' }, 503); writes.push('backup'); backup = body.key_backup; return response({ recovery_rev: 1 }); }
      if (path === '/api/me/key-exposure') { writes.push('exposure'); return response({}); }
      throw new Error(`Unexpected route: ${path}`);
    });
    vi.stubGlobal('fetch', fetch); const api = new Api(origin); api.authenticate({ token: 'session', device_key: 'device' });
    return { remote: new SecurityApi(api), writes, failBackup: (fail: boolean) => { failBackup = fail; }, setBackup: (b: string) => { backup = b; } };
  }
  it('survives restart before confirmation with no publish; only a real word challenge unlocks publication', async () => {
    const h = host(), vault = nativeMemory();
    let service = new IdentityService(vault, h.remote, origin, 'me'); await service.bootstrap(); service.acknowledgeNotice('security-introduction'); await service.beginCreation();
    expect(h.writes).toEqual([]); await expect(service.publish()).rejects.toThrow('confirmed');
    const before = await vault.loadIdentity(); service = new IdentityService(vault, h.remote, origin, 'me'); expect((await service.bootstrap()).phase).toBe('pending-confirmation'); expect((await vault.loadIdentity())?.seed).toEqual(before?.seed);
    const words = (await service.showWords()).split(' '), positions = service.confirmationChallenge();
    expect(await service.confirmWords(['wrong', 'wrong'])).toBe(false); await expect(service.publish()).rejects.toThrow('confirmed');
    await service.showWords(); const next = service.confirmationChallenge(); expect(next.every(n => !positions.includes(n))).toBe(true);
    expect(await service.confirmWords([words[next[0] - 1], words[next[1] - 1]])).toBe(true);
    await service.publish(); expect(h.writes).toEqual(['keys', 'backup']); expect(service.snapshot().phase).toBe('ready');
  });
  it('repairs interrupted confirmed publication after service recreation and exposes a retryable startup failure', async () => {
    const h = host(), vault = nativeMemory();
    const first = new IdentityService(vault, h.remote, origin, 'me'); await first.bootstrap(); first.acknowledgeNotice('security-introduction'); await first.beginCreation();
    const words = (await first.showWords()).split(' '), positions = first.confirmationChallenge();
    expect(await first.confirmWords([words[positions[0] - 1], words[positions[1] - 1]])).toBe(true);
    h.failBackup(true); await expect(first.publish()).rejects.toThrow('interrupted'); expect(h.writes).toEqual(['keys']);
    const resumed = new IdentityService(vault, h.remote, origin, 'me');
    await expect(resumed.bootstrap()).rejects.toThrow('interrupted'); expect(resumed.snapshot().phase).toBe('backup-pending');
    h.failBackup(false); expect((await resumed.bootstrap()).phase).toBe('ready'); expect(h.writes).toEqual(['keys', 'backup']);
    const local = (await vault.loadIdentity())!;
    const { wordsToRecoveryKey, openBackup } = await import('../src/crypto/backup');
    const r = unwrap(wordsToRecoveryKey(words.join(' ')));
    const opened = unwrap(openBackup(unwrap(unb64u((await h.remote.backup()).key_backup)), r, publicIdentityKey(local.seed)));
    expect(opened).toEqual(local.seed); opened.fill(0); r.fill(0); local.seed.fill(0);
  });
  it('repairs older same-key backups, preserves newer/corrupt/substituted backups and never publishes unconfirmed or mismatching local identities', async () => {
    const key = b64u(publicIdentityKey(seed));
    const h = host({ user_id: 'me', identity_key: key, key_rev: 1, history: [{ key_rev: 1, identity_key: key }] });
    const vault = nativeMemory(); await vault.saveIdentity({ seed, recoveryRev: 2, confirmed: true });
    const service = new IdentityService(vault, h.remote, origin, 'me');
    h.setBackup(b64u(sealBackup(seed, 1))); expect((await service.bootstrap()).phase).toBe('ready'); expect(h.writes).toEqual(['backup']);
    h.writes.length = 0; h.setBackup(b64u(sealBackup(seed, 3))); expect((await service.bootstrap()).phase).toBe('recovery-ahead'); expect(h.writes).toEqual([]);
    for (const backup of ['corrupt', b64u(sealBackup(new Uint8Array(32).fill(99), 1)), b64u(sealBackup(new Uint8Array(32).fill(99), 2))]) {
      h.setBackup(backup); await expect(service.bootstrap()).rejects.toThrow(); expect(h.writes).toEqual([]); expect(service.snapshot().phase).toBe('backup-pending');
    }
    await vault.saveIdentity({ seed, recoveryRev: 2, confirmed: false }); expect((await service.bootstrap()).phase).toBe('pending-confirmation'); expect(h.writes).toEqual([]);
    await vault.saveIdentity({ seed: new Uint8Array(32).fill(99), recoveryRev: 2, confirmed: true }); expect((await service.bootstrap()).phase).toBe('collision'); expect(h.writes).toEqual([]);
  });
  it('serializes simultaneous host setup and rejects stale word challenges after another explicit reset', async () => {
    const h = host(), vault = nativeMemory(), first = new IdentityService(vault, h.remote, origin, 'me'), second = new IdentityService(vault, h.remote, origin, 'me');
    await first.bootstrap(); await second.bootstrap(); first.acknowledgeNotice('security-introduction'); second.acknowledgeNotice('security-introduction');
    const results = await Promise.allSettled([first.beginCreation(), second.beginCreation()]); expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1); expect(h.writes).toEqual([]);
    const words = (await first.showWords()).split(' '), positions = first.confirmationChallenge();
    second.acknowledgeNotice('reset-loses-history'); await second.beginReset('correct');
    await expect(first.confirmWords([words[positions[0] - 1], words[positions[1] - 1]])).rejects.toThrow('challenge changed');
    await expect(first.publish()).rejects.toThrow('confirmed'); expect(h.writes).toEqual([]);
  });
  it('web refuses generation/words/reset/replace, gates import and reports exposure', async () => {
    const key = b64u(publicIdentityKey(seed)), h = host({ user_id: 'me', identity_key: key, key_rev: 1, history: [{ key_rev: 1, identity_key: key }] });
    h.setBackup(b64u(sealBackup(seed, 1))); const vault = new IdentityStorage(), service = new IdentityService(vault, h.remote, origin, 'me'); await service.bootstrap();
    for (const action of [() => service.beginCreation(), () => service.showWords(), () => service.beginReset('correct'), () => service.replaceRecovery('correct')]) await expect(action()).rejects.toThrow('Native');
    const r = recoveryKey(seed, 1), words = recoveryWords(r); r.fill(0);
    await expect(service.importRecovery(words)).rejects.toThrow('warning'); expect(await vault.loadIdentity()).toBeNull();
    service.acknowledgeNotice('browser-exposure'); await service.importRecovery(words); expect((await vault.loadIdentity())?.seed).toEqual(seed); expect(h.writes).toEqual(['exposure']); expect(service.snapshot().storage).toBe('memory-web');
  });
  it('rejects a substituted backup without storing any identity', async () => {
    const key = b64u(publicIdentityKey(seed)), h = host({ user_id: 'me', identity_key: key, key_rev: 1, history: [{ key_rev: 1, identity_key: key }] });
    const other = bytes(d.identities[1].seed); h.setBackup(b64u(sealBackup(other, 1)));
    const vault = new IdentityStorage(), service = new IdentityService(vault, h.remote, origin, 'me'); service.acknowledgeNotice('browser-exposure');
    await expect(service.importRecovery(recoveryWords(recoveryKey(other, 1)))).rejects.toThrow(); expect(await vault.loadIdentity()).toBeNull(); expect(h.writes).toEqual([]);
  });
  it('pending recovery replacement retains its password gate across restart', async () => {
    const key = b64u(publicIdentityKey(seed)), h = host({ user_id: 'me', identity_key: key, key_rev: 1, history: [{ key_rev: 1, identity_key: key }] });
    h.setBackup(b64u(sealBackup(seed, 1)));
    const vault = nativeMemory(); await vault.saveIdentity({ seed, recoveryRev: 1, confirmed: true });
    const service = new IdentityService(vault, h.remote, origin, 'me'); await service.bootstrap(); service.acknowledgeNotice('replace-does-not-revoke-leaked-words'); await service.replaceRecovery('correct');
    const resumed = new IdentityService(vault, h.remote, origin, 'me'); expect((await resumed.bootstrap()).phase).toBe('pending-confirmation');
    await expect(resumed.showWords()).rejects.toThrow('Password'); await expect(resumed.showWords('wrong')).rejects.toThrow('password');
    const words = (await resumed.showWords('correct')).split(' '), positions = resumed.confirmationChallenge();
    expect(h.writes).toEqual([]); expect(await resumed.confirmWords([words[positions[0] - 1], words[positions[1] - 1]])).toBe(true); await resumed.publish();
    expect(unwrap(parseBackup(unwrap(unb64u((await h.remote.backup()).key_backup)))).recoveryRev).toBe(2);
  });
  it('requires password and leak warning for recovery replacement; refuses stale recovery words', async () => {
    const key = b64u(publicIdentityKey(seed)), h = host({ user_id: 'me', identity_key: key, key_rev: 1, history: [{ key_rev: 1, identity_key: key }] });
    h.setBackup(b64u(sealBackup(seed, 1)));
    const vault = nativeMemory(); await vault.saveIdentity({ seed, recoveryRev: 1, confirmed: true }); const service = new IdentityService(vault, h.remote, origin, 'me'); await service.bootstrap();
    await expect(service.replaceRecovery('correct')).rejects.toThrow('Notice'); service.acknowledgeNotice('replace-does-not-revoke-leaked-words'); await expect(service.replaceRecovery('wrong')).rejects.toThrow('password');
    h.setBackup(b64u(sealBackup(new Uint8Array(32).fill(93), 2))); await expect(service.replaceRecovery('correct')).rejects.toThrow(); expect((await vault.loadIdentity())?.recoveryRev).toBe(1);
    h.setBackup(b64u(sealBackup(seed, 2))); expect((await service.bootstrap()).phase).toBe('recovery-ahead'); await expect(service.showWords('correct')).rejects.toThrow('Current'); await service.replaceRecovery('correct'); expect(service.snapshot().phase).toBe('pending-confirmation'); expect((await vault.loadIdentity())?.recoveryRev).toBe(3); expect(h.writes).toEqual([]);
  });
});

describe('native vault boundary', () => {
  it('matches plugin DTOs, isolates pins by origin/account, preserves install key on sign-out', async () => {
    const records = new Map<string, unknown>();
    const invoke = vi.fn(async <T>(name: string, args?: Record<string, unknown>): Promise<T> => {
      const key = JSON.stringify([args?.origin, args?.userId]); let value: unknown;
      if (name.endsWith('|identity_get')) value = { identity: records.get('identity') ?? null };
      else if (name.endsWith('|identity_set')) { records.set('identity', args?.identity); value = { ok: true }; }
      else if (name.endsWith('|identity_remove')) { records.delete('identity'); value = { ok: true }; }
      else if (name.endsWith('|pins_get')) value = { pins: records.get(key) ?? [] };
      else if (name.endsWith('|pins_set')) { records.set(key, args?.pins); value = { ok: true }; }
      else if (name.endsWith('|remove')) value = { ok: true };
      else throw new Error('Unknown command');
      return value as T;
    });
    vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke } });
    const vault = new IdentityStorage(invoke as <T>(name: string, args?: Record<string, unknown>) => Promise<T>); await vault.saveIdentity({ seed, recoveryRev: 1, confirmed: false }); expect(vault.availability).toBe('secure');
    const pin: Pin = { origin, user_id: peerId, identity_key: d.identities[1].identity_key_b64u, key_rev: 1, verified: true, history: [{ key_rev: 1, identity_key: d.identities[1].identity_key_b64u }] };
    await vault.savePins(origin, 'me', [pin]); expect(await vault.loadPins(origin, 'me')).toEqual([pin]); expect(await vault.loadPins(origin, 'other')).toEqual([]);
    await secureSession.remove(origin); expect((await vault.loadIdentity())?.seed).toEqual(seed);
    await vault.removeIdentity(); expect(await vault.loadIdentity()).toBeNull(); expect(await vault.loadPins(origin, 'me')).toEqual([pin]);
  });
  it('inaccessible native store fails distinctly from empty; no browser/file fallback', async () => {
    const vault = new IdentityStorage(async () => { throw new Error('locked'); });
    await expect(vault.loadIdentity()).rejects.toThrow('unavailable'); expect(vault.availability).toBe('memory-unavailable');
    await expect(vault.saveIdentity({ seed, recoveryRev: 1, confirmed: true })).rejects.toThrow();
  });
});

it('multi-host coordinator keeps one install key and synchronizes confirmed recovery backups to every registered host', async () => {
  const hostB = 'https://second.example.test', key = b64u(publicIdentityKey(seed));
  const views = new Map<string, PublicKeys>([[origin, { user_id: 'me', key_rev: 1, identity_key: key, history: [{ key_rev: 1, identity_key: key }] }], [hostB, noKeys()]]);
  const backups = new Map<string, string>(), writes: string[] = [];
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const url = new URL(input), body = init?.body ? JSON.parse(String(init.body)) : {};
    if (url.pathname.startsWith('/api/users/')) return response(views.get(url.origin));
    if (url.pathname === '/api/me/password-check') return response({ ok: true });
    if (url.pathname === '/api/me/keys') { views.set(url.origin, { user_id: 'me', identity_key: body.identity_key, key_rev: 1, history: [{ key_rev: 1, identity_key: body.identity_key }] }); writes.push(url.origin); return response({ key_rev: 1 }); }
    if (init?.method === 'PUT') { backups.set(url.origin, body.key_backup); return response({ recovery_rev: 1 }); }
    return response({ key_backup: backups.get(url.origin) ?? null });
  });
  const vault = nativeMemory(); await vault.saveIdentity({ seed, recoveryRev: 1, confirmed: true });
  const one = new IdentityService(vault, new SecurityApi(new Api(origin)), origin, 'me'), two = new IdentityService(vault, new SecurityApi(new Api(hostB)), hostB, 'me');
  const coordinator = new IdentityCoordinator(); coordinator.register(one); coordinator.register(two);
  expect((await coordinator.synchronize()).map(r => r.outcome)).toEqual(['synced', 'action-required']); expect(views.get(hostB)?.key_rev).toBe(0);
  two.acknowledgeNotice('cross-host-linkability'); expect((await coordinator.synchronize()).every(r => r.outcome === 'synced')).toBe(true); expect(views.get(hostB)?.identity_key).toBe(key);
  one.acknowledgeNotice('replace-does-not-revoke-leaked-words'); await one.replaceRecovery('correct'); const before = writes.length;
  expect((await coordinator.synchronize()).every(r => r.outcome === 'action-required')).toBe(true); expect(writes).toHaveLength(before);
  const words = (await one.showWords()).split(' '), positions = one.confirmationChallenge(); expect(await one.confirmWords([words[positions[0] - 1], words[positions[1] - 1]])).toBe(true);
  expect((await coordinator.synchronize()).every(r => r.outcome === 'synced')).toBe(true);
  for (const host of [origin, hostB]) expect(unwrap(parseBackup(unwrap(unb64u(backups.get(host))))).recoveryRev).toBe(2);
});
