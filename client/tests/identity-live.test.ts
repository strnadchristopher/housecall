/** Parent-run only: real HTTP against the existing isolated server fixture. Starts no processes.
 * Never included in npm test. Requires a fresh, disposable loopback server. */
import { afterEach, expect, it, vi } from 'vitest';
import { Api, ApiError } from '../src/transport/api';
import { SecurityApi } from '../src/adapters/legacy/security';
import { IdentityService } from '../src/core/identityService';
import { DmService } from '../src/adapters/legacy/dm';
import { ReceivingLink, ShowingLink } from '../src/core/linkService';
import { b64u, publicIdentityKey } from '../src/crypto/identity';
import { sealBackup } from '../src/crypto/backup';
import { IdentityStorage } from '../src/transport/identityStorage';
import type { Auth } from '../src/data/types';
import type { DmContext, SecureMessageRow } from '../src/core/dm';
// Native platform stand-in is test-only; production fallback checks the actual bridge.
const nativeMemory = () => Object.assign(new IdentityStorage(), { native: true, availability: 'memory-unavailable' as const });
const origin = process.env.HOUSECALL_IDENTITY_TEST_ORIGIN;
const password = 'Identity integration fixture password 47!';
afterEach(() => { vi.unstubAllGlobals(); });

it('live identity publication, DM encryption/edit/file, pin hold/reset and QR session transfer', async () => {
  if (!origin || process.env.HOUSECALL_IDENTITY_LIVE_DISPOSABLE !== '1' || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname)) throw new Error('Use a fresh disposable loopback fixture and set HOUSECALL_IDENTITY_TEST_ORIGIN plus HOUSECALL_IDENTITY_LIVE_DISPOSABLE=1');
  const ownerApi = new Api(origin);
  // Same synthetic bootstrap value used by tests/start-server.mjs; never read production credentials.
  const owner = await ownerApi.post<Auth>('/api/setup', { setup_token: 'test-setup-token-at-least-32-characters', username: 'identityalice', password, device_name: 'Identity live owner' }); ownerApi.authenticate(owner);
  const invite = await ownerApi.post<{ token: string }>('/api/invites', {}), peerApi = new Api(origin);
  const peer = await peerApi.post<Auth>('/api/invites/accept', { token: invite.token, username: 'identitybob', password, device_name: 'Identity live peer' }); peerApi.authenticate(peer);
  const ownerVault = nativeMemory(), peerVault = nativeMemory();
  const ownerIdentity = new IdentityService(ownerVault, new SecurityApi(ownerApi), origin, owner.user.id), peerIdentity = new IdentityService(peerVault, new SecurityApi(peerApi), origin, peer.user.id);
  async function confirm(service: IdentityService) { const words = (await service.showWords()).split(' '), positions = service.confirmationChallenge(); expect(await service.confirmWords([words[positions[0] - 1], words[positions[1] - 1]])).toBe(true); }
  for (const service of [ownerIdentity, peerIdentity]) {
    await service.bootstrap(); service.acknowledgeNotice('security-introduction'); await service.beginCreation();
    // Verify the host itself still has no key before word confirmation.
    expect((await service.remote.keys(service.userId)).key_rev).toBe(0); await expect(service.publish()).rejects.toThrow();
    await confirm(service); await service.publish(); expect((await service.remote.keys(service.userId)).key_rev).toBe(1);
  }
  // Actual interrupted service/API publication: let the public-key PUT reach the real host,
  // interrupt only the subsequent backup upload, then recreate the native service.
  const repairInvite = await ownerApi.post<{ token: string }>('/api/invites', {});
  const repairApi = new Api(origin);
  const repairAuth = await repairApi.post<Auth>('/api/invites/accept', { token: repairInvite.token, username: 'identityrepair', password, device_name: 'Interrupted backup fixture' }); repairApi.authenticate(repairAuth);
  const repairVault = nativeMemory(), repairRemote = new SecurityApi(repairApi);
  const initialRepair = new IdentityService(repairVault, repairRemote, origin, repairAuth.user.id);
  await initialRepair.bootstrap(); initialRepair.acknowledgeNotice('security-introduction'); await initialRepair.beginCreation(); await confirm(initialRepair);
  const realRequest = repairApi.request.bind(repairApi);
  repairApi.request = async <T>(path: string, options: RequestInit = {}): Promise<T> => {
    if (path === '/api/me/key-backup' && options.method === 'PUT') throw new Error('Simulated interruption after public key publication');
    return realRequest<T>(path, options);
  };
  await expect(initialRepair.publish()).rejects.toThrow('Simulated interruption');
  expect((await repairRemote.keys(repairAuth.user.id)).key_rev).toBe(1); expect((await repairRemote.backup()).key_backup).toBeNull();
  const restart = new IdentityService(repairVault, repairRemote, origin, repairAuth.user.id);
  await expect(restart.bootstrap()).rejects.toThrow('Simulated interruption'); expect(restart.snapshot().phase).toBe('backup-pending');
  repairApi.request = realRequest;
  expect((await restart.bootstrap()).phase).toBe('ready'); expect((await repairRemote.backup()).key_backup).not.toBeNull();
  // An actual interrupted replacement leaves the host's authenticated revision 1 backup intact.
  restart.acknowledgeNotice('replace-does-not-revoke-leaked-words'); await restart.replaceRecovery(password); await confirm(restart);
  const repairedAgain = new IdentityService(repairVault, repairRemote, origin, repairAuth.user.id);
  expect((await repairedAgain.bootstrap()).phase).toBe('ready');
  const repairLocal = (await repairVault.loadIdentity())!;
  expect(repairLocal.recoveryRev).toBe(2);
  const corrupt = b64u(sealBackup(new Uint8Array(32).fill(121), 2));
  await repairRemote.putBackup(corrupt);
  await expect(repairedAgain.bootstrap()).rejects.toThrow(); expect((await repairRemote.backup()).key_backup).toBe(corrupt);
  const newer = b64u(sealBackup(repairLocal.seed, 3)); await repairRemote.putBackup(newer);
  expect((await repairedAgain.bootstrap()).phase).toBe('recovery-ahead'); expect((await repairRemote.backup()).key_backup).toBe(newer);
  repairLocal.seed.fill(0);
  const dm = await ownerApi.post<{ id: string }>('/api/channels', { name: 'Identity live DM', kind: 'dm', member_ids: [peer.user.id] });
  const context: DmContext = { id: dm.id, kind: 'dm', memberIds: [owner.user.id, peer.user.id] };
  const sender = new DmService(ownerApi, ownerVault, origin, owner.user.id), receiver = new DmService(peerApi, peerVault, origin, peer.user.id);
  const row = await sender.send(context, 'actual live encrypted text');
  expect(row.enc).toBe(1); expect(row.body).not.toContain('actual live');
  const notices = await peerApi.get<{ notifications: { message_id: string }[] }>('/api/notifications');
  expect(notices.notifications.some(n => n.message_id === row.id)).toBe(true);
  expect(JSON.stringify(notices)).not.toContain('actual live encrypted text');
  const read = await peerApi.get<{ messages: SecureMessageRow[] }>(`/api/channels/${dm.id}/messages`);
  expect((await receiver.openHistory(context, read.messages)).get(row.id)).toMatchObject({ status: 'opened', payload: { text: 'actual live encrypted text' } });
  await expect(ownerApi.post(`/api/channels/${dm.id}/messages`, { body: 'downgrade refused' })).rejects.toMatchObject({ status: 422 });
  const edited = await sender.edit(context, row, { v: 1, text: 'live edit' }); expect(edited.envelope).not.toBe(row.envelope);
  const plaintext = new TextEncoder().encode('actual sealed file bytes'), file = await sender.uploadAttachment(context, plaintext, 'fixture.html', 'text/html');
  const withFile = await sender.send(context, 'file', [file]); const openedFile = (await receiver.openHistory(context, [withFile])).get(withFile.id)!;
  expect(await receiver.downloadAttachment(withFile, openedFile, file.id)).toMatchObject({ bytes: plaintext, disposition: 'download', mime: 'application/octet-stream' });
  peerIdentity.acknowledgeNotice('reset-loses-history'); await peerIdentity.beginReset(password); await confirm(peerIdentity); await peerIdentity.publish(password);
  expect((await sender.onKeysChanged(peer.user.id)).state).toBe('CHANGED_UNACKNOWLEDGED'); await expect(sender.send(context, 'held')).rejects.toThrow(); await sender.acknowledgeChange(peer.user.id);
  expect((await sender.security(context)).peer.state).toBe('PINNED');
  // The only OS stub is in this test file; approval still verifies the real server password.
  vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke: async (name: string) => { if (name === 'plugin:secure-session|verify_owner') return { supported: false, verified: false }; throw new Error('Unexpected native command'); } } });
  const showing = new ShowingLink(new SecurityApi(ownerApi), ownerVault, origin, () => sender.linkPins()), receivingVault = new IdentityStorage(), receiving = new ReceivingLink(receivingVault);
  await showing.start(); receiving.scan(showing.revealQr(), 'browser'); await receiving.confirmHost('Live browser receiver', true); const state = receiving.snapshot(); if (state.phase !== 'account-confirmation') throw new Error('Account confirmation missing');
  receiving.confirmAccount(); await showing.poll(); await expect(showing.submitNumber(state.code, 'wrong password')).rejects.toBeInstanceOf(ApiError); expect(showing.snapshot().phase).toBe('confirmation');
  expect(await showing.submitNumber(state.code, password)).toBe(true); const linked = await receiving.poll(); expect(linked?.user.id).toBe(owner.user.id);
  const linkedApi = new Api(origin); linkedApi.authenticate(linked); expect((await linkedApi.get<{ user: { id: string } }>('/api/me')).user.id).toBe(owner.user.id);
  expect((await receivingVault.loadIdentity())?.seed).toEqual((await ownerVault.loadIdentity())?.seed);
  expect((await new SecurityApi(ownerApi).exposures()).exposures.length).toBeGreaterThan(0);
  sender.dispose(); receiver.dispose(); await showing.cancel(); receiving.cancel();
}, 60_000);
