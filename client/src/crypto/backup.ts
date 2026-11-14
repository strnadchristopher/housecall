import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { entropyToMnemonic, mnemonicToEntropy } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { attempt, bytes, concat, ctEqual, H, randomBytes, readU32, requireThat, revision, u32be, unwrap, utf8, type RandomSource, type Result } from './common';
import { parseIdentityKey, publicIdentityKey } from './identity';
export function recoveryKey(seed: Uint8Array, rev: number): Uint8Array {
  bytes(seed, 32); revision(rev);
  return H(seed, utf8('housecall recovery v1'), concat(utf8('recovery key'), u32be(rev)));
}
export function recoveryWords(r: Uint8Array): string { bytes(r, 32); return entropyToMnemonic(r, wordlist); }
export const normaliseWords = (s: string): string => s.normalize('NFKD').toLowerCase().trim().split(/\s+/).join(' ');
export function wordsToRecoveryKey(s: unknown): Result<Uint8Array> {
  return attempt(() => {
    requireThat(typeof s === 'string', 'INVALID_WORDS');
    const words = normaliseWords(s); requireThat(words.split(' ').length === 24, 'INVALID_WORDS');
    const r = mnemonicToEntropy(words, wordlist); bytes(r, 32); return r;
  }, 'INVALID_WORDS');
}
export function sealBackup(seed: Uint8Array, rev: number, rng?: RandomSource): Uint8Array {
  const r = recoveryKey(seed, rev), k = H(r, utf8('housecall backup v1'), 'key backup');
  try {
    const header = concat(new Uint8Array([1]), u32be(rev)), nonce = randomBytes(24, rng);
    return concat(header, nonce, xchacha20poly1305(k, nonce, header).encrypt(seed));
  } finally { r.fill(0); k.fill(0); }
}
export function parseBackup(blob: unknown): Result<{ recoveryRev: number; nonce: Uint8Array }> {
  return attempt(() => {
    bytes(blob, 77); requireThat(blob[0] === 1, 'UNSUPPORTED_VERSION');
    const recoveryRev = readU32(blob, 1); revision(recoveryRev);
    return { recoveryRev, nonce: blob.slice(5, 29) };
  });
}
export function openBackup(blob: Uint8Array, r: Uint8Array, expectedIdentityKey: Uint8Array): Result<Uint8Array> {
  return attempt(() => {
    const { nonce } = unwrap(parseBackup(blob)); bytes(r, 32); unwrap(parseIdentityKey(expectedIdentityKey));
    const k = H(r, utf8('housecall backup v1'), 'key backup');
    let seed: Uint8Array | undefined;
    try {
      seed = xchacha20poly1305(k, nonce, blob.subarray(0, 5)).decrypt(blob.subarray(29));
      if (!ctEqual(publicIdentityKey(seed), expectedIdentityKey)) { seed.fill(0); requireThat(false, 'IDENTITY_MISMATCH'); }
      return seed;
    } finally { k.fill(0); }
  }, 'AUTH_FAILED');
}
/** Positions are one-based. A retry excludes both previously displayed positions. */
export function pickConfirmPositions(rng?: RandomSource, previous?: readonly [number, number]): [number, number] {
  if (previous) requireThat(previous.every(n => Number.isInteger(n) && n >= 1 && n <= 24) && previous[0] !== previous[1]);
  const picked: number[] = [];
  // Rejection sampling has no modulo bias. Bound a broken injected RNG instead of hanging.
  for (let tries = 0; tries < 4096 && picked.length < 2; tries++) {
    const n = randomBytes(1, rng)[0]; if (n >= 240) continue;
    const pos = n % 24 + 1;
    if (!picked.includes(pos) && !previous?.includes(pos)) picked.push(pos);
  }
  requireThat(picked.length === 2); return [picked[0], picked[1]];
}
export function checkConfirm(words: string, positions: readonly [number, number], typed: readonly [string, string]): boolean {
  return unwrapOrFalse(attempt(() => {
    requireThat(wordsToRecoveryKey(words).ok && positions[0] !== positions[1]);
    const list = normaliseWords(words).split(' ');
    let matches = true;
    for (let i = 0; i < 2; i++) {
      requireThat(Number.isInteger(positions[i]) && positions[i] >= 1 && positions[i] <= 24 && typeof typed[i] === 'string');
      matches = ctEqual(utf8(normaliseWords(typed[i])), utf8(list[positions[i] - 1])) && matches;
    }
    return matches;
  }));
}
function unwrapOrFalse(result: Result<boolean>): boolean { return result.ok && result.value; }
