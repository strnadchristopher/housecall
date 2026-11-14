import { afterEach, describe, expect, it, vi } from 'vitest';
import vectors from './vectors/dm-v1.json';
import { DmService } from '../src/adapters/legacy/dm';
import { IdentityStorage } from '../src/transport/identityStorage';
import { Api } from '../src/transport/api';
import { b64u, deriveIdentity, publicIdentityKey, unb64u } from '../src/crypto/identity';
import { conversationKey, parseEnvelope, sealMessage } from '../src/crypto/dm';
import { unwrap } from '../src/crypto/common';
import type { DmContext, SecureMessageRow } from '../src/core/dm';
import type { PublicKeys } from '../src/core/security';
// Native platform stand-in is test-only; production fallback checks the actual bridge.
const nativeMemory = () => Object.assign(new IdentityStorage(), { native: true, availability: 'memory-unavailable' as const });
const d: any = vectors, origin = 'https://chat.example.test';
const h = (s: string) => new Uint8Array(Buffer.from(s, 'hex'));
const alice = d.user_ids.alice, bob = d.user_ids.bob;
const context: DmContext = { id: d.channel_id, kind: 'dm', memberIds: [alice, bob] };
const seeds: Record<string, Uint8Array> = { [alice]: h(d.identities[0].seed), [bob]: h(d.identities[1].seed) };
const publicKeys = (id: string, seed = seeds[id], rev = 1): PublicKeys => { const key = b64u(publicIdentityKey(seed)); return { user_id: id, identity_key: key, key_rev: rev, history: [{ key_rev: rev, identity_key: key }] }; };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
afterEach(() => { vi.unstubAllGlobals(); });
async function fixture() {
  const keys = new Map([[alice, publicKeys(alice)], [bob, publicKeys(bob)]]), rows: SecureMessageRow[] = [], uploads = new Map<string, Uint8Array>(); let uploadId = 0;
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : undefined, path = new URL(request?.url ?? String(input)).pathname;
    const headers = new Headers(request?.headers ?? init?.headers);
    expect(headers.get('Authorization')).toBe('Bearer session'); expect(headers.get('X-Device-Key')).toBe('device');
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    if (path.startsWith('/api/users/')) return json(keys.get(decodeURIComponent(path.split('/')[3])));
    if (path === `/api/channels/${context.id}/messages`) {
      const row: SecureMessageRow = { id: `message-${rows.length}`, channel_id: context.id, author_id: alice, body: body?.body ?? '', ...body, revision: 1, attachments: body?.attachment_ids?.map((id: string) => ({ id })) }; rows.push(row); return json(row);
    }
    if (path.startsWith('/api/messages/')) { const row = rows.find(r => r.id === path.split('/').at(-1))!; Object.assign(row, body, { revision: 2, edited_at: Date.now() }); return json(row); }
    if (path === '/api/uploads') { expect(body.class).toBe('sealed'); expect(body.filename).toBe('sealed'); const id = `00000000-0000-0000-0000-${String(++uploadId).padStart(12, '0')}`; uploads.set(id, new Uint8Array()); return json({ id, offset: '0', length: body.length, status: 'uploading' }); }
    if (path.startsWith('/api/uploads/')) { const id = path.split('/')[3]; if (path.endsWith('/complete')) return json({ id, offset: String(uploads.get(id)!.length), status: 'ready' }); const chunk = new Uint8Array(await (init!.body as Blob).arrayBuffer()); uploads.set(id, chunk); return json({ id, offset: String(chunk.length), status: 'uploading' }); }
    if (path.startsWith('/api/media/')) return new Response(uploads.get(path.split('/').at(-1)!)!.slice());
    throw new Error(`Unexpected route ${path}`);
  });
  vi.stubGlobal('fetch', fetch);
  const api = new Api(origin); api.authenticate({ token: 'session', device_key: 'device' });
  const vault = nativeMemory(); await vault.saveIdentity({ seed: seeds[alice], recoveryRev: 1, confirmed: true });
  const receiverVault = new IdentityStorage(); await receiverVault.saveIdentity({ seed: seeds[bob], recoveryRev: 1, confirmed: true });
  return { keys, rows, fetch, vault, sender: new DmService(api, vault, origin, alice), receiver: new DmService(api, receiverVault, origin, bob) };
}
describe('DM service using actual REST adapter and crypto', () => {
  it('seals outgoing, opens incoming, edits with a fresh nonce, binds replies and detects edited quotes', async () => {
    const { sender, receiver } = await fixture();
    const target = await sender.send(context, 'hello'); expect(target.body).toBe(''); expect(target.envelope).not.toContain('hello');
    const openedTarget = (await sender.openHistory(context, [target])).get(target.id)!; expect(openedTarget.status).toBe('opened');
    const reply = await sender.send(context, 'yes', [], { row: target, opened: openedTarget });
    let history = await receiver.openHistory(context, [target, reply]); expect(history.get(reply.id)).toMatchObject({ status: 'opened', reply: 'authenticated', payload: { text: 'yes' } });
    const oldNonce = unwrap(parseEnvelope(target.envelope)).nonce;
    const edited = await sender.edit(context, target, { v: 1, text: 'edited' }); expect(unwrap(parseEnvelope(edited.envelope)).nonce).not.toEqual(oldNonce);
    history = await receiver.openHistory(context, [edited, reply]); expect(history.get(reply.id)).toMatchObject({ status: 'opened', reply: 'edited' });
    history = await receiver.openHistory(context, [edited, { ...reply, reply_to: null }]); expect(history.get(reply.id)).toMatchObject({ reply: 'unchecked' });
  });
  it('deduplicates before presentation, authenticates sender/channel and labels all plaintext rows', async () => {
    const { sender, receiver } = await fixture(); const row = await sender.send(context, 'sealed');
    const history = await receiver.openHistory(context, [row, { ...row, id: 'replayed' }, { ...row, id: 'relabeled', author_id: bob }, { ...row, id: 'wrong-channel', channel_id: 'other' }, { ...row, id: 'plain', enc: 0, envelope: null, body: 'host wrote this' }]);
    expect(history.get(row.id)?.status).toBe('opened'); expect(history.get('replayed')?.status).toBe('duplicate'); expect(history.get('relabeled')?.status).toBe('failed'); expect(history.get('wrong-channel')?.status).toBe('failed'); expect(history.get('plain')).toMatchObject({ status: 'plaintext', marker: 'not-encrypted', encrypted: false });
  });
  it('holds real new revisions until refreshed acknowledgement, opens pinned old history during rollback, never downgrades', async () => {
    const { sender, receiver, keys } = await fixture(); const old = await sender.send(context, 'old'); await receiver.openHistory(context, [old]);
    const changedSeed = new Uint8Array(32).fill(27), prior = keys.get(alice)!; const next = publicKeys(alice, changedSeed, 2); next.history.unshift(...prior.history); keys.set(alice, next);
    const myIdentity = deriveIdentity(changedSeed), key = conversationKey({ channelId: context.id, myId: alice, peerId: bob, myIdentity, peerIdentityKey: publicIdentityKey(seeds[bob]) });
    const newer: SecureMessageRow = { ...old, id: 'new', envelope: b64u(sealMessage({ key, channelId: context.id, senderId: alice, recipientId: bob, senderKeyRev: 2, recipientKeyRev: 1, payload: { v: 1, text: 'new' } })) };
    let history = await receiver.openHistory(context, [old, newer]); expect(history.get(old.id)?.status).toBe('opened'); expect(history.get(newer.id)?.status).toBe('held');
    await expect(receiver.send(context, 'blocked')).rejects.toThrow(); await receiver.acknowledgeChange(alice);
    history = await receiver.openHistory(context, [old, newer]); expect(history.get(newer.id)?.status).toBe('opened');
    keys.set(alice, prior); expect((await receiver.onKeysChanged(alice)).state).toBe('KEY_ROLLBACK'); await expect(receiver.acknowledgeChange(alice)).rejects.toThrow(); expect((await receiver.openHistory(context, [old])).get(old.id)?.status).toBe('opened');
    keys.set(alice, { user_id: alice, key_rev: 0, identity_key: null, history: [] }); await receiver.onKeysChanged(alice); await receiver.acknowledgeChange(alice); await expect(receiver.send(context, 'no plaintext')).rejects.toThrow();
  });
  it('fake high revisions trigger only one key fetch and do not raise a change banner', async () => {
    const { sender, receiver, fetch } = await fixture(); const row = await sender.send(context, 'hello'); await receiver.openHistory(context, [row]);
    const blob = unwrap(unb64u(row.envelope)); blob.set([0, 0, 3, 231], 1); const fake = { ...row, envelope: b64u(blob) }; const before = fetch.mock.calls.length;
    expect((await receiver.openHistory(context, [fake])).get(row.id)?.status).toBe('failed'); const count = fetch.mock.calls.length; expect(count).toBe(before + 1);
    await receiver.openHistory(context, [fake]); expect(fetch.mock.calls.length).toBe(count); expect((await receiver.security(context)).peer.state).toBe('PINNED');
  });
  it('never backfills a missing old peer revision or uses a missing private identity', async () => {
    const { sender, receiver, keys, vault } = await fixture();
    const prior = keys.get(alice)!; const newKey = publicKeys(alice, seeds[alice], 2); keys.set(alice, newKey); await receiver.refresh(alice);
    const row = await sender.send(context, 'hello'); const blob = unwrap(unb64u(row.envelope)); blob.set([0, 0, 0, 1], 1);
    keys.set(alice, { ...newKey, history: [{ key_rev: 1, identity_key: d.identities[2].identity_key_b64u }, ...newKey.history] });
    await receiver.onKeysChanged(alice); expect((await receiver.openHistory(context, [{ ...row, envelope: b64u(blob) }])).get(row.id)?.status).toBe('unchecked-peer-key');
    await vault.removeIdentity(); expect((await sender.openHistory(context, [row])).get(row.id)?.status).toBe('locked'); expect(prior.key_rev).toBe(1);
  });
  it('encrypts/upload/downloads sealed files; HTML/SVG are download-only; membership and tampering fail', async () => {
    const { sender, receiver, rows } = await fixture(); const plaintext = new TextEncoder().encode('<script>hostile</script>');
    const file = await sender.uploadAttachment(context, plaintext, '../evil.html', 'text/html'); const row = await sender.send(context, '', [file]);
    const opened = (await receiver.openHistory(context, rows)).get(row.id)!;
    const downloaded = await receiver.downloadAttachment(row, opened, file.id); expect(downloaded.bytes).toEqual(plaintext); expect(downloaded).toMatchObject({ disposition: 'download', mime: 'application/octet-stream', scanned: false }); expect(downloaded.name).not.toContain('/');
    await expect(receiver.downloadAttachment({ ...row, attachments: [] }, opened, file.id)).rejects.toThrow('not in message');
    await expect(sender.send({ ...context, kind: 'group_dm' }, 'group')).rejects.toThrow('exactly two'); await expect(sender.send({ ...context, memberIds: [alice, bob, 'third'] }, 'group')).rejects.toThrow('exactly two');
  });
  it('discards in-flight key fetches after account teardown and rejects later use of the old service', async () => {
    const f = await fixture(); let release!: () => void; const paused = new Promise<void>(resolve => { release = resolve; });
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => { await paused; return f.fetch(input, init); });
    const pending = f.receiver.refresh(alice, true); f.receiver.dispose(); release();
    await expect(pending).rejects.toThrow('session ended'); await expect(f.receiver.send(context, 'stale account draft')).rejects.toThrow('session ended');
  });
  it('requires current matching own key and exposes safety verification only for pinned peers', async () => {
    const { sender, keys } = await fixture(); await sender.refresh(bob); const safety = await sender.safety(bob); expect(safety?.verified).toBe(false); await sender.markVerified(bob, safety!.number); expect((await sender.safety(bob))?.verified).toBe(true);
    await expect(sender.markVerified(bob, 'wrong')).rejects.toThrow(); keys.set(alice, publicKeys(alice, new Uint8Array(32).fill(32), 2)); await sender.onKeysChanged(alice); await expect(sender.send(context, 'must not seal')).rejects.toThrow();
  });
});
