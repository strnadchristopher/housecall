/** Parent-run through the Rust push test's disposable loopback app + provider fixture.
 * Not included in npm test; starts no server and uses no provider credentials. */
import { expect, it } from 'vitest';
import { Api } from '../src/transport/api';
import { IdentityStorage } from '../src/transport/identityStorage';
import { IdentityService } from '../src/core/identityService';
import { SecurityApi } from '../src/adapters/legacy/security';
import { DmService } from '../src/adapters/legacy/dm';
import type { Auth } from '../src/data/types';

it('actual DmService send routes the peer notification and durable ID-only push event', async () => {
  const origin = process.env.HOUSECALL_PUSH_SERVICE_TEST_ORIGIN;
  if (!origin || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname)) throw new Error('Run only through the disposable Rust push integration fixture');
  const provider = process.env.HOUSECALL_PUSH_SERVICE_TEST_PROVIDER;
  if (provider !== 'apns' && provider !== 'fcm') throw new Error('Missing local fixture provider');
  const aliceApi = new Api(origin), bobApi = new Api(origin), password = 'Synthetic push integration password 47!';
  const alice = await aliceApi.post<Auth>('/api/setup', { setup_token: 'test-setup-token-at-least-32-characters', username: 'servicealice', password, device_name: 'Synthetic service sender' }); aliceApi.authenticate(alice);
  const invite = await aliceApi.post<{ token: string }>('/api/invites', {});
  const bob = await bobApi.post<Auth>('/api/invites/accept', { token: invite.token, username: 'servicebob', password, device_name: 'Synthetic service recipient' }); bobApi.authenticate(bob);
  await bobApi.put('/api/push/device', { provider, token: '1'.repeat(64) });
  const vaults = [aliceApi, bobApi].map(() => Object.assign(new IdentityStorage(), { native: true, availability: 'memory-unavailable' as const }));
  for (const [index, api] of [aliceApi, bobApi].entries()) {
    const identity = new IdentityService(vaults[index], new SecurityApi(api), origin, [alice, bob][index].user.id);
    await identity.bootstrap(); identity.acknowledgeNotice('security-introduction'); await identity.beginCreation();
    const words = (await identity.showWords()).split(' '), positions = identity.confirmationChallenge();
    expect(await identity.confirmWords([words[positions[0] - 1], words[positions[1] - 1]])).toBe(true); await identity.publish();
  }
  const dm = await aliceApi.post<{ id: string }>('/api/channels', { name: 'service push integration', kind: 'dm', member_ids: [bob.user.id] });
  const sender = new DmService(aliceApi, vaults[0], origin, alice.user.id);
  const text = 'sealed service notification fixture';
  const row = await sender.send({ id: dm.id, kind: 'dm', memberIds: [alice.user.id, bob.user.id] }, text);
  expect(row.enc).toBe(1); expect(row.body).toBe('Encrypted message. Update Housecall to read it.');
  const notices = await bobApi.get<{ notifications: { message_id: string }[] }>('/api/notifications');
  expect(notices.notifications.some(n => n.message_id === row.id)).toBe(true); expect(JSON.stringify(notices)).not.toContain(text);
  const events = await bobApi.get<{ events: { message_id: string; kind: string }[] }>('/api/push/events');
  expect(events.events).toHaveLength(1); expect(events.events[0]).toMatchObject({ message_id: row.id, kind: 'alert' });
  expect(JSON.stringify(events)).not.toContain(text); expect(JSON.stringify(events)).not.toContain(row.envelope!);
  sender.dispose();
}, 60_000);
