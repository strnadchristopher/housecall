import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { x25519 } from '@noble/curves/ed25519.js';

export type ErrorCode = 'INVALID_INPUT' | 'INVALID_ENCODING' | 'INVALID_KEY' | 'INVALID_ENVELOPE' | 'INVALID_PAYLOAD' | 'UNSUPPORTED_VERSION' | 'AUTH_FAILED' | 'IDENTITY_MISMATCH' | 'INVALID_WORDS' | 'INVALID_PINS';
/** Fixed messages only: never attach input, library errors or secret material. */
export class CryptoError extends Error {
  constructor(public readonly code: ErrorCode) { super(code); this.name = 'CryptoError'; }
}
export type Result<T> = { ok: true; value: T } | { ok: false; error: CryptoError };
export function attempt<T>(fn: () => T, code: ErrorCode = 'INVALID_INPUT'): Result<T> {
  try { return { ok: true, value: fn() }; }
  catch (e) { return { ok: false, error: e instanceof CryptoError ? e : new CryptoError(code) }; }
}
/** For trusted construction paths; hostile input paths must run inside attempt. */
export function unwrap<T>(r: Result<T>): T { if (!r.ok) throw r.error; return r.value; }
export function requireThat(test: unknown, code: ErrorCode = 'INVALID_INPUT'): asserts test { if (!test) throw new CryptoError(code); }
export function bytes(b: unknown, size?: number): asserts b is Uint8Array {
  requireThat(b instanceof Uint8Array && (size === undefined || b.length === size));
}
export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
export const decodeUtf8 = (b: Uint8Array): string => new TextDecoder('utf-8', { fatal: true }).decode(b);
export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}
export function ctEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
export function cmpBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}
export function revision(n: unknown): asserts n is number { requireThat(typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 0xffffffff); }
export function u32be(n: number): Uint8Array {
  requireThat(Number.isInteger(n) && n >= 0 && n <= 0xffffffff);
  return new Uint8Array([n >>> 24, n >>> 16, n >>> 8, n]);
}
export const readU32 = (b: Uint8Array, o: number): number => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(o);
export function lp(s: string): Uint8Array {
  requireThat(typeof s === 'string');
  const b = utf8(s); requireThat(b.length <= 65535);
  return concat(new Uint8Array([b.length >>> 8, b.length]), b);
}
export const H = (ikm: Uint8Array, salt: Uint8Array, info: string | Uint8Array, n = 32): Uint8Array => hkdf(sha256, ikm, salt, typeof info === 'string' ? utf8(info) : info, n);
export type RandomSource = (length: number) => Uint8Array;
export const systemRandom: RandomSource = length => {
  const out = new Uint8Array(length);
  // getRandomValues limits each call to 65536 bytes.
  for (let i = 0; i < length; i += 65536) globalThis.crypto.getRandomValues(out.subarray(i, i + 65536));
  return out;
};
export function randomBytes(length: number, rng: RandomSource = systemRandom): Uint8Array {
  const value = rng(length); bytes(value, length); return value.slice();
}
export function sharedSecret(priv: Uint8Array, pub: Uint8Array): Uint8Array {
  bytes(priv, 32); validateAgreementKey(pub);
  const r = attempt(() => x25519.getSharedSecret(priv, pub), 'INVALID_KEY');
  const ss = unwrap(r); requireThat(ss.some(b => b !== 0), 'INVALID_KEY'); return ss;
}
export function validateAgreementKey(pub: Uint8Array): void {
  bytes(pub, 32);
  let n = 0n;
  for (let i = 31; i >= 0; i--) n = (n << 8n) | BigInt(pub[i]);
  requireThat(n > 0n && n < (1n << 255n) - 19n, 'INVALID_KEY');
}
