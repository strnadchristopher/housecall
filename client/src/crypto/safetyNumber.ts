import { sha256 } from '@noble/hashes/sha2.js';
import { cmpBytes, concat, unwrap, utf8 } from './common';
import { parseIdentityKey } from './identity';
export function safetyNumber(a: Uint8Array, b: Uint8Array): string {
  unwrap(parseIdentityKey(a)); unwrap(parseIdentityKey(b));
  const [lo, hi] = cmpBytes(a, b) <= 0 ? [a, b] : [b, a];
  const d = sha256(concat(utf8('housecall safety number v1'), lo, hi));
  return Array.from({ length: 6 }, (_, g) => {
    let n = 0; for (let i = 0; i < 5; i++) n = n * 256 + d[g * 5 + i];
    return (n % 100000).toString().padStart(5, '0');
  }).join(' ');
}
