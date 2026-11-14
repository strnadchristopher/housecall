import { describe, expect, it } from 'vitest';
import raw from './vectors/dm-v1.json';
import { checkConfirm, normaliseWords, openBackup, parseBackup, pickConfirmPositions, recoveryKey, recoveryWords, sealBackup, wordsToRecoveryKey } from '../src/crypto/backup';
import { unwrap } from '../src/crypto/common';
const d: any = raw, r = d.recovery;
const h = (s: string) => new Uint8Array(Buffer.from(s, 'hex'));
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const seed = h(d.identities[0].seed), expected = h(d.identities[0].identity_key_hex);
describe('backup and recovery vectors', () => {
  for (const rev of [1, 2]) it(`recovery revision ${rev}`, () => {
    const v = r[`recovery_rev_${rev}`], k = recoveryKey(seed, rev);
    expect(hex(k)).toBe(v.recovery_key); expect(recoveryWords(k)).toBe(v.words); expect(unwrap(wordsToRecoveryKey(v.words))).toEqual(k);
    const blob = sealBackup(seed, rev, () => h(r.backup_nonce));
    expect(hex(blob)).toBe(r[`key_backup_rev_${rev}_hex`]); expect(unwrap(openBackup(blob, k, expected))).toEqual(seed);
    expect(unwrap(parseBackup(blob)).recoveryRev).toBe(rev);
  });
  it('normalises typed words', () => { expect(normaliseWords(r.typed_words_messy)).toBe(r.recovery_rev_1.words); expect(unwrap(wordsToRecoveryKey(r.typed_words_messy))).toEqual(h(r.recovery_rev_1.recovery_key)); });
  for (const name of ['confirm_two_example', 'confirm_two_wrong']) it(name, () => { const v = r[name]; expect(checkConfirm(r.recovery_rev_1.words, v.positions_1_based, v.typed)).toBe(v.expect === 'accept'); });
  it('rejects swapped words', () => expect(wordsToRecoveryKey(r.words_two_swapped.words).ok).toBe(false));
  for (const v of d.negative.filter((n: any) => ['recovery_words', 'key_backup'].includes(n.kind))) it(v.name, () => {
    const k = wordsToRecoveryKey(v.words);
    if (v.kind === 'recovery_words') expect(k.ok).toBe(false);
    else expect(openBackup(h(v.key_backup_hex), unwrap(k), h(v.expected_identity_key_hex ?? d.identities[0].identity_key_hex)).ok).toBe(false);
  });
  it('samples two distinct positions without modulo bias and excludes the previous pair', () => {
    let i = 0; const sequence = [255, 240, 6, 6, 18, 0, 1]; const rng = () => new Uint8Array([sequence[i++]]);
    const first = pickConfirmPositions(rng); expect(first).toEqual([7, 19]); expect(pickConfirmPositions(rng, first)).toEqual([1, 2]);
    expect(() => pickConfirmPositions(() => new Uint8Array([255]))).toThrow();
  });
  it('requires valid revisions, seed sizes, and mandatory expected key', () => {
    for (const rev of [0, -1, 0x100000000, 1.5]) expect(() => recoveryKey(seed, rev)).toThrow();
    expect(() => recoveryKey(new Uint8Array(31), 1)).toThrow();
    expect(openBackup(h(r.key_backup_rev_1_hex), h(r.recovery_rev_1.recovery_key), new Uint8Array()).ok).toBe(false);
    expect(sealBackup(seed, 1)).not.toEqual(sealBackup(seed, 1));
  });
});
