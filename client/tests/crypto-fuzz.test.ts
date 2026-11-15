import { expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import raw from './vectors/dm-v1.json';
import link from './vectors/link-v1.json';
import { openMessage, parseEnvelope, unpad, validateFileRef, validatePayload } from '../src/crypto/dm';
import { parseIdentityKey, parseStoredIdentity, unb64u } from '../src/crypto/identity';
import { openBackup, parseBackup, wordsToRecoveryKey } from '../src/crypto/backup';
import { openWrappedKeys, parseDeepLink, parseQr, validatePins } from '../src/crypto/link';
const h = (s: string) => new Uint8Array(Buffer.from(s, 'hex'));
const key = h(raw.conversation.conversation_key);
const context = { key, channelId: raw.channel_id, senderId: raw.user_ids.alice, recipientId: raw.user_ids.bob };
it('rejects 4000 deterministic random/mutated envelopes without throwing or decrypting', () => {
  // Synthetic fuzzer only. Production randomness never uses this PRNG.
  let state = 0x7240a1;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  const original = h(raw.messages[0].envelope_hex);
  for (let i = 0; i < 4000; i++) {
    let envelope: Uint8Array;
    if (i % 2 === 0) { envelope = original.slice(); envelope[next() % envelope.length] ^= 1 << (next() % 8); }
    else envelope = Uint8Array.from({ length: next() % 17000 }, () => next() & 255);
    expect(openMessage({ ...context, envelope }).ok).toBe(false);
    const encoded = Buffer.from(envelope).toString('base64url'); expect(openMessage({ ...context, envelope: encoded }).ok).toBe(false);
    expect(openBackup(envelope, key, h(raw.identities[0].identity_key_hex)).ok).toBe(false);
    expect(openWrappedKeys(h(link.wrap_key), h(link.link_id_hex), envelope).ok).toBe(false);
  }
}, 15000);
it('returns typed failures for malformed parser inputs', () => {
  const hostile: unknown[] = [null, undefined, false, 1, 1n, Symbol('synthetic'), [], {}, new Uint8Array(), '', '\u0000', 'not json', { v: 1, text: 2 }];
  for (const parser of [parseEnvelope, unpad, validateFileRef, validatePayload, parseIdentityKey, parseStoredIdentity, unb64u, parseBackup, wordsToRecoveryKey, parseQr, parseDeepLink, validatePins]) {
    for (const input of hostile) {
      if (parser === unb64u && input === '') continue; // Empty byte string is valid base64url.
      if (parser === validatePins && Array.isArray(input)) continue; // Empty pin list is valid.
      const result = parser(input); expect(result.ok).toBe(false);
      if (!result.ok) { expect(result.error.name).toBe('CryptoError'); expect(result.error.message).toBe(result.error.code); }
    }
  }
});
it('keeps pure modules free of UI, persistence, network, fixture imports and alternate randomness', () => {
  const dir = resolve('src/crypto');
  for (const file of readdirSync(dir).filter(f => f.endsWith('.ts') && !f.endsWith('.d.ts'))) {
    const source = readFileSync(resolve(dir, file), 'utf8');
    expect(source).not.toMatch(/Math\.random|\bfetch\s*\(|\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b|\bconsole\.|\bdocument\.|tests\/vectors|\bfixed\s*\(/);
  }
});
