import { serverList } from './direct.mjs';
const utf8 = new TextEncoder();
export function encode(bytes) {
  let s = ''; for (const byte of bytes) s += String.fromCharCode(byte);
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
export function decode(s, min = 0, max = 65536) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s) || s.length > Math.ceil(max * 4 / 3)) throw new Error('Invalid encoding.');
  const b = Uint8Array.from(atob(s.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
  if (b.length < min || b.length > max || encode(b) !== s) throw new Error('Invalid encoding.');
  return b;
}
export function envelope(value) {
  if (!value || Object.keys(value).sort().join(',') !== 'ciphertext,format,iv' || value.format !== 1) throw new Error('Invalid encrypted envelope.');
  decode(value.iv, 12, 12); decode(value.ciphertext, 16, 65536); return value;
}
export async function vaultKey(exportKey, binding) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(binding)) throw new Error('Invalid account binding.');
  const raw = decode(exportKey, 32, 128);
  try {
    const source = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
    return await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: utf8.encode(binding), info: utf8.encode('housecall portal vault key v1') }, source, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  } finally { raw.fill(0); }
}
function aad(binding, revision) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(binding) || !Number.isSafeInteger(revision) || revision < 1) throw new Error('Invalid vault binding.');
  return utf8.encode(`housecall portal vault v1\0${binding}\0${revision}`);
}
export async function seal(key, binding, revision, list) {
  const plaintext = utf8.encode(JSON.stringify(serverList(list)));
  if (plaintext.length > 65520) throw new Error('Server list too large.');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  try {
    return { format: 1, iv: encode(iv), ciphertext: encode(new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(binding, revision) }, key, plaintext))) };
  } finally { plaintext.fill(0); }
}
export async function open(key, binding, revision, value) {
  envelope(value);
  const bytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(value.iv), additionalData: aad(binding, revision) }, key, decode(value.ciphertext)));
  try { return serverList(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); }
  finally { bytes.fill(0); }
}
