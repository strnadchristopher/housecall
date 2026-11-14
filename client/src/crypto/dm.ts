import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { attempt, bytes, cmpBytes, concat, decodeUtf8, H, lp, randomBytes, readU32, requireThat, revision, sharedSecret, u32be, unwrap, utf8, type RandomSource, type Result } from './common';
import { b64u, parseIdentityKey, unb64u, type Identity } from './identity';
export const MAX_FILE = 104857600;
export interface FileRef { id: string; key: string; name: string; mime: string; size: number; w?: number; h?: number }
export interface Payload { v: 1; text: string; files?: FileRef[]; re?: string }
export interface MessageContext { key: Uint8Array; channelId: string; senderId: string; recipientId: string }
export interface Envelope { header: Uint8Array; senderKeyRev: number; recipientKeyRev: number; nonce: Uint8Array; ct: Uint8Array }
export function conversationKey({ channelId, myId, myIdentity, peerId, peerIdentityKey }: { channelId: string; myId: string; myIdentity: Identity; peerId: string; peerIdentityKey: Uint8Array }): Uint8Array {
  requireThat(myId !== peerId); lp(myId); lp(peerId); lp(channelId);
  const peer = unwrap(parseIdentityKey(peerIdentityKey)); unwrap(parseIdentityKey(myIdentity.identityKey));
  const ss = sharedSecret(myIdentity.agreePriv, peer.agreePub);
  try {
    const [lo, hi] = cmpBytes(utf8(myId), utf8(peerId)) < 0 ? [{ id: myId, key: myIdentity.identityKey }, { id: peerId, key: peerIdentityKey }] : [{ id: peerId, key: peerIdentityKey }, { id: myId, key: myIdentity.identityKey }];
    return H(ss, utf8(channelId), concat(utf8('housecall dm v1'), lp(lo.id), lo.key, lp(hi.id), hi.key));
  } finally { ss.fill(0); }
}
export function pad(p: Uint8Array): Uint8Array {
  bytes(p); requireThat(p.length <= 16384);
  const out = new Uint8Array(Math.ceil((p.length + 1) / 256) * 256); out.set(p); out[p.length] = 128; return out;
}
export function unpad(p: unknown): Result<Uint8Array> {
  return attempt(() => {
    bytes(p); requireThat(p.length > 0 && p.length <= 16640 && p.length % 256 === 0);
    let i = p.length - 1;
    while (i >= Math.max(0, p.length - 256) && p[i] === 0) i--;
    requireThat(i >= 0 && p[i] === 128 && p.length - i <= 256); return p.slice(0, i);
  }, 'INVALID_PAYLOAD');
}
function record(v: unknown): v is Record<string, unknown> { return typeof v === 'object' && v !== null && !Array.isArray(v); }
export function validateFileRef(v: unknown): Result<FileRef> {
  return attempt(() => {
    requireThat(record(v), 'INVALID_PAYLOAD');
    requireThat(typeof v.id === 'string' && /^[0-9a-f-]{1,64}$/.test(v.id));
    const k = unwrap(unb64u(v.key)); try { bytes(k, 32); } finally { k.fill(0); }
    requireThat(typeof v.name === 'string' && utf8(v.name).length >= 1 && utf8(v.name).length <= 255);
    requireThat(typeof v.mime === 'string' && v.mime.length <= 127 && /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(v.mime));
    requireThat(typeof v.size === 'number' && Number.isInteger(v.size) && v.size >= 0 && v.size <= MAX_FILE);
    for (const key of ['w', 'h']) if (v[key] !== undefined) requireThat(typeof v[key] === 'number' && Number.isInteger(v[key]) && (v[key] as number) >= 1 && (v[key] as number) <= 16384);
    return { id: v.id, key: v.key as string, name: v.name, mime: v.mime, size: v.size, ...(v.w === undefined ? {} : { w: v.w as number }), ...(v.h === undefined ? {} : { h: v.h as number }) };
  }, 'INVALID_PAYLOAD');
}
export function validatePayload(v: unknown): Result<Payload> {
  return attempt(() => {
    requireThat(record(v), 'INVALID_PAYLOAD'); requireThat(v.v === 1, 'UNSUPPORTED_VERSION'); requireThat(typeof v.text === 'string', 'INVALID_PAYLOAD');
    let files: FileRef[] | undefined;
    if (v.files !== undefined) { requireThat(Array.isArray(v.files) && v.files.length <= 20, 'INVALID_PAYLOAD'); files = v.files.map(f => unwrap(validateFileRef(f))); }
    requireThat(v.text !== '' || (files && files.length > 0), 'INVALID_PAYLOAD');
    if (v.re !== undefined) bytes(unwrap(unb64u(v.re)), 24);
    const payload: Payload = { v: 1, text: v.text, ...(files === undefined ? {} : { files }), ...(v.re === undefined ? {} : { re: v.re as string }) };
    requireThat(utf8(JSON.stringify(payload)).length <= 16384, 'INVALID_PAYLOAD'); return payload;
  }, 'INVALID_PAYLOAD');
}
function ad(header: Uint8Array, c: MessageContext): Uint8Array { requireThat(c.senderId !== c.recipientId); return concat(header, lp(c.channelId), lp(c.senderId), lp(c.recipientId)); }
export function sealMessage(c: MessageContext & { senderKeyRev: number; recipientKeyRev: number; payload: Payload; rng?: RandomSource }): Uint8Array {
  bytes(c.key, 32); revision(c.senderKeyRev); revision(c.recipientKeyRev);
  const payload = unwrap(validatePayload(c.payload));
  const header = concat(new Uint8Array([1]), u32be(c.senderKeyRev), u32be(c.recipientKeyRev)), nonce = randomBytes(24, c.rng);
  const plain = pad(utf8(JSON.stringify(payload)));
  try { return concat(header, nonce, xchacha20poly1305(c.key, nonce, ad(header, c)).encrypt(plain)); }
  finally { plain.fill(0); }
}
export function parseEnvelope(value: unknown): Result<Envelope> {
  return attempt(() => {
    const env = typeof value === 'string' ? unwrap(unb64u(value.length <= 22252 ? value : null)) : value;
    bytes(env); requireThat(env.length >= 305 && env.length <= 16689 && (env.length - 49) % 256 === 0, 'INVALID_ENVELOPE');
    requireThat(env[0] === 1, 'UNSUPPORTED_VERSION');
    const senderKeyRev = readU32(env, 1), recipientKeyRev = readU32(env, 5); revision(senderKeyRev); revision(recipientKeyRev);
    return { header: env.slice(0, 9), senderKeyRev, recipientKeyRev, nonce: env.slice(9, 33), ct: env.slice(33) };
  }, 'INVALID_ENVELOPE');
}
/** Key selection and pin authorization must happen before this low-level authenticated open. */
export function openMessage(c: MessageContext & { envelope: unknown }): Result<Envelope & { payload: Payload }> {
  return attempt(() => {
    bytes(c.key, 32); const e = unwrap(parseEnvelope(c.envelope));
    const plain = xchacha20poly1305(c.key, e.nonce, ad(e.header, c)).decrypt(e.ct);
    let json: Uint8Array | undefined;
    try {
      json = unwrap(unpad(plain)); requireThat(json.length <= 16384, 'INVALID_PAYLOAD');
      const payload = unwrap(validatePayload(JSON.parse(decodeUtf8(json)))); return { ...e, payload };
    } finally { plain.fill(0); json?.fill(0); }
  }, 'AUTH_FAILED');
}
const inlineMimes = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'video/mp4', 'video/webm', 'video/quicktime', 'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/webm', 'audio/wav']);
export const inlineMimeAllowed = (mime: string): boolean => inlineMimes.has(mime);
export const safeDownloadName = (name: string): string => name.replace(/[\\/\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '_').replace(/^\.+/, '') || 'download';
export function sealFile(key: Uint8Array, plaintext: Uint8Array, rng?: RandomSource): Uint8Array {
  bytes(key, 32); bytes(plaintext); requireThat(plaintext.length <= MAX_FILE);
  const prefix = randomBytes(19, rng), header = concat(new Uint8Array([1]), prefix), parts = [header];
  const count = Math.max(1, Math.ceil(plaintext.length / 65536));
  for (let i = 0; i < count; i++) {
    const nonce = concat(prefix, u32be(i), new Uint8Array([i === count - 1 ? 1 : 0]));
    parts.push(xchacha20poly1305(key, nonce, header).encrypt(plaintext.subarray(i * 65536, (i + 1) * 65536)));
  }
  return concat(...parts);
}
export function openFile(key: Uint8Array, blob: Uint8Array): Result<Uint8Array> {
  return attempt(() => {
    bytes(key, 32); bytes(blob); requireThat(blob.length >= 36 && blob.length <= 104883220 && blob[0] === 1);
    const header = blob.subarray(0, 20), prefix = blob.subarray(1, 20), body = blob.subarray(20), parts: Uint8Array[] = [];
    const count = Math.ceil(body.length / 65552);
    try {
      for (let i = 0; i < count; i++) {
        const piece = body.subarray(i * 65552, (i + 1) * 65552); requireThat(piece.length >= 16);
        const nonce = concat(prefix, u32be(i), new Uint8Array([i === count - 1 ? 1 : 0]));
        parts.push(xchacha20poly1305(key, nonce, header).decrypt(piece));
      }
      const length = parts.reduce((n, p) => n + p.length, 0); requireThat(length <= MAX_FILE);
      return concat(...parts);
    } finally { for (const p of parts) p.fill(0); }
  }, 'AUTH_FAILED');
}
/** Enforce FileRef membership and size before handing bytes to any renderer. */
export function openAttachment(ref: FileRef, attachmentIds: readonly string[], blob: Uint8Array): Result<Uint8Array> {
  return attempt(() => {
    const f = unwrap(validateFileRef(ref)); requireThat(attachmentIds.includes(f.id));
    const key = unwrap(unb64u(f.key));
    try { const plain = unwrap(openFile(key, blob)); if (plain.length !== f.size) { plain.fill(0); requireThat(false); } return plain; }
    finally { key.fill(0); }
  }, 'AUTH_FAILED');
}
/** One instance per DM's loaded history. Check after authenticated open, before rendering. */
export class NonceSet {
  private readonly nonces = new Set<string>();
  accept(nonce: Uint8Array): boolean { bytes(nonce, 24); const n = b64u(nonce); if (this.nonces.has(n)) return false; this.nonces.add(n); return true; }
  clear(): void { this.nonces.clear(); }
}
