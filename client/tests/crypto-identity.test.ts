import { describe, expect, it } from 'vitest';
import raw from './vectors/dm-v1.json';
import { b64u, deriveIdentity, destroyIdentity, newSeed, parseIdentityKey, parseStoredIdentity, serialiseIdentity, unb64u } from '../src/crypto/identity';
import { ctEqual, lp, unwrap, utf8, u32be } from '../src/crypto/common';
import { safetyNumber } from '../src/crypto/safetyNumber';
import { conversationKey } from '../src/crypto/dm';
const d: any = raw;
const h = (s: string) => new Uint8Array(Buffer.from(s, 'hex'));
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
describe('identity and encoding vectors', () => {
  for (const v of d.identities) it(v.name, () => {
    const i = deriveIdentity(h(v.seed));
    for (const [field, expected] of Object.entries({ agreePriv: v.agree_priv, signSeed: v.sign_seed, agreePub: v.agree_pub, signPub: v.sign_pub, identityKey: v.identity_key_hex })) expect(hex(i[field as keyof typeof i])).toBe(expected);
    expect(parseIdentityKey(i.identityKey).ok).toBe(true);
    expect(b64u(i.identityKey)).toBe(v.identity_key_b64u); expect(hex(unwrap(unb64u(v.identity_key_b64u)))).toBe(v.identity_key_hex);
    destroyIdentity(i); expect(i.agreePriv.every(b => b === 0) && i.signSeed.every(b => b === 0)).toBe(true);
  });
  for (const v of d.negative.filter((n: any) => n.kind === 'identity_key')) it(v.name, () => {
    const r = parseIdentityKey(h(v.identity_key_hex));
    if (r.ok) {
      expect(() => conversationKey({ channelId: d.channel_id, myId: d.user_ids.alice, peerId: d.user_ids.bob, myIdentity: deriveIdentity(h(d.identities[0].seed)), peerIdentityKey: h(v.identity_key_hex) })).toThrow();
    } else expect(r.error.name).toBe('CryptoError');
  });
  for (const s of ['AA==', 'A+', 'A/', ' AA', 'AB', 'A', '\nAA', 'AA\t', null, 23, {}, []]) it(`rejects encoding ${JSON.stringify(s)}`, () => expect(unb64u(s).ok).toBe(false));
  it('round trips binary encodings and validates lengths', () => {
    for (let n = 0; n < 260; n++) { const b = Uint8Array.from({ length: n }, (_, i) => i); expect(unwrap(unb64u(b64u(b)))).toEqual(b); }
    expect(hex(lp('é'))).toBe('0002c3a9'); expect(hex(u32be(0xffffffff))).toBe('ffffffff'); expect(() => u32be(-1)).toThrow(); expect(() => lp('x'.repeat(65536))).toThrow();
  });
  it('rejects invalid and small-order Ed25519 points', () => {
    for (const sign of [new Uint8Array(32), new Uint8Array(32).fill(255), Uint8Array.from({ length: 32 }, (_, i) => i === 0 ? 1 : 0)]) {
      const key = h(d.identities[0].identity_key_hex); key.set(sign, 33); expect(parseIdentityKey(key).ok).toBe(false);
    }
  });
  it('uses fresh randomness and supports injected bytes', () => {
    expect(newSeed()).not.toEqual(newSeed()); expect(newSeed(n => new Uint8Array(n).fill(7))).toEqual(new Uint8Array(32).fill(7));
    expect(() => newSeed(() => new Uint8Array(31))).toThrow();
  });
  it('serialises only the native store boundary and rejects hostile stored values', () => {
    const seed = h(d.identities[0].seed); const encoded = serialiseIdentity(seed, 2);
    expect(unwrap(parseStoredIdentity(encoded))).toEqual({ seed, recovery_rev: 2 });
    for (const value of [null, 'not json', '[]', '{}', { seed: b64u(seed), recovery_rev: 0 }, { seed: 'AA', recovery_rev: 1 }]) expect(parseStoredIdentity(value).ok).toBe(false);
  });
  it('constant-time comparator covers equal, different and different lengths', () => {
    expect(ctEqual(utf8('94'), utf8('94'))).toBe(true); expect(ctEqual(utf8('94'), utf8('95'))).toBe(false); expect(ctEqual(utf8('94'), utf8('9'))).toBe(false);
  });
  it('matches safety number and symmetry for independent identities', () => {
    const a = h(d.identities[0].identity_key_hex), b = h(d.identities[1].identity_key_hex);
    expect(safetyNumber(a, b)).toBe(d.safety_number.alice_bob); expect(safetyNumber(a, b)).toBe(safetyNumber(b, a));
    const x = deriveIdentity(newSeed()), y = deriveIdentity(newSeed());
    expect(safetyNumber(x.identityKey, y.identityKey)).toBe(safetyNumber(y.identityKey, x.identityKey));
    const c = { channelId: 'synthetic-channel' };
    expect(conversationKey({ ...c, myId: 'é', peerId: 'aa', myIdentity: x, peerIdentityKey: y.identityKey })).toEqual(conversationKey({ ...c, myId: 'aa', peerId: 'é', myIdentity: y, peerIdentityKey: x.identityKey }));
  });
});
