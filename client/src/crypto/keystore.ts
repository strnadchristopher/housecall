import { bytes, revision } from './common';
import type { IdentityStore } from './identity';
export interface StoredIdentity { seed: Uint8Array; recoveryRev: number }
export interface KeyStore { load(): Promise<StoredIdentity | null>; save(value: StoredIdentity): Promise<void>; clear(): Promise<void> }
/** No browser persistence; every read/write owns a fresh copy. Clear and replacement wipe our copy. */
export class MemoryKeyStore implements KeyStore, IdentityStore {
  private identity: StoredIdentity | null = null;
  async load(): Promise<StoredIdentity | null> { return this.identity ? { seed: this.identity.seed.slice(), recoveryRev: this.identity.recoveryRev } : null; }
  async save(value: StoredIdentity): Promise<void> {
    bytes(value.seed, 32); revision(value.recoveryRev);
    const next = { seed: value.seed.slice(), recoveryRev: value.recoveryRev };
    this.identity?.seed.fill(0); this.identity = next;
  }
  async clear(): Promise<void> { this.identity?.seed.fill(0); this.identity = null; }
  get = () => this.load();
  set = (value: StoredIdentity) => this.save(value);
  remove = () => this.clear();
}
