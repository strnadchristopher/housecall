import { x25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { attempt, bytes, concat, ctEqual, decodeUtf8, H, randomBytes, readU32, requireThat, revision, sharedSecret, u32be, unwrap, utf8, validateAgreementKey, type RandomSource, type Result } from './common';
import { b64u, parseIdentityKey, publicIdentityKey, unb64u } from './identity';
export { ctEqual, sharedSecret } from './common';
export interface QrPayload { origin: string; linkId: Uint8Array; secret: Uint8Array; showingPub: Uint8Array }
export interface PinHistory { key_rev: number; identity_key: string }
export interface Pin { origin: string; user_id: string; identity_key: string; key_rev: number; verified: boolean; history: PinHistory[] }
export function validOrigin(origin: unknown): origin is string {
  if (typeof origin !== 'string') return false;
  try { const u = new URL(origin); return u.origin === origin && (u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))); } catch { return false; }
}
export function formatQr(origin: string, linkId: Uint8Array, secret: Uint8Array, showingPub: Uint8Array, direction: 'hcl1' | 'hcr1' = 'hcl1'): string {
  requireThat(validOrigin(origin)); bytes(linkId, 16); bytes(secret, 32); validateAgreementKey(showingPub);
  const id = Array.from(linkId, b => b.toString(16).padStart(2, '0')).join('');
  const text = `${origin}/link#${direction}.${id}.${b64u(secret)}.${b64u(showingPub)}`;
  requireThat(text.length <= 512); return text;
}
export function parseQr(text: unknown, direction: 'hcl1' | 'hcr1' = 'hcl1'): Result<QrPayload> {
  return attempt(() => {
    requireThat(typeof text === 'string' && text.length <= 512);
    const hash = text.indexOf('#'); requireThat(hash >= 0);
    const before = text.slice(0, hash); requireThat(before.endsWith('/link'));
    const origin = before.slice(0, -5); requireThat(validOrigin(origin));
    const parts = text.slice(hash + 1).split('.');
    requireThat(parts.length === 4 && parts[0] === direction && /^[0-9a-f]{32}$/.test(parts[1]));
    const linkId = Uint8Array.from(parts[1].match(/../g)!, s => Number.parseInt(s, 16));
    const secret = unwrap(unb64u(parts[2])), showingPub = unwrap(unb64u(parts[3]));
    bytes(secret, 32); bytes(showingPub, 32);
    // QR grammar permits any 32-byte A; sharedSecret refuses invalid and small-order keys at use.
    return { origin, linkId, secret, showingPub };
  });
}
export function parseDeepLink(text: unknown): Result<{ action: 'scan' }> {
  return attempt(() => { requireThat(text === 'housecall://link-scan'); return { action: 'scan' as const }; });
}
export function newEphemeral(rng?: RandomSource): { priv: Uint8Array; pub: Uint8Array } {
  const priv = randomBytes(32, rng); return { priv, pub: x25519.getPublicKey(priv) };
}
export function confirmationCode(codeBytes: Uint8Array): string { bytes(codeBytes, 4); return (readU32(codeBytes, 0) % 100).toString().padStart(2, '0'); }
export function linkKeys({ linkId, secret, showingPub, claimingPub, sharedSecret: ss, direction = 'hcl1' }: { direction?: 'hcl1' | 'hcr1'; linkId: Uint8Array; secret: Uint8Array; showingPub: Uint8Array; claimingPub: Uint8Array; sharedSecret: Uint8Array }): { salt: Uint8Array; wrapKey: Uint8Array; claimTag: Uint8Array; codeBytes: Uint8Array; code: string } {
  bytes(linkId, 16); bytes(secret, 32); validateAgreementKey(showingPub); validateAgreementKey(claimingPub); bytes(ss, 32); requireThat(ss.some(b => b !== 0), 'INVALID_KEY');
  const domain = direction === 'hcr1' ? 'housecall link v2 request' : 'housecall link v1';
  const salt = sha256(concat(utf8(domain), linkId, secret, showingPub, claimingPub));
  const wrapKey = H(ss, salt, `${domain} wrap`), claimTag = H(ss, salt, `${domain} claim`, 16), codeBytes = H(ss, salt, `${domain} code`, 4);
  return { salt, wrapKey, claimTag, codeBytes, code: confirmationCode(codeBytes) };
}
export function typedCodeMatches(typed: unknown, code: unknown): boolean {
  if (typeof typed !== 'string' || typeof code !== 'string') return false;
  const t = typed.trim(); if (!/^[0-9]{2}$/.test(t) || !/^[0-9]{2}$/.test(code)) return false;
  return ctEqual(utf8(t), utf8(code));
}
export function validatePins(value: unknown): Result<Pin[]> {
  return attempt(() => {
    requireThat(Array.isArray(value), 'INVALID_PINS');
    return value.map((p: unknown) => {
      requireThat(p !== null && typeof p === 'object' && !Array.isArray(p), 'INVALID_PINS');
      const pin = p as Record<string, unknown>;
      requireThat(validOrigin(pin.origin) && typeof pin.user_id === 'string' && utf8(pin.user_id).length >= 1 && utf8(pin.user_id).length <= 128, 'INVALID_PINS');
      revision(pin.key_rev); requireThat(typeof pin.verified === 'boolean', 'INVALID_PINS');
      unwrap(parseIdentityKey(unwrap(unb64u(pin.identity_key))));
      requireThat(Array.isArray(pin.history) && pin.history.length > 0, 'INVALID_PINS');
      let previous = 0; const seen = new Set<string>();
      const history = pin.history.map((v: unknown): PinHistory => {
        requireThat(v !== null && typeof v === 'object' && !Array.isArray(v), 'INVALID_PINS');
        const h = v as Record<string, unknown>; revision(h.key_rev);
        requireThat(h.key_rev > previous, 'INVALID_PINS'); previous = h.key_rev;
        unwrap(parseIdentityKey(unwrap(unb64u(h.identity_key))));
        requireThat(typeof h.identity_key === 'string' && !seen.has(h.identity_key), 'INVALID_PINS'); seen.add(h.identity_key);
        return { key_rev: h.key_rev, identity_key: h.identity_key };
      });
      const last = history[history.length - 1];
      requireThat(last.key_rev === pin.key_rev && last.identity_key === pin.identity_key, 'INVALID_PINS');
      return { origin: pin.origin, user_id: pin.user_id, identity_key: pin.identity_key as string, key_rev: pin.key_rev, verified: pin.verified, history };
    });
  }, 'INVALID_PINS');
}
/** Pins are ordered oldest first by the caller. Remove unverified first, then oldest. */
export function fitPins(pins: readonly Pin[]): Pin[] {
  const remaining = unwrap(validatePins(pins));
  while (utf8(JSON.stringify(remaining)).length + 77 > 65536) {
    const unverified = remaining.findIndex(p => !p.verified); remaining.splice(unverified < 0 ? 0 : unverified, 1);
  }
  return remaining;
}
export function sealWrappedKeys(wrapKey: Uint8Array, linkId: Uint8Array, seed: Uint8Array, recoveryRev: number, pins: readonly Pin[], rng?: RandomSource): Uint8Array {
  bytes(wrapKey, 32); bytes(linkId, 16); bytes(seed, 32); revision(recoveryRev);
  const accepted = fitPins(pins), nonce = randomBytes(24, rng), header = new Uint8Array([1]);
  const plain = concat(seed, u32be(recoveryRev), utf8(JSON.stringify(accepted)));
  try { return concat(header, nonce, xchacha20poly1305(wrapKey, nonce, concat(header, linkId)).encrypt(plain)); }
  finally { plain.fill(0); }
}
/** With expectedIdentityKey, mismatch discards the entire opened blob before returning any seed/pins. */
export function openWrappedKeys(wrapKey: Uint8Array, linkId: Uint8Array, blob: Uint8Array, expectedIdentityKey?: Uint8Array): Result<{ seed: Uint8Array; recoveryRev: number; pins: Pin[] }> {
  return attempt(() => {
    bytes(wrapKey, 32); bytes(linkId, 16); bytes(blob);
    requireThat(blob.length >= 79 && blob.length <= 65536); requireThat(blob[0] === 1, 'UNSUPPORTED_VERSION');
    const plain = xchacha20poly1305(wrapKey, blob.subarray(1, 25), concat(blob.subarray(0, 1), linkId)).decrypt(blob.subarray(25));
    try {
      const recoveryRev = readU32(plain, 32); revision(recoveryRev);
      const pins = unwrap(validatePins(JSON.parse(decodeUtf8(plain.subarray(36)))));
      if (expectedIdentityKey !== undefined) {
        unwrap(parseIdentityKey(expectedIdentityKey));
        requireThat(ctEqual(publicIdentityKey(plain.subarray(0, 32)), expectedIdentityKey), 'IDENTITY_MISMATCH');
      }
      return { seed: plain.slice(0, 32), recoveryRev, pins };
    } finally { plain.fill(0); }
  }, 'AUTH_FAILED');
}
/** Existing local pins win, including their complete history and verification state. */
export function mergePins(local: readonly Pin[], incoming: readonly Pin[]): Result<Pin[]> {
  return attempt(() => {
    const old = unwrap(validatePins(local)), next = unwrap(validatePins(incoming));
    const ids = new Set(old.map(p => JSON.stringify([p.origin, p.user_id])));
    return [...old, ...next.filter(p => !ids.has(JSON.stringify([p.origin, p.user_id])))];
  }, 'INVALID_PINS');
}
