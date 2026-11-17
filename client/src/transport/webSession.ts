/**
 * Browser "keep me signed in": the session (token + device key, never the password or any
 * identity key) is sealed with a non-extractable AES-GCM key and both live in IndexedDB.
 * The key is non-extractable through Web Crypto. This is not an XSS or copied-profile
 * security boundary: same-origin script can still decrypt it, and browser profile protections
 * determine at-rest security. Every failure degrades to "nothing stored".
 */
import type { StoredSession } from "./secureSession";

const DB = "housecall-session";
const STORE = "kv";
const WRAP = "wrap-key";
const PREFIX = "session:";

function idb(): IDBFactory | undefined {
  try { return globalThis.indexedDB ?? undefined; } catch { return undefined; }
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const factory = idb();
    if (!factory) return reject(new Error("no indexedDB"));
    const request = factory.open(DB, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore(STORE); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(db => new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const request = run(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); resolve(request.result); };
    t.onerror = () => { db.close(); reject(t.error); };
    t.onabort = () => { db.close(); reject(t.error); };
  }));
}

async function wrapKey(create: boolean): Promise<CryptoKey | undefined> {
  const existing = await tx<CryptoKey | undefined>("readonly", s => s.get(WRAP) as IDBRequest<CryptoKey | undefined>);
  if (existing || !create) return existing;
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  // Generate outside the transaction, then atomically choose the existing winner.
  // Two first-login tabs must never overwrite each other's wrapping key.
  const db = await open();
  return new Promise<CryptoKey>((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite'), store = transaction.objectStore(STORE);
    const read = store.get(WRAP);
    let winner = key;
    read.onsuccess = () => { if (read.result) winner = read.result; else store.put(key, WRAP); };
    transaction.oncomplete = () => { db.close(); resolve(winner); };
    transaction.onerror = transaction.onabort = () => { db.close(); reject(transaction.error); };
  });
}

/** "" (same-origin web build) and a typed address of this same server share one entry. */
function canonical(origin: string): string {
  const here = globalThis.location?.origin ?? "";
  if (!origin) return here;
  try { return new URL(origin).origin; } catch { return origin; }
}
const keyFor = (origin: string) => PREFIX + canonical(origin);
const aad = (origin: string) => new TextEncoder().encode(keyFor(origin));

interface Sealed { iv: Uint8Array<ArrayBuffer>; ct: ArrayBuffer; usedAt: number }

function valid(value: unknown): value is StoredSession {
  const s = value as Partial<StoredSession> | null;
  return !!s && typeof s.token === "string" && typeof s.device_key === "string" &&
    typeof s.username === "string" && typeof s.expires_at === "number";
}

export const webSession = {
  available(): boolean {
    return !!idb() && typeof crypto !== "undefined" && !!crypto.subtle;
  },
  async get(origin: string): Promise<StoredSession | null> {
    try {
      const sealed = await tx<Sealed | undefined>("readonly", s => s.get(keyFor(origin)) as IDBRequest<Sealed | undefined>);
      if (!sealed) return null;
      const key = await wrapKey(false);
      if (!key) return null;
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: sealed.iv, additionalData: aad(origin) }, key, sealed.ct);
      const value: unknown = JSON.parse(new TextDecoder().decode(plain));
      return valid(value) ? value : null;
    } catch { return null; }
  },
  async set(origin: string, session: StoredSession): Promise<boolean> {
    try {
      const key = await wrapKey(true);
      if (!key) return false;
      const { token, device_key, username, expires_at } = session;
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: aad(origin) }, key,
        new TextEncoder().encode(JSON.stringify({ token, device_key, username, expires_at })),
      );
      await tx("readwrite", s => s.put({ iv, ct, usedAt: Date.now() } satisfies Sealed, keyFor(origin)));
      return true;
    } catch { return false; }
  },
  async remove(origin: string): Promise<void> {
    try { await tx("readwrite", s => s.delete(keyFor(origin))); } catch { /* nothing stored */ }
  },
  /** Explicit browser-wide logout removes ciphertext and the non-extractable wrapping key. */
  async clear(): Promise<void> {
    try { await tx('readwrite', s => s.clear()); } catch { /* storage unavailable */ }
  },
  async list(): Promise<string[]> {
    try {
      const keys = await tx<IDBValidKey[]>("readonly", s => s.getAllKeys());
      return keys.map(String).filter(k => k.startsWith(PREFIX)).map(k => k.slice(PREFIX.length));
    } catch { return []; }
  },
};
