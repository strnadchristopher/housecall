import { describe, expect, it } from 'vitest';
import raw from './vectors/link-v1.json';
import dm from './vectors/dm-v1.json';
import { concat, unwrap, utf8 } from '../src/crypto/common';
import { b64u } from '../src/crypto/identity';
import { confirmationCode, ctEqual, fitPins, formatQr, linkKeys, mergePins, newEphemeral, openWrappedKeys, parseDeepLink, parseQr, sealWrappedKeys, sharedSecret, typedCodeMatches, validatePins, validOrigin } from '../src/crypto/link';
const l: any = raw;
const h = (s: string) => new Uint8Array(Buffer.from(s, 'hex'));
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const id = h(l.link_id_hex), secret = h(l.secret_hex), a = h(l.showing.ephemeral_priv), A = h(l.showing.ephemeral_pub), b = h(l.claiming.ephemeral_priv), B = h(l.claiming.ephemeral_pub);
const params = { linkId: id, secret, showingPub: A, claimingPub: B };
describe('LINK-V1 vectors', () => {
  it('formats and parses the QR and accepts exactly the scanner deep link', () => {
    expect(formatQr(l.origin, id, secret, A)).toBe(l.qr_text); expect(unwrap(parseQr(l.qr_text))).toEqual({ origin: l.origin, linkId: id, secret, showingPub: A });
    expect(unwrap(parseDeepLink(l.deep_link))).toEqual({ action: 'scan' });
    for (const suffix of ['/', '?', '#', ' ', '\n']) expect(parseDeepLink(l.deep_link + suffix).ok).toBe(false);
  });
  it('derives shared secret and every transcript key from both directions', () => {
    const ss = sharedSecret(a, B); expect(hex(ss)).toBe(l.shared_secret); expect(ss).toEqual(sharedSecret(b, A));
    const keys = linkKeys({ ...params, sharedSecret: ss });
    for (const [field, value] of Object.entries({ salt: l.salt, wrapKey: l.wrap_key, claimTag: l.claim_tag, codeBytes: l.code_bytes })) expect(hex(keys[field as 'salt' | 'wrapKey' | 'claimTag' | 'codeBytes'])).toBe(value);
    expect(keys.code).toBe(l.code); expect(b64u(keys.claimTag)).toBe(l.claim_tag_b64u);
    expect(hex(concat(utf8('housecall link v1'), id, secret, A, B))).toBe(l.transcript_hex);
  });
  for (const v of l.code_reduction_examples) it(`code reduction ${v.bytes_hex}`, () => expect(confirmationCode(h(v.bytes_hex))).toBe(v.code));
  for (const [i, v] of l.typed_code_examples.entries()) it(`typed code ${i}`, () => expect(typedCodeMatches(v.typed, v.showing_device_code)).toBe(v.result === 'approve'));
  it('matches wrapped-keys bytes, complete histories and empty pin list', () => {
    const v = l.wrapped_keys;
    const blob = sealWrappedKeys(h(l.wrap_key), id, h(v.identity_seed), v.recovery_rev, v.pins, () => h(v.nonce));
    expect(hex(blob)).toBe(v.blob_hex); expect(b64u(blob)).toBe(v.blob_b64u);
    expect(unwrap(openWrappedKeys(h(l.wrap_key), id, blob, h(dm.identities[0].identity_key_hex)))).toEqual({ seed: h(v.identity_seed), recoveryRev: v.recovery_rev, pins: v.pins });
    const empty = sealWrappedKeys(h(l.wrap_key), id, h(v.identity_seed), 1, [], () => h(v.nonce));
    expect(hex(empty)).toBe(v.empty_pins_recovery_rev_1_blob_hex); expect(empty.length).toBe(v.min_length);
    expect(openWrappedKeys(h(l.wrap_key), id, blob, h(dm.identities[1].identity_key_hex)).ok).toBe(false);
  });
  for (const v of l.negative) it(v.name, () => {
    switch (v.kind) {
      case 'qr': expect(parseQr(v.text).ok).toBe(false); break;
      case 'deep_link': expect(parseDeepLink(v.text).ok).toBe(false); break;
      case 'deep_link_mitm': expect(parseDeepLink(v.legacy_deep_link_with_host_key).ok).toBe(false); break;
      case 'wrapped_keys': expect(openWrappedKeys(h(v.wrap_key_hex ?? l.wrap_key), h(v.link_id_hex ?? l.link_id_hex), h(v.wrapped_keys_hex)).ok).toBe(false); break;
      case 'ephemeral': expect(() => sharedSecret(a, h(v.claiming_pub))).toThrow(); break;
      case 'code_entry': expect(typedCodeMatches(v.typed, v.showing_device_code)).toBe(false); break;
      case 'code': expect(typedCodeMatches(v.claiming_device_code, v.showing_device_code)).toBe(false); break;
      case 'claim_tag': {
        const recomputed = linkKeys({ ...params, claimingPub: h(v.claiming_pub_seen_by_showing_device), sharedSecret: sharedSecret(a, h(v.claiming_pub_seen_by_showing_device)) }).claimTag;
        expect(hex(recomputed)).toBe(v.recomputed_tag); expect(ctEqual(recomputed, h(v.presented_tag))).toBe(false); break;
      }
      default: throw new Error('unhandled link vector kind');
    }
  });
});
describe('link hostile inputs and lifecycle helpers', () => {
  it('accepts local development origins and rejects insecure or noncanonical origins', () => {
    for (const origin of ['https://example.test', 'http://localhost', 'http://127.0.0.1:1420', 'http://[::1]:1420']) { expect(validOrigin(origin)).toBe(true); expect(parseQr(formatQr(origin, id, secret, A)).ok).toBe(true); }
    for (const origin of ['http://example.test', 'https://example.test/', 'https://example.test:443', 'https://user:pass@example.test', 'https://EXAMPLE.test', 'https://example.test?x', 'https://example.test/path', 'file://localhost', null]) expect(validOrigin(origin)).toBe(false);
  });
  it('rejects malformed pins atomically and clones validated history', () => {
    const pin = l.wrapped_keys.pins[0];
    for (const bad of [null, [], { ...pin, user_id: '' }, { ...pin, user_id: 'é'.repeat(65) }, { ...pin, verified: 1 }, { ...pin, key_rev: 0 }, { ...pin, history: [null] }, { ...pin, identity_key: 'AA' }, { ...pin, history: [{ key_rev: 0x100000000, identity_key: pin.identity_key }] }]) expect(validatePins([pin, bad]).ok).toBe(false);
    const accepted = unwrap(validatePins([pin])); accepted[0].history.length = 0; expect(pin.history.length).toBeGreaterThan(0);
  });
  it('drops unverified then oldest pins to meet the size cap and preserves local pins on merge', () => {
    const pin = l.wrapped_keys.pins[0];
    const many = Array.from({ length: 150 }, (_, i) => ({ ...pin, user_id: String(i), verified: i >= 100 }));
    const fitted = fitPins(many); expect(utf8(JSON.stringify(fitted)).length + 77).toBeLessThanOrEqual(65536); expect(fitted.length).toBeLessThan(many.length);
    const blob = sealWrappedKeys(h(l.wrap_key), id, h(l.wrapped_keys.identity_seed), 1, many); expect(blob.length).toBeLessThanOrEqual(65536);
    const merged = unwrap(mergePins([pin], [{ ...pin, verified: !pin.verified }, { ...pin, user_id: 'new' }])); expect(merged).toHaveLength(2); expect(merged[0]).toEqual(pin);
  });
  it('makes fresh ephemeral pairs and rejects zero shared secrets', () => {
    const x = newEphemeral(), y = newEphemeral(); expect(x.priv).not.toEqual(y.priv); expect(sharedSecret(x.priv, y.pub)).toEqual(sharedSecret(y.priv, x.pub));
    expect(newEphemeral(() => a).pub).toEqual(A);
    expect(() => linkKeys({ ...params, sharedSecret: new Uint8Array(32) })).toThrow();
    expect(typedCodeMatches(null, '94')).toBe(false); expect(typedCodeMatches('94', 94)).toBe(false);
  });
});
