import { describe, expect, it } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import raw from './vectors/dm-v1.json';
import { concat, unwrap, utf8 } from '../src/crypto/common';
import { deriveIdentity } from '../src/crypto/identity';
import { conversationKey, inlineMimeAllowed, NonceSet, openAttachment, openFile, openMessage, pad, parseEnvelope, safeDownloadName, sealFile, sealMessage, unpad, validateFileRef, validatePayload } from '../src/crypto/dm';
const d: any = raw;
const h = (s: string) => new Uint8Array(Buffer.from(s, 'hex'));
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const key = h(d.conversation.conversation_key);
const context = { key, channelId: d.channel_id, senderId: d.user_ids.alice, recipientId: d.user_ids.bob };
const plainFile = Uint8Array.from({ length: d.attachment.plaintext_length }, (_, i) => (i * 31 + 7) % 256);
const file = sealFile(h(d.attachment.file_key), plainFile, () => h(d.attachment.nonce_prefix));
describe('DM-V1 vectors', () => {
  it('derives both directions of the conversation key', () => {
    for (const [me, peer] of [[0, 1], [1, 0]]) {
      const mine = d.identities[me], theirs = d.identities[peer];
      expect(hex(conversationKey({ channelId: d.channel_id, myId: d.user_ids[mine.name], myIdentity: deriveIdentity(h(mine.seed)), peerId: d.user_ids[theirs.name], peerIdentityKey: h(theirs.identity_key_hex) }))).toBe(d.conversation.conversation_key);
    }
  });
  for (const v of d.messages) it(v.name, () => {
    const c = { ...context, senderId: v.sender_id, recipientId: v.recipient_id };
    const blob = sealMessage({ ...c, senderKeyRev: v.sender_key_rev, recipientKeyRev: v.recipient_key_rev, payload: v.payload, rng: () => h(v.nonce) });
    expect(hex(blob)).toBe(v.envelope_hex); expect(hex(pad(h(v.plaintext_json_utf8_hex)))).toBe(v.padded_hex);
    expect(unwrap(openMessage({ ...c, envelope: blob })).payload).toEqual(v.payload);
    expect(unwrap(openMessage({ ...c, envelope: v.envelope_b64u })).payload).toEqual(v.payload);
  });
  for (const v of d.negative.filter((n: any) => n.kind === 'message')) it(v.name, () => {
    expect(openMessage({ key: h(v.key_hex ?? d.conversation.conversation_key), channelId: v.channel_id ?? d.channel_id, senderId: v.sender_id ?? context.senderId, recipientId: v.recipient_id ?? context.recipientId, envelope: h(v.envelope_hex) }).ok).toBe(false);
  });
  it('matches the multi-chunk file and empty file vectors', () => {
    expect(file.length).toBe(d.attachment.blob_length); expect(hex(sha256(file))).toBe(d.attachment.blob_sha256);
    expect(hex(file.slice(0, 64))).toBe(d.attachment.blob_first_64_hex); expect(hex(file.slice(-32))).toBe(d.attachment.blob_last_32_hex);
    expect(unwrap(openFile(h(d.attachment.file_key), file))).toEqual(plainFile);
    const empty = sealFile(h(d.attachment.file_key), new Uint8Array(), () => h(d.attachment.nonce_prefix));
    expect(hex(empty)).toBe(d.attachment.empty_file_blob_hex); expect(unwrap(openFile(h(d.attachment.file_key), empty)).length).toBe(0);
  });
  for (const v of d.negative.filter((n: any) => n.kind === 'file')) it(v.name, () => {
    let blob: Uint8Array = file.slice();
    if (v.cut_at !== undefined) blob = blob.slice(0, v.cut_at);
    if (v.swap_chunks) {
      const size = 65552, body = blob.slice(20), header = blob.slice(0, 20);
      blob = concat(header, body.slice(size, size * 2), body.slice(0, size), body.slice(size * 2));
    }
    if (v.set_byte) blob[v.set_byte[0]] = v.set_byte[1];
    expect(openFile(h(v.file_key_hex), blob).ok).toBe(false);
  });
  for (const v of d.negative.filter((n: any) => n.kind === 'replay')) it(v.name, () => {
    const opened = unwrap(openMessage({ ...context, envelope: h(v.envelope_hex) }));
    const nonces = new NonceSet(); expect(nonces.accept(opened.nonce)).toBe(true); expect(nonces.accept(opened.nonce)).toBe(false); nonces.clear(); expect(nonces.accept(opened.nonce)).toBe(true);
  });
  // All nine core pin/reply/plaintext vectors run in identity-core.test.ts.
});
describe('DM boundary checks', () => {
  it('uses a fresh nonce for every message/edit', () => {
    const args = { ...context, senderKeyRev: 1, recipientKeyRev: 1, payload: { v: 1 as const, text: 'synthetic' } };
    expect(sealMessage(args)).not.toEqual(sealMessage(args));
    expect(() => sealMessage({ ...args, senderKeyRev: 0 })).toThrow();
  });
  it('validates payload and file fields without partial output', () => {
    const ref = d.messages[2].payload.files[0];
    for (const patch of [{ size: -1 }, { size: 0.5 }, { w: 16385 }, { h: 0 }, { id: '../../' }, { mime: 'text/html;foo=bar' }, { name: '' }, { name: 'é'.repeat(128) }, { key: 'AB' }]) expect(validateFileRef({ ...ref, ...patch }).ok).toBe(false);
    for (const v of [null, [], 1, { v: 1, text: 'x', files: null }, { v: 1, text: 'x', re: null }, { v: 1, text: 'x'.repeat(16384) }]) expect(validatePayload(v).ok).toBe(false);
    expect(unwrap(validatePayload({ v: 1, text: 'x', future: true }))).toEqual({ v: 1, text: 'x' });
  });
  it('rejects oversized authenticated payloads including unknown fields and invalid UTF-8', () => {
    const e = unwrap(parseEnvelope(d.messages[0].envelope_b64u));
    const ad = h(d.messages[0].associated_data_hex);
    const badUtf8 = new Uint8Array(256); badUtf8.set([255, 128]);
    const extra = utf8(JSON.stringify({ v: 1, text: 'x', ignored: 'y'.repeat(16400) }));
    const padded = new Uint8Array(16640); padded.set(extra); padded[extra.length] = 128;
    for (const p of [badUtf8, padded]) {
      const blob = concat(e.header, e.nonce, xchacha20poly1305(key, e.nonce, ad).encrypt(p));
      expect(openMessage({ ...context, envelope: blob }).ok).toBe(false);
    }
  });
  it('refuses malformed padding and envelope boundaries', () => {
    for (const b of [new Uint8Array(), new Uint8Array(255), new Uint8Array(256), new Uint8Array(512)]) expect(unpad(b).ok).toBe(false);
    const longPad = new Uint8Array(512); longPad[254] = 128; expect(unpad(longPad).ok).toBe(false);
    for (const p of [new Uint8Array(255), new Uint8Array(256), new Uint8Array(16384)]) expect(unwrap(unpad(pad(p)))).toEqual(p);
    for (const n of [0, 304, 306, 16690, 16945]) expect(parseEnvelope(new Uint8Array(n)).ok).toBe(false);
  });
  it('enforces attachment membership and claimed plaintext length', () => {
    const ref = d.messages[2].payload.files[0];
    expect(unwrap(openAttachment(ref, [ref.id], file))).toEqual(plainFile);
    expect(openAttachment(ref, [], file).ok).toBe(false); expect(openAttachment({ ...ref, size: ref.size - 1 }, [ref.id], file).ok).toBe(false);
  });
  it('handles chunk boundaries, truncation, extension and corruption', () => {
    const k = h(d.attachment.file_key);
    for (const size of [0, 1, 65535, 65536, 65537]) {
      const p = new Uint8Array(size).fill(23), blob = sealFile(k, p);
      expect(unwrap(openFile(k, blob))).toEqual(p);
      for (const changed of [blob.slice(0, -1), concat(blob, new Uint8Array([0])), Uint8Array.from(blob, (b, i) => i === 25 ? b ^ 1 : b)]) expect(openFile(k, changed).ok).toBe(false);
    }
  });
  it('allows only fixed inline MIME types and sanitises download names', () => {
    for (const mime of ['text/html', 'image/svg+xml', 'application/xhtml+xml', 'application/pdf', 'text/plain', 'image/jpeg;foo=bar', 'IMAGE/JPEG']) expect(inlineMimeAllowed(mime)).toBe(false);
    for (const mime of ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'video/mp4', 'video/webm', 'video/quicktime', 'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/webm', 'audio/wav']) expect(inlineMimeAllowed(mime)).toBe(true);
    expect(safeDownloadName('../foo\\bar\u0000\u202e.html')).toBe('_foo_bar__.html'); expect(safeDownloadName('...')).toBe('download');
  });
});
