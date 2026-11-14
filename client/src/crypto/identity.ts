import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { attempt, bytes, concat, H, randomBytes, requireThat, revision, unwrap, utf8, validateAgreementKey, type RandomSource, type Result } from './common';
export { CryptoError, type Result, type RandomSource, ctEqual, lp, u32be } from './common';

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
export function b64u(b: Uint8Array): string {
  bytes(b); let out = '';
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    out += alphabet[(n >>> 18) & 63] + alphabet[(n >>> 12) & 63];
    if (i + 1 < b.length) out += alphabet[(n >>> 6) & 63];
    if (i + 2 < b.length) out += alphabet[n & 63];
  }
  return out;
}
export function unb64u(s: unknown): Result<Uint8Array> {
  return attempt(() => {
    requireThat(typeof s === 'string' && /^[A-Za-z0-9_-]*$/.test(s) && s.length % 4 !== 1, 'INVALID_ENCODING');
    const out = new Uint8Array(Math.floor(s.length * 6 / 8));
    let acc = 0, bits = 0, j = 0;
    for (const c of s) { acc = (acc << 6) | alphabet.indexOf(c); bits += 6; if (bits >= 8) { bits -= 8; out[j++] = acc >>> bits; } }
    requireThat(b64u(out) === s, 'INVALID_ENCODING'); return out;
  }, 'INVALID_ENCODING');
}
export interface Identity { agreePriv: Uint8Array; signSeed: Uint8Array; agreePub: Uint8Array; signPub: Uint8Array; identityKey: Uint8Array }
export const newSeed = (rng?: RandomSource): Uint8Array => randomBytes(32, rng);
export function deriveIdentity(seed: Uint8Array): Identity {
  bytes(seed, 32);
  const agreePriv = H(seed, utf8('housecall identity v1'), 'agree');
  const signSeed = H(seed, utf8('housecall identity v1'), 'sign');
  const agreePub = x25519.getPublicKey(agreePriv), signPub = ed25519.getPublicKey(signSeed);
  return { agreePriv, signSeed, agreePub, signPub, identityKey: concat(new Uint8Array([1]), agreePub, signPub) };
}
export function destroyIdentity(identity: Identity): void { identity.agreePriv.fill(0); identity.signSeed.fill(0); }
export function publicIdentityKey(seed: Uint8Array): Uint8Array {
  const i = deriveIdentity(seed); try { return i.identityKey; } finally { destroyIdentity(i); }
}
export function parseIdentityKey(value: unknown): Result<{ agreePub: Uint8Array; signPub: Uint8Array }> {
  return attempt(() => {
    bytes(value, 65); requireThat(value[0] === 1, 'UNSUPPORTED_VERSION');
    const agreePub = value.slice(1, 33), signPub = value.slice(33);
    validateAgreementKey(agreePub);
    const p = ed25519.Point.fromBytes(signPub);
    requireThat(!p.isSmallOrder(), 'INVALID_KEY'); return { agreePub, signPub };
  }, 'INVALID_KEY');
}
export function serialiseIdentity(seed: Uint8Array, recoveryRev: number): string {
  bytes(seed, 32); // Native secure-store boundary only. Never pass to browser storage.
  revision(recoveryRev);
  return JSON.stringify({ seed: b64u(seed), recovery_rev: recoveryRev });
}
export function parseStoredIdentity(input: unknown): Result<{ seed: Uint8Array; recovery_rev: number }> {
  return attempt(() => {
    const v = typeof input === 'string' ? JSON.parse(input) : input;
    requireThat(v && typeof v === 'object' && !Array.isArray(v));
    const seed = unwrap(unb64u(v.seed)); bytes(seed, 32);
    requireThat(Number.isInteger(v.recovery_rev) && v.recovery_rev >= 1 && v.recovery_rev <= 0xffffffff);
    return { seed, recovery_rev: v.recovery_rev as number };
  });
}
/** Contract alias; actual persistence must be provided by the native integration. */
export interface IdentityStore { get(): Promise<{ seed: Uint8Array; recoveryRev: number } | null>; set(value: { seed: Uint8Array; recoveryRev: number }): Promise<void>; remove(): Promise<void> }
