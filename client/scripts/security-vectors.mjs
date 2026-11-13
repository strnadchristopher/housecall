#!/usr/bin/env node
// Housecall 0.4.0 security test vectors: DM-V1 (docs/security/DM-V1.md) and LINK-V1
// (docs/security/LINK-V1.md).
//
// This file is the reference implementation of every byte format in those two documents.
// It uses fixed seeds and nonces so its output is byte-for-byte deterministic: running it twice
// produces identical files. Real clients draw every seed, key and nonce from the OS CSPRNG.
//
// Usage: node client/scripts/security-vectors.mjs           writes client/tests/vectors/*.json
//        node client/scripts/security-vectors.mjs --check   fails if the files on disk differ
//
// Only these libraries are used: @noble/curves, @noble/ciphers, @noble/hashes, @scure/bip39.

import { x25519, ed25519 } from "@noble/curves/ed25519.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { entropyToMnemonic, mnemonicToEntropy } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------------------------

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });
const utf8 = (s) => enc.encode(s);
const hex = (b) => Buffer.from(b).toString("hex");
const unhex = (h) => new Uint8Array(Buffer.from(h, "hex"));
const b64u = (b) => Buffer.from(b).toString("base64url");

/** Strict base64url without padding: rejects '=', '+', '/', whitespace and non-canonical tails. */
function unb64u(s) {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) throw new Error("bad base64url");
  const out = new Uint8Array(Buffer.from(s, "base64url"));
  if (b64u(out) !== s) throw new Error("non-canonical base64url");
  return out;
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function u16be(n) {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff) throw new Error("u16 out of range");
  return new Uint8Array([n >>> 8, n & 0xff]);
}
function u32be(n) {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new Error("u32 out of range");
  return new Uint8Array([n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}
const readU32 = (b, o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
/** lp(x) = u16be(byte length of UTF-8 x) ‖ UTF-8 x. Used for server ids (user, channel). */
function lp(s) {
  const b = utf8(s);
  return concat(u16be(b.length), b);
}
function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
/** Fixed test bytes: SHA-256("housecall test vector " ‖ name), truncated. Never used in clients. */
const fixed = (name, n = 32) => sha256(utf8(`housecall test vector ${name}`)).slice(0, n);
const H = (ikm, salt, info, n) => hkdf(sha256, ikm, salt, utf8(info), n);

function aeadSeal(key, nonce, plaintext, ad) {
  return xchacha20poly1305(key, nonce, ad).encrypt(plaintext);
}
function aeadOpen(key, nonce, ciphertext, ad) {
  return xchacha20poly1305(key, nonce, ad).decrypt(ciphertext); // throws "invalid tag"
}
/** X25519 that refuses small-order peer keys (all-zero output). noble throws on that case. */
function dh(priv, pub) {
  if (pub.length !== 32) throw new Error("bad public key length");
  return x25519.getSharedSecret(priv, pub);
}

// ---------------------------------------------------------------------------------------------
// DM-V1 section 3: identity
// ---------------------------------------------------------------------------------------------

const ID_SALT = utf8("housecall identity v1");
const KEY_VERSION = 0x01;

function deriveIdentity(seed) {
  if (seed.length !== 32) throw new Error("identity seed must be 32 bytes");
  const agreePriv = H(seed, ID_SALT, "agree", 32);
  const signSeed = H(seed, ID_SALT, "sign", 32);
  const agreePub = x25519.getPublicKey(agreePriv);
  const signPub = ed25519.getPublicKey(signSeed);
  const identityKey = concat(new Uint8Array([KEY_VERSION]), agreePub, signPub); // 65 bytes
  return { seed, agreePriv, signSeed, agreePub, signPub, identityKey };
}

/** Parses and validates a published identity key (65 bytes). Throws on anything else. */
function parseIdentityKey(bytes) {
  if (bytes.length !== 65) throw new Error("identity key must be 65 bytes");
  if (bytes[0] !== KEY_VERSION) throw new Error("unknown identity key version");
  const agreePub = bytes.slice(1, 33);
  const signPub = bytes.slice(33, 65);
  ed25519.Point.fromBytes(signPub); // throws if not a valid point encoding
  if (ed25519.Point.fromBytes(signPub).isSmallOrder()) throw new Error("small-order signing key");
  // Small-order X25519 keys are caught by dh() at use; reject the all-zero key here too.
  if (agreePub.every((b) => b === 0)) throw new Error("zero agreement key");
  return { agreePub, signPub };
}

// ---------------------------------------------------------------------------------------------
// DM-V1 section 4: recovery key and key_backup
// ---------------------------------------------------------------------------------------------

const BACKUP_VERSION = 0x01;
const BACKUP_LEN = 1 + 4 + 24 + 32 + 16; // 77

function recoveryKey(seed, recoveryRev) {
  return hkdf(sha256, seed, utf8("housecall recovery v1"), concat(utf8("recovery key"), u32be(recoveryRev)), 32);
}
const recoveryWords = (r) => entropyToMnemonic(r, wordlist);
/** Normalises typed words: NFKD, lower case, split on any whitespace, single spaces. */
const normaliseWords = (s) => s.normalize("NFKD").toLowerCase().trim().split(/\s+/).join(" ");
function wordsToRecoveryKey(typed) {
  const words = normaliseWords(typed);
  if (words.split(" ").length !== 24) throw new Error("need 24 words");
  const r = mnemonicToEntropy(words, wordlist); // throws on unknown word or bad checksum
  if (r.length !== 32) throw new Error("need 24 words");
  return r;
}
const backupKey = (r) => H(r, utf8("housecall backup v1"), "key backup", 32);

function sealBackup(seed, recoveryRev, nonce) {
  const r = recoveryKey(seed, recoveryRev);
  const header = concat(new Uint8Array([BACKUP_VERSION]), u32be(recoveryRev));
  const ct = aeadSeal(backupKey(r), nonce, seed, header);
  return concat(header, nonce, ct);
}
/** Returns the identity seed. `expectedIdentityKey` is the account's published key (65 bytes). */
function openBackup(blob, r, expectedIdentityKey) {
  if (blob.length !== BACKUP_LEN) throw new Error("key_backup must be 77 bytes");
  if (blob[0] !== BACKUP_VERSION) throw new Error("unknown key_backup version");
  const header = blob.slice(0, 5);
  if (readU32(blob, 1) === 0) throw new Error("recovery_rev 0 is invalid");
  const seed = aeadOpen(backupKey(r), blob.slice(5, 29), blob.slice(29), header);
  if (expectedIdentityKey && !equalBytes(deriveIdentity(seed).identityKey, expectedIdentityKey)) {
    throw new Error("backup belongs to a different identity key");
  }
  return seed;
}

// ---------------------------------------------------------------------------------------------
// DM-V1 section 5 and 6: conversation key and message envelope
// ---------------------------------------------------------------------------------------------

const ENVELOPE_VERSION = 0x01;
const PAD_BLOCK = 256;
const ENVELOPE_HEADER = 1 + 4 + 4; // version, sender_key_rev, recipient_key_rev
const MAX_PLAINTEXT = 16384; // UTF-8 JSON bytes before padding

/** Orders the two parties by the bytes of their UTF-8 user ids (lexicographic, shorter first on a tie of prefix). */
function cmpBytes(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

function conversationKey({ channelId, myId, myIdentity, peerId, peerIdentityKey }) {
  if (myId === peerId) throw new Error("a DM needs two different people");
  const peer = parseIdentityKey(peerIdentityKey);
  const ss = dh(myIdentity.agreePriv, peer.agreePub);
  const me = { id: myId, key: myIdentity.identityKey };
  const them = { id: peerId, key: peerIdentityKey };
  const [lo, hi] = cmpBytes(utf8(me.id), utf8(them.id)) < 0 ? [me, them] : [them, me];
  const info = concat(utf8("housecall dm v1"), lp(lo.id), lo.key, lp(hi.id), hi.key);
  return hkdf(sha256, ss, utf8(channelId), info, 32);
}

function pad(p) {
  const total = Math.ceil((p.length + 1) / PAD_BLOCK) * PAD_BLOCK;
  const out = new Uint8Array(total);
  out.set(p);
  out[p.length] = 0x80;
  return out;
}
function unpad(p) {
  if (p.length === 0 || p.length % PAD_BLOCK !== 0) throw new Error("bad padding length");
  let i = p.length - 1;
  while (i >= 0 && p[i] === 0) i--;
  if (i < 0 || p[i] !== 0x80) throw new Error("bad padding");
  if (p.length - i > PAD_BLOCK) throw new Error("bad padding");
  return p.slice(0, i);
}

function messageAd(header, channelId, senderId, recipientId) {
  return concat(header, lp(channelId), lp(senderId), lp(recipientId));
}

function sealMessage({ key, channelId, senderId, recipientId, senderKeyRev, recipientKeyRev, payload, nonce }) {
  const json = utf8(JSON.stringify(payload));
  if (json.length > MAX_PLAINTEXT) throw new Error("message too long");
  const header = concat(new Uint8Array([ENVELOPE_VERSION]), u32be(senderKeyRev), u32be(recipientKeyRev));
  const ct = aeadSeal(key, nonce, pad(json), messageAd(header, channelId, senderId, recipientId));
  return concat(header, nonce, ct);
}

/** Parses an envelope without decrypting. The server runs exactly these checks too. */
function parseEnvelope(env) {
  if (env.length < ENVELOPE_HEADER + 24 + PAD_BLOCK + 16) throw new Error("envelope too short");
  if ((env.length - ENVELOPE_HEADER - 24 - 16) % PAD_BLOCK !== 0) throw new Error("envelope length not on a pad boundary");
  if (env.length > ENVELOPE_HEADER + 24 + (MAX_PLAINTEXT + PAD_BLOCK) + 16) throw new Error("envelope too long");
  if (env[0] !== ENVELOPE_VERSION) throw new Error("unknown envelope version");
  const senderKeyRev = readU32(env, 1);
  const recipientKeyRev = readU32(env, 5);
  if (senderKeyRev === 0 || recipientKeyRev === 0) throw new Error("key_rev 0 is invalid");
  return { header: env.slice(0, 9), senderKeyRev, recipientKeyRev, nonce: env.slice(9, 33), ct: env.slice(33) };
}

function openMessage({ key, channelId, senderId, recipientId, envelope }) {
  const e = parseEnvelope(envelope);
  const p = aeadOpen(key, e.nonce, e.ct, messageAd(e.header, channelId, senderId, recipientId));
  const payload = JSON.parse(dec.decode(unpad(p)));
  if (typeof payload !== "object" || payload === null || payload.v !== 1 || typeof payload.text !== "string") {
    throw new Error("bad payload");
  }
  return { ...e, payload };
}

// ---------------------------------------------------------------------------------------------
// DM-V1 section 7: attachments
// ---------------------------------------------------------------------------------------------

const FILE_VERSION = 0x01;
const FILE_CHUNK = 65536;

function sealFile(fileKey, prefix, plaintext, chunk = FILE_CHUNK) {
  if (prefix.length !== 19) throw new Error("nonce prefix must be 19 bytes");
  const header = concat(new Uint8Array([FILE_VERSION]), prefix);
  const parts = [header];
  const count = Math.max(1, Math.ceil(plaintext.length / chunk));
  for (let i = 0; i < count; i++) {
    const last = i === count - 1 ? 1 : 0;
    const nonce = concat(prefix, u32be(i), new Uint8Array([last]));
    parts.push(aeadSeal(fileKey, nonce, plaintext.slice(i * chunk, (i + 1) * chunk), header));
  }
  return concat(...parts);
}

function openFile(fileKey, blob, chunk = FILE_CHUNK) {
  if (blob.length < 20 + 16) throw new Error("file too short");
  if (blob[0] !== FILE_VERSION) throw new Error("unknown file version");
  const header = blob.slice(0, 20);
  const prefix = blob.slice(1, 20);
  const body = blob.slice(20);
  const full = chunk + 16;
  const count = Math.max(1, Math.ceil(body.length / full));
  const out = [];
  for (let i = 0; i < count; i++) {
    const piece = body.slice(i * full, (i + 1) * full);
    const last = i === count - 1 ? 1 : 0;
    if (piece.length < 16) throw new Error("truncated chunk");
    if (!last && piece.length !== full) throw new Error("short middle chunk");
    const nonce = concat(prefix, u32be(i), new Uint8Array([last]));
    out.push(aeadOpen(fileKey, nonce, piece, header)); // a truncated file fails here: its new last chunk was sealed with last=0
  }
  return concat(...out);
}

// ---------------------------------------------------------------------------------------------
// DM-V1 section 8: safety number
// ---------------------------------------------------------------------------------------------

function safetyNumber(keyA, keyB) {
  parseIdentityKey(keyA);
  parseIdentityKey(keyB);
  const [lo, hi] = cmpBytes(keyA, keyB) <= 0 ? [keyA, keyB] : [keyB, keyA];
  const d = sha256(concat(utf8("housecall safety number v1"), lo, hi));
  const groups = [];
  for (let g = 0; g < 6; g++) {
    let n = 0n;
    for (let i = 0; i < 5; i++) n = (n << 8n) | BigInt(d[g * 5 + i]);
    groups.push((n % 100000n).toString().padStart(5, "0"));
  }
  return groups.join(" ");
}

// ---------------------------------------------------------------------------------------------
// LINK-V1: QR payload, transcript, claim tag, confirmation number, wrapped_keys
// ---------------------------------------------------------------------------------------------

const WRAP_VERSION = 0x01;

function qrUrl(origin, linkId, secret, showingPub) {
  return `${origin}/link#hcl1.${hex(linkId)}.${b64u(secret)}.${b64u(showingPub)}`;
}
function deepLink(origin, linkId, secret, showingPub) {
  return `housecall://link?c=hcl1.${b64u(utf8(origin))}.${hex(linkId)}.${b64u(secret)}.${b64u(showingPub)}`;
}

function validOrigin(origin) {
  let u;
  try { u = new URL(origin); } catch { return false; }
  if (u.origin !== origin) return false; // no path, query, fragment, credentials, trailing slash
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]");
}

function parseLinkFields(parts) {
  const [tag, linkHex, secretB, pubB] = parts;
  if (tag !== "hcl1") throw new Error("not a Housecall link code");
  if (!/^[0-9a-f]{32}$/.test(linkHex)) throw new Error("bad link id");
  const secret = unb64u(secretB);
  const showingPub = unb64u(pubB);
  if (secret.length !== 32 || showingPub.length !== 32) throw new Error("bad link code");
  return { linkId: unhex(linkHex), secret, showingPub };
}

/** Parses the text a camera read from the QR code. */
function parseQr(text) {
  if (text.length > 512) throw new Error("too long");
  const hash = text.indexOf("#");
  if (hash < 0) throw new Error("no fragment");
  const before = text.slice(0, hash);
  if (!before.endsWith("/link")) throw new Error("wrong path");
  const origin = before.slice(0, -"/link".length);
  if (!validOrigin(origin)) throw new Error("bad origin");
  const parts = text.slice(hash + 1).split(".");
  if (parts.length !== 4) throw new Error("bad link code");
  return { origin, ...parseLinkFields(parts) };
}

/** Parses housecall://link?c=… */
function parseDeepLink(text) {
  const prefix = "housecall://link?c=";
  if (!text.startsWith(prefix) || text.length > 600) throw new Error("not a link deep link");
  const parts = text.slice(prefix.length).split(".");
  if (parts.length !== 5) throw new Error("bad link code");
  const origin = dec.decode(unb64u(parts[1]));
  if (!validOrigin(origin)) throw new Error("bad origin");
  return { origin, ...parseLinkFields([parts[0], parts[2], parts[3], parts[4]]) };
}

function linkKeys({ linkId, secret, showingPub, claimingPub, sharedSecret }) {
  const salt = sha256(concat(utf8("housecall link v1"), linkId, secret, showingPub, claimingPub));
  const wrapKey = H(sharedSecret, salt, "housecall link v1 wrap", 32);
  const claimTag = H(sharedSecret, salt, "housecall link v1 claim", 16);
  const codeBytes = H(sharedSecret, salt, "housecall link v1 code", 4);
  const code = (readU32(codeBytes, 0) % 100).toString().padStart(2, "0");
  return { salt, wrapKey, claimTag, codeBytes, code };
}

/** plaintext = seed (32) ‖ u32be(recovery_rev) ‖ UTF-8 JSON array of pins */
function sealWrappedKeys(wrapKey, linkId, nonce, identitySeed, recoveryRev, pins) {
  if (recoveryRev < 1) throw new Error("recovery_rev must be at least 1");
  const plaintext = concat(identitySeed, u32be(recoveryRev), utf8(JSON.stringify(pins)));
  const header = new Uint8Array([WRAP_VERSION]);
  const ct = aeadSeal(wrapKey, nonce, plaintext, concat(header, linkId));
  return concat(header, nonce, ct);
}
const WRAP_MIN = 1 + 24 + 32 + 4 + 2 + 16; // 79: empty pin list "[]"
function openWrappedKeys(wrapKey, linkId, blob) {
  if (blob.length > 65536) throw new Error("wrapped_keys too long");
  if (blob.length < 1) throw new Error("wrapped_keys too short");
  if (blob[0] !== WRAP_VERSION) throw new Error("unknown wrapped_keys version");
  if (blob.length < WRAP_MIN) throw new Error("wrapped_keys too short");
  const p = aeadOpen(wrapKey, blob.slice(1, 25), blob.slice(25), concat(blob.slice(0, 1), linkId));
  const recoveryRev = readU32(p, 32);
  if (recoveryRev === 0) throw new Error("recovery_rev 0 is invalid");
  const pins = JSON.parse(dec.decode(p.slice(36)));
  if (!Array.isArray(pins)) throw new Error("pins must be an array");
  return { identitySeed: p.slice(0, 32), recoveryRev, pins };
}

// ---------------------------------------------------------------------------------------------
// Vector builders
// ---------------------------------------------------------------------------------------------

/** Runs fn and records the error message; fails the generator if fn does not throw. */
function mustFail(name, fn) {
  try {
    fn();
  } catch (e) {
    return e.message;
  }
  throw new Error(`negative vector "${name}" unexpectedly succeeded`);
}
function flip(bytes, index) {
  const out = bytes.slice();
  out[index] ^= 0x01;
  return out;
}

function buildDm() {
  const alice = deriveIdentity(fixed("alice identity seed"));
  const bob = deriveIdentity(fixed("bob identity seed"));
  const mallory = deriveIdentity(fixed("mallory identity seed"));
  const ids = {
    alice: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
    bob: "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0",
  };
  const channelId = "5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e";

  const identity = (who, i) => ({
    name: who,
    seed: hex(i.seed),
    agree_priv: hex(i.agreePriv),
    sign_seed: hex(i.signSeed),
    agree_pub: hex(i.agreePub),
    sign_pub: hex(i.signPub),
    identity_key_hex: hex(i.identityKey),
    identity_key_b64u: b64u(i.identityKey),
  });

  // Recovery key and backup (alice, recovery_rev 1 and 2).
  const r1 = recoveryKey(alice.seed, 1);
  const r2 = recoveryKey(alice.seed, 2);
  const backupNonce = fixed("alice backup nonce", 24);
  const backup1 = sealBackup(alice.seed, 1, backupNonce);
  const backup2 = sealBackup(alice.seed, 2, backupNonce);
  if (!equalBytes(openBackup(backup1, wordsToRecoveryKey(recoveryWords(r1)), alice.identityKey), alice.seed)) {
    throw new Error("backup round trip failed");
  }
  const words1 = recoveryWords(r1).split(" ");
  const swapped = words1.slice();
  [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
  const messyWords = "  " + words1.map((w, i) => (i % 3 === 0 ? w.toUpperCase() : w)).join("  \n ") + " ";

  // Conversation key, both directions must agree.
  const kAB = conversationKey({ channelId, myId: ids.alice, myIdentity: alice, peerId: ids.bob, peerIdentityKey: bob.identityKey });
  const kBA = conversationKey({ channelId, myId: ids.bob, myIdentity: bob, peerId: ids.alice, peerIdentityKey: alice.identityKey });
  if (!equalBytes(kAB, kBA)) throw new Error("conversation keys disagree");
  const sharedSecret = dh(alice.agreePriv, bob.agreePub);

  const fileKey = fixed("photo file key");
  const filePrefix = fixed("photo nonce prefix", 19);
  const filePlain = new Uint8Array(FILE_CHUNK * 2 + 100).map((_, i) => (i * 31 + 7) & 0xff);
  const fileBlob = sealFile(fileKey, filePrefix, filePlain);
  if (!equalBytes(openFile(fileKey, fileBlob), filePlain)) throw new Error("file round trip failed");
  const emptyBlob = sealFile(fileKey, filePrefix, new Uint8Array(0));

  const msgs = [
    {
      name: "text from alice",
      sender: "alice",
      payload: { v: 1, text: "Hello Bob. Lunch at noon?" },
      nonce: fixed("message nonce 1", 24),
      sender_key_rev: 1,
      recipient_key_rev: 1,
    },
    {
      name: "reply from bob, alice on key_rev 2, unicode",
      sender: "bob",
      payload: { v: 1, text: "Yes. Ça marche 👍" },
      nonce: fixed("message nonce 2", 24),
      sender_key_rev: 1,
      recipient_key_rev: 2,
    },
    {
      name: "photo from alice",
      sender: "alice",
      payload: {
        v: 1,
        text: "",
        files: [{ id: "7d0c3a8e-5b1f-4c2a-9e6d-1f2a3b4c5d6e", key: b64u(fileKey), name: "lunch.jpg", mime: "image/jpeg", size: filePlain.length, w: 1200, h: 900 }],
      },
      nonce: fixed("message nonce 3", 24),
      sender_key_rev: 1,
      recipient_key_rev: 1,
    },
    {
      name: "text exactly filling one pad block minus the marker (255 bytes of JSON)",
      sender: "alice",
      payload: { v: 1, text: "x".repeat(255 - JSON.stringify({ v: 1, text: "" }).length) },
      nonce: fixed("message nonce 4", 24),
      sender_key_rev: 1,
      recipient_key_rev: 1,
    },
    {
      name: "256 bytes of JSON: the 0x80 marker forces a second pad block",
      sender: "alice",
      payload: { v: 1, text: "y".repeat(256 - JSON.stringify({ v: 1, text: "" }).length) },
      nonce: fixed("message nonce 5", 24),
      sender_key_rev: 1,
      recipient_key_rev: 1,
    },
  ].map((m) => {
    const senderId = ids[m.sender];
    const recipientId = m.sender === "alice" ? ids.bob : ids.alice;
    const envelope = sealMessage({ key: kAB, channelId, senderId, recipientId, senderKeyRev: m.sender_key_rev, recipientKeyRev: m.recipient_key_rev, payload: m.payload, nonce: m.nonce });
    const opened = openMessage({ key: kBA, channelId, senderId, recipientId, envelope });
    if (JSON.stringify(opened.payload) !== JSON.stringify(m.payload)) throw new Error("message round trip failed");
    const header = envelope.slice(0, 9);
    return {
      name: m.name,
      sender_id: senderId,
      recipient_id: recipientId,
      sender_key_rev: m.sender_key_rev,
      recipient_key_rev: m.recipient_key_rev,
      nonce: hex(m.nonce),
      payload: m.payload,
      plaintext_json_utf8_hex: hex(utf8(JSON.stringify(m.payload))),
      padded_hex: hex(pad(utf8(JSON.stringify(m.payload)))),
      associated_data_hex: hex(messageAd(header, channelId, senderId, recipientId)),
      envelope_hex: hex(envelope),
      envelope_b64u: b64u(envelope),
    };
  });

  const good = unhex(msgs[0].envelope_hex);
  const open = (overrides) => openMessage({ key: kBA, channelId, senderId: ids.alice, recipientId: ids.bob, envelope: good, ...overrides });
  const kMallory = conversationKey({ channelId, myId: ids.bob, myIdentity: mallory, peerId: ids.alice, peerIdentityKey: alice.identityKey });
  const kOtherChannel = conversationKey({ channelId: channelId.replace(/^5/, "6"), myId: ids.bob, myIdentity: bob, peerId: ids.alice, peerIdentityKey: alice.identityKey });
  const badVersion = good.slice(); badVersion[0] = 0x02;
  const revZero = good.slice(); revZero.set(u32be(0), 1);
  const revChanged = good.slice(); revChanged.set(u32be(2), 1);
  const replayed = { first_server_message_id: "m1", second_server_message_id: "m2", envelope_hex: msgs[0].envelope_hex };

  // Envelope built over a payload whose padding is wrong (sealed by hand to reach unpad).
  const header = good.slice(0, 9);
  const noMarker = new Uint8Array(256).fill(0x41);
  const badPadEnvelope = concat(header, unhex(msgs[0].nonce), aeadSeal(kAB, unhex(msgs[0].nonce), noMarker, messageAd(header, channelId, ids.alice, ids.bob)));
  const notJson = pad(utf8("not json"));
  const notJsonEnvelope = concat(header, unhex(msgs[0].nonce), aeadSeal(kAB, unhex(msgs[0].nonce), notJson, messageAd(header, channelId, ids.alice, ids.bob)));

  const negatives = [
    { name: "wrong key (recipient is not bob)", kind: "message", envelope_hex: hex(good), key_hex: hex(kMallory), expect: "reject", error: mustFail("wrong key", () => open({ key: kMallory })) },
    { name: "wrong channel (key derived for another DM)", kind: "message", envelope_hex: hex(good), key_hex: hex(kOtherChannel), expect: "reject", error: mustFail("wrong channel", () => open({ key: kOtherChannel })) },
    { name: "associated data altered: sender relabelled as bob", kind: "message", envelope_hex: hex(good), sender_id: ids.bob, recipient_id: ids.alice, expect: "reject", error: mustFail("sender swap", () => open({ senderId: ids.bob, recipientId: ids.alice })) },
    { name: "associated data altered: other channel id", kind: "message", envelope_hex: hex(good), channel_id: channelId.replace(/^5/, "6"), expect: "reject", error: mustFail("channel ad", () => open({ channelId: channelId.replace(/^5/, "6") })) },
    { name: "associated data altered: sender_key_rev changed in header", kind: "message", envelope_hex: hex(revChanged), expect: "reject", error: mustFail("rev changed", () => open({ envelope: revChanged })) },
    { name: "ciphertext bit flipped", kind: "message", envelope_hex: hex(flip(good, 40)), expect: "reject", error: mustFail("bitflip", () => open({ envelope: flip(good, 40) })) },
    { name: "tag bit flipped", kind: "message", envelope_hex: hex(flip(good, good.length - 1)), expect: "reject", error: mustFail("tagflip", () => open({ envelope: flip(good, good.length - 1) })) },
    { name: "nonce bit flipped", kind: "message", envelope_hex: hex(flip(good, 10)), expect: "reject", error: mustFail("nonceflip", () => open({ envelope: flip(good, 10) })) },
    { name: "truncated by 1 byte", kind: "message", envelope_hex: hex(good.slice(0, -1)), expect: "reject", server_expect: 422, error: mustFail("trunc1", () => open({ envelope: good.slice(0, -1) })) },
    { name: "truncated by one whole pad block", kind: "message", envelope_hex: hex(good.slice(0, good.length - PAD_BLOCK)), expect: "reject", server_expect: 422, error: mustFail("truncblock", () => open({ envelope: good.slice(0, good.length - PAD_BLOCK) })) },
    { name: "wrong version byte 0x02", kind: "message", envelope_hex: hex(badVersion), expect: "reject", server_expect: 422, error: mustFail("version", () => open({ envelope: badVersion })) },
    { name: "key_rev 0 in header", kind: "message", envelope_hex: hex(revZero), expect: "reject", server_expect: 422, error: mustFail("rev0", () => open({ envelope: revZero })) },
    { name: "padding without 0x80 marker", kind: "message", envelope_hex: hex(badPadEnvelope), expect: "reject", error: mustFail("pad", () => open({ envelope: badPadEnvelope })) },
    { name: "padded plaintext is not JSON", kind: "message", envelope_hex: hex(notJsonEnvelope), expect: "reject", error: mustFail("json", () => open({ envelope: notJsonEnvelope })) },
    { name: "replayed envelope under a second server message id", kind: "replay", ...replayed, expect: "show once: the second message is a duplicate of the first (same nonce)" },
    { name: "small-order peer agreement key (all zero)", kind: "identity_key", identity_key_hex: hex(concat(new Uint8Array([1]), new Uint8Array(32), bob.signPub)), expect: "reject", error: mustFail("zero key", () => conversationKey({ channelId, myId: ids.alice, myIdentity: alice, peerId: ids.bob, peerIdentityKey: concat(new Uint8Array([1]), new Uint8Array(32), bob.signPub) })) },
    { name: "small-order peer agreement key (order 8 point)", kind: "identity_key", identity_key_hex: hex(concat(new Uint8Array([1]), unhex("5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157"), bob.signPub)), expect: "reject", error: mustFail("order8", () => conversationKey({ channelId, myId: ids.alice, myIdentity: alice, peerId: ids.bob, peerIdentityKey: concat(new Uint8Array([1]), unhex("5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157"), bob.signPub) })) },
    { name: "identity key with version byte 0x02", kind: "identity_key", identity_key_hex: hex(concat(new Uint8Array([2]), bob.agreePub, bob.signPub)), expect: "reject", server_expect: 400, error: mustFail("idver", () => parseIdentityKey(concat(new Uint8Array([2]), bob.agreePub, bob.signPub))) },
    { name: "identity key 64 bytes (no version byte)", kind: "identity_key", identity_key_hex: hex(concat(bob.agreePub, bob.signPub)), expect: "reject", server_expect: 400, error: mustFail("idlen", () => parseIdentityKey(concat(bob.agreePub, bob.signPub))) },
    { name: "wrong recovery words: last word changed (checksum fails)", kind: "recovery_words", words: [...words1.slice(0, 23), words1[23] === "abandon" ? "ability" : "abandon"].join(" "), expect: "reject", error: mustFail("checksum", () => wordsToRecoveryKey([...words1.slice(0, 23), words1[23] === "abandon" ? "ability" : "abandon"].join(" "))) },
    { name: "wrong recovery words: a word not in the list", kind: "recovery_words", words: ["housecall", ...words1.slice(1)].join(" "), expect: "reject", error: mustFail("unknown word", () => wordsToRecoveryKey(["housecall", ...words1.slice(1)].join(" "))) },
    { name: "wrong recovery words: 23 words", kind: "recovery_words", words: words1.slice(0, 23).join(" "), expect: "reject", error: mustFail("23", () => wordsToRecoveryKey(words1.slice(0, 23).join(" "))) },
    { name: "wrong recovery words: valid checksum, other person's recovery key", kind: "key_backup", words: recoveryWords(recoveryKey(bob.seed, 1)), key_backup_hex: hex(backup1), expect: "reject", error: mustFail("bob words", () => openBackup(backup1, wordsToRecoveryKey(recoveryWords(recoveryKey(bob.seed, 1))), alice.identityKey)) },
    { name: "old recovery words (recovery_rev 1) against replaced backup (recovery_rev 2)", kind: "key_backup", words: recoveryWords(r1), key_backup_hex: hex(backup2), expect: "reject", error: mustFail("old words", () => openBackup(backup2, r1, alice.identityKey)) },
    { name: "key_backup header altered (recovery_rev 1 -> 3)", kind: "key_backup", words: recoveryWords(r1), key_backup_hex: hex((() => { const b = backup1.slice(); b.set(u32be(3), 1); return b; })()), expect: "reject", error: mustFail("backup hdr", () => { const b = backup1.slice(); b.set(u32be(3), 1); return openBackup(b, r1, alice.identityKey); }) },
    { name: "key_backup wrong version byte", kind: "key_backup", words: recoveryWords(r1), key_backup_hex: hex((() => { const b = backup1.slice(); b[0] = 2; return b; })()), expect: "reject", server_expect: 400, error: mustFail("backup ver", () => { const b = backup1.slice(); b[0] = 2; return openBackup(b, r1, alice.identityKey); }) },
    { name: "key_backup truncated", kind: "key_backup", words: recoveryWords(r1), key_backup_hex: hex(backup1.slice(0, 76)), expect: "reject", server_expect: 400, error: mustFail("backup trunc", () => openBackup(backup1.slice(0, 76), r1, alice.identityKey)) },
    { name: "key_backup opens but belongs to another identity key", kind: "key_backup", words: recoveryWords(r1), key_backup_hex: hex(backup1), expected_identity_key_hex: hex(bob.identityKey), expect: "reject", error: mustFail("backup identity", () => openBackup(backup1, r1, bob.identityKey)) },
    { name: "file truncated: last chunk removed", kind: "file", file_key_hex: hex(fileKey), blob_hex_sha256: hex(sha256(fileBlob.slice(0, 20 + 2 * (FILE_CHUNK + 16)))), cut_at: 20 + 2 * (FILE_CHUNK + 16), expect: "reject", error: mustFail("file trunc", () => openFile(fileKey, fileBlob.slice(0, 20 + 2 * (FILE_CHUNK + 16)))) },
    { name: "file truncated: 1 byte removed", kind: "file", file_key_hex: hex(fileKey), cut_at: fileBlob.length - 1, expect: "reject", error: mustFail("file trunc1", () => openFile(fileKey, fileBlob.slice(0, -1))) },
    { name: "file chunks reordered (chunk 0 and 1 swapped)", kind: "file", file_key_hex: hex(fileKey), swap_chunks: [0, 1], expect: "reject", error: mustFail("file swap", () => { const c = FILE_CHUNK + 16; return openFile(fileKey, concat(fileBlob.slice(0, 20), fileBlob.slice(20 + c, 20 + 2 * c), fileBlob.slice(20, 20 + c), fileBlob.slice(20 + 2 * c))); }) },
    { name: "file wrong key", kind: "file", file_key_hex: hex(fixed("other file key")), expect: "reject", error: mustFail("file key", () => openFile(fixed("other file key"), fileBlob)) },
    { name: "file wrong version byte", kind: "file", file_key_hex: hex(fileKey), set_byte: [0, 2], expect: "reject", error: mustFail("file ver", () => { const b = fileBlob.slice(); b[0] = 2; return openFile(fileKey, b); }) },
  ];

  return {
    spec: "docs/security/DM-V1.md",
    generator: "client/scripts/security-vectors.mjs",
    note: "Fixed seeds and nonces for testing only. Hex is lowercase; b64u is base64url without padding.",
    constants: {
      identity_salt: "housecall identity v1",
      identity_info_agree: "agree",
      identity_info_sign: "sign",
      recovery_salt: "housecall recovery v1",
      recovery_info: "\"recovery key\" ‖ u32be(recovery_rev)",
      backup_salt: "housecall backup v1",
      backup_info: "key backup",
      dm_info_prefix: "housecall dm v1",
      safety_number_prefix: "housecall safety number v1",
      pad_block: PAD_BLOCK,
      max_plaintext: MAX_PLAINTEXT,
      file_chunk: FILE_CHUNK,
    },
    identities: [identity("alice", alice), identity("bob", bob), identity("mallory", mallory)],
    user_ids: ids,
    channel_id: channelId,
    recovery: {
      identity: "alice",
      recovery_rev_1: { recovery_key: hex(r1), words: recoveryWords(r1), backup_key: hex(backupKey(r1)) },
      recovery_rev_2: { recovery_key: hex(r2), words: recoveryWords(r2), backup_key: hex(backupKey(r2)) },
      backup_nonce: hex(backupNonce),
      key_backup_rev_1_hex: hex(backup1),
      key_backup_rev_1_b64u: b64u(backup1),
      key_backup_rev_2_hex: hex(backup2),
      typed_words_messy: messyWords,
      typed_words_messy_expect: "accept (normalises to recovery_rev_1.words)",
      confirm_two_example: { positions_1_based: [7, 19], expected: [words1[6], words1[18]], typed: [words1[6].toUpperCase() + " ", " " + words1[18]], expect: "accept" },
      confirm_two_wrong: { positions_1_based: [7, 19], typed: [words1[18], words1[6]], expect: "reject" },
      words_two_swapped: { words: swapped.join(" "), expect: words1[0] === words1[1] ? "accept" : "reject (checksum or backup open fails)", error: words1[0] === words1[1] ? null : (() => { try { openBackup(backup1, wordsToRecoveryKey(swapped.join(" ")), alice.identityKey); return null; } catch (e) { return e.message; } })() },
    },
    conversation: {
      between: ["alice", "bob"],
      x25519_shared_secret: hex(sharedSecret),
      hkdf_salt_utf8: channelId,
      hkdf_info_hex: hex(concat(utf8("housecall dm v1"), ...(cmpBytes(utf8(ids.alice), utf8(ids.bob)) < 0 ? [lp(ids.alice), alice.identityKey, lp(ids.bob), bob.identityKey] : [lp(ids.bob), bob.identityKey, lp(ids.alice), alice.identityKey]))),
      conversation_key: hex(kAB),
      party_order_note: "bob's id sorts first (0x30 < 0x61), so info = prefix ‖ lp(bob) ‖ bob key ‖ lp(alice) ‖ alice key",
    },
    messages: msgs,
    attachment: {
      file_key: hex(fileKey),
      nonce_prefix: hex(filePrefix),
      plaintext_rule: "byte i = (i * 31 + 7) mod 256",
      plaintext_length: filePlain.length,
      chunk: FILE_CHUNK,
      blob_length: fileBlob.length,
      blob_sha256: hex(sha256(fileBlob)),
      blob_first_64_hex: hex(fileBlob.slice(0, 64)),
      blob_last_32_hex: hex(fileBlob.slice(-32)),
      empty_file_blob_hex: hex(emptyBlob),
    },
    safety_number: {
      alice_bob: safetyNumber(alice.identityKey, bob.identityKey),
      bob_alice: safetyNumber(bob.identityKey, alice.identityKey),
      alice_mallory: safetyNumber(alice.identityKey, mallory.identityKey),
      digest_input_hex: hex(concat(utf8("housecall safety number v1"), ...(cmpBytes(alice.identityKey, bob.identityKey) <= 0 ? [alice.identityKey, bob.identityKey] : [bob.identityKey, alice.identityKey]))),
    },
    negative: negatives,
  };
}

function buildLink() {
  const alice = deriveIdentity(fixed("alice identity seed"));
  const origin = "https://housecall.example.test";
  const linkId = fixed("link id", 16);
  const secret = fixed("link secret");
  const showingPriv = fixed("showing device ephemeral");
  const claimingPriv = fixed("claiming device ephemeral");
  const attackerPriv = fixed("attacker ephemeral");
  const showingPub = x25519.getPublicKey(showingPriv);
  const claimingPub = x25519.getPublicKey(claimingPriv);
  const attackerPub = x25519.getPublicKey(attackerPriv);

  const url = qrUrl(origin, linkId, secret, showingPub);
  const deep = deepLink(origin, linkId, secret, showingPub);
  const parsed = parseQr(url);
  const parsedDeep = parseDeepLink(deep);
  if (!equalBytes(parsed.showingPub, showingPub) || !equalBytes(parsedDeep.secret, secret) || parsedDeep.origin !== origin) throw new Error("qr parse failed");

  // Claiming device side (knows A from the QR, holds b).
  const claimSide = linkKeys({ linkId, secret, showingPub, claimingPub, sharedSecret: dh(claimingPriv, showingPub) });
  // Showing device side (holds a, learns B from the server).
  const showSide = linkKeys({ linkId, secret, showingPub, claimingPub, sharedSecret: dh(showingPriv, claimingPub) });
  if (!equalBytes(claimSide.wrapKey, showSide.wrapKey) || claimSide.code !== showSide.code) throw new Error("link sides disagree");

  // Hostile server swaps B for its own key B' but does not know A: it cannot compute a valid tag.
  // Its best guess is a tag computed with some other value; the showing device recomputes with B'.
  const showWithSwapped = linkKeys({ linkId, secret, showingPub, claimingPub: attackerPub, sharedSecret: dh(showingPriv, attackerPub) });
  // A host that learned A (browser path) can compute the right tag for B'; then only the code protects.
  const attackerSide = linkKeys({ linkId, secret, showingPub, claimingPub: attackerPub, sharedSecret: dh(attackerPriv, showingPub) });
  if (!equalBytes(attackerSide.claimTag, showWithSwapped.claimTag)) throw new Error("attacker tag mismatch");

  const pins = [
    { origin, user_id: "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0", identity_key: b64u(deriveIdentity(fixed("bob identity seed")).identityKey), key_rev: 1, verified: true },
  ];
  const wrapNonce = fixed("wrapped keys nonce", 24);
  const wrapRecoveryRev = 2;
  const wrapped = sealWrappedKeys(showSide.wrapKey, linkId, wrapNonce, alice.seed, wrapRecoveryRev, pins);
  const opened = openWrappedKeys(claimSide.wrapKey, linkId, wrapped);
  if (!equalBytes(opened.identitySeed, alice.seed) || opened.recoveryRev !== wrapRecoveryRev) throw new Error("wrapped keys round trip failed");
  const emptyPins = sealWrappedKeys(showSide.wrapKey, linkId, wrapNonce, alice.seed, 1, []);
  if (emptyPins.length !== WRAP_MIN) throw new Error("WRAP_MIN is wrong");

  const codeFor = (bytes) => (readU32(bytes, 0) % 100).toString().padStart(2, "0");
  const reductions = [
    [0x00, 0x00, 0x00, 0x00], [0x00, 0x00, 0x00, 0x63], [0x00, 0x00, 0x00, 0x64], [0xff, 0xff, 0xff, 0xff], [0x12, 0x34, 0x56, 0x78],
  ].map((b) => ({ bytes_hex: hex(new Uint8Array(b)), u32be: readU32(new Uint8Array(b), 0), code: codeFor(new Uint8Array(b)) }));

  const badVer = wrapped.slice(); badVer[0] = 2;
  const negatives = [
    { name: "claim tag from a server that swapped the claiming key and does not know A", kind: "claim_tag", claiming_pub_seen_by_showing_device: hex(attackerPub), presented_tag: hex(claimSide.claimTag), recomputed_tag: hex(showWithSwapped.claimTag), expect: "reject: tags differ, showing device denies the link" },
    { name: "mismatched confirmation number: server swapped the claiming key and knows A", kind: "code", claiming_device_code: claimSide.code, showing_device_code: showWithSwapped.code, expect: claimSide.code === showWithSwapped.code ? "codes collide (1 in 100); vector generator must pick other fixed keys" : "codes differ, the person taps Deny" },
    { name: "wrapped_keys opened with the key a swapped claim would produce", kind: "wrapped_keys", wrapped_keys_hex: hex(wrapped), wrap_key_hex: hex(showWithSwapped.wrapKey), expect: "reject", error: mustFail("wk wrong key", () => openWrappedKeys(showWithSwapped.wrapKey, linkId, wrapped)) },
    { name: "wrapped_keys bound to another link id", kind: "wrapped_keys", wrapped_keys_hex: hex(wrapped), link_id_hex: hex(fixed("other link id", 16)), expect: "reject", error: mustFail("wk link", () => openWrappedKeys(claimSide.wrapKey, fixed("other link id", 16), wrapped)) },
    { name: "wrapped_keys wrong version byte", kind: "wrapped_keys", wrapped_keys_hex: hex(badVer), expect: "reject", server_expect: 400, error: mustFail("wk ver", () => openWrappedKeys(claimSide.wrapKey, linkId, badVer)) },
    { name: "wrapped_keys truncated by 1 byte", kind: "wrapped_keys", wrapped_keys_hex: hex(wrapped.slice(0, -1)), expect: "reject", error: mustFail("wk trunc", () => openWrappedKeys(claimSide.wrapKey, linkId, wrapped.slice(0, -1))) },
    { name: "wrapped_keys ciphertext bit flipped", kind: "wrapped_keys", wrapped_keys_hex: hex(flip(wrapped, 30)), expect: "reject", error: mustFail("wk flip", () => openWrappedKeys(claimSide.wrapKey, linkId, flip(wrapped, 30))) },
    { name: "QR with a query string", kind: "qr", text: url.replace("/link#", "/link?x=1#"), expect: "reject", error: mustFail("qr query", () => parseQr(url.replace("/link#", "/link?x=1#"))) },
    { name: "QR with plain http to a public host", kind: "qr", text: url.replace("https://", "http://"), expect: "reject", error: mustFail("qr http", () => parseQr(url.replace("https://", "http://"))) },
    { name: "QR with wrong version tag hcl2", kind: "qr", text: url.replace("#hcl1.", "#hcl2."), expect: "reject", error: mustFail("qr ver", () => parseQr(url.replace("#hcl1.", "#hcl2."))) },
    { name: "QR with upper-case link id", kind: "qr", text: url.replace(hex(linkId), hex(linkId).toUpperCase()), expect: "reject", error: mustFail("qr upper", () => parseQr(url.replace(hex(linkId), hex(linkId).toUpperCase()))) },
    { name: "QR with padded base64", kind: "qr", text: url + "=", expect: "reject", error: mustFail("qr pad", () => parseQr(url + "=")) },
    { name: "QR with a fifth field", kind: "qr", text: url + ".extra", expect: "reject", error: mustFail("qr extra", () => parseQr(url + ".extra")) },
    { name: "QR with credentials in the origin", kind: "qr", text: url.replace("https://", "https://user@"), expect: "reject", error: mustFail("qr creds", () => parseQr(url.replace("https://", "https://user@"))) },
    { name: "QR with a path before /link", kind: "qr", text: url.replace("/link#", "/x/link#"), expect: "reject", error: mustFail("qr path", () => parseQr(url.replace("/link#", "/x/link#"))) },
    { name: "deep link with an extra parameter", kind: "deep_link", text: deep + "&y=2", expect: "reject", error: mustFail("deep extra", () => parseDeepLink(deep + "&y=2")) },
    { name: "small-order claiming key (all zero)", kind: "ephemeral", claiming_pub: hex(new Uint8Array(32)), expect: "reject", error: mustFail("eph zero", () => dh(showingPriv, new Uint8Array(32))) },
  ];
  if (claimSide.code === showWithSwapped.code) throw new Error("fixed keys produce a code collision; change the attacker seed");

  return {
    spec: "docs/security/LINK-V1.md",
    generator: "client/scripts/security-vectors.mjs",
    note: "Fixed keys for testing only. Hex is lowercase; b64u is base64url without padding.",
    constants: {
      transcript_prefix: "housecall link v1",
      info_wrap: "housecall link v1 wrap",
      info_claim: "housecall link v1 claim",
      info_code: "housecall link v1 code",
      code_rule: "u32be(first 4 bytes of code output) mod 100, two digits, leading zero kept",
    },
    origin,
    link_id_hex: hex(linkId),
    secret_hex: hex(secret),
    secret_b64u: b64u(secret),
    secret_sha256_hex: hex(sha256(secret)),
    showing: { ephemeral_priv: hex(showingPriv), ephemeral_pub: hex(showingPub), ephemeral_pub_b64u: b64u(showingPub) },
    claiming: { ephemeral_priv: hex(claimingPriv), ephemeral_pub: hex(claimingPub), ephemeral_pub_b64u: b64u(claimingPub) },
    attacker: { ephemeral_priv: hex(attackerPriv), ephemeral_pub: hex(attackerPub) },
    qr_text: url,
    deep_link: deep,
    shared_secret: hex(dh(claimingPriv, showingPub)),
    transcript_hex: hex(concat(utf8("housecall link v1"), linkId, secret, showingPub, claimingPub)),
    salt: hex(claimSide.salt),
    wrap_key: hex(claimSide.wrapKey),
    claim_tag: hex(claimSide.claimTag),
    claim_tag_b64u: b64u(claimSide.claimTag),
    code_bytes: hex(claimSide.codeBytes),
    code: claimSide.code,
    code_reduction_examples: reductions,
    wrapped_keys: {
      identity_seed: hex(alice.seed),
      identity_key_b64u: b64u(alice.identityKey),
      recovery_rev: wrapRecoveryRev,
      pins,
      pins_json_utf8: JSON.stringify(pins),
      plaintext_hex: hex(concat(alice.seed, u32be(wrapRecoveryRev), utf8(JSON.stringify(pins)))),
      nonce: hex(wrapNonce),
      associated_data_hex: hex(concat(new Uint8Array([WRAP_VERSION]), linkId)),
      blob_hex: hex(wrapped),
      blob_b64u: b64u(wrapped),
      empty_pins_recovery_rev_1_blob_hex: hex(emptyPins),
      min_length: WRAP_MIN,
    },
    claim_request_example: {
      link_id: hex(linkId),
      secret: b64u(secret),
      device_name: "Pixel 9",
      device_key: hex(fixed("claiming device session key")),
      ephemeral_pub: b64u(claimingPub),
      claim_tag: b64u(claimSide.claimTag),
    },
    negative: negatives,
  };
}

// ---------------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "tests", "vectors");
const files = {
  "dm-v1.json": JSON.stringify(buildDm(), null, 2) + "\n",
  "link-v1.json": JSON.stringify(buildLink(), null, 2) + "\n",
};
// Build twice: the generator must be deterministic.
const again = { "dm-v1.json": JSON.stringify(buildDm(), null, 2) + "\n", "link-v1.json": JSON.stringify(buildLink(), null, 2) + "\n" };
for (const name of Object.keys(files)) if (files[name] !== again[name]) throw new Error(`${name} is not deterministic`);

if (process.argv.includes("--check")) {
  let stale = false;
  for (const [name, text] of Object.entries(files)) {
    let current = "";
    try { current = readFileSync(join(outDir, name), "utf8"); } catch { /* missing */ }
    if (current !== text) { console.error(`stale: client/tests/vectors/${name}`); stale = true; }
  }
  if (stale) process.exit(1);
  console.log("vectors up to date");
} else {
  mkdirSync(outDir, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(outDir, name), text);
    const n = JSON.parse(text).negative.length;
    console.log(`wrote client/tests/vectors/${name} (${n} negative vectors)`);
  }
}
