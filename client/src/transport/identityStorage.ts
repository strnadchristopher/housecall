import { parseStoredIdentity, serialiseIdentity } from '../crypto/identity';
import { unwrap } from '../crypto/common';
import { mergePins, validatePins, type Pin } from '../crypto/link';
import type { InstallIdentity, SecurityVault, StorageAvailability } from '../core/security';

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
export class IdentityStorage implements SecurityVault {
  readonly native: boolean;
  availability: StorageAvailability;
  private identity: InstallIdentity | null = null;
  private pins = new Map<string, Pin[]>();
  constructor(private invoke?: Invoke) { this.native = !!invoke; this.availability = invoke ? 'memory-unavailable' : 'memory-web'; }
  private async call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    if (!this.invoke) throw new Error('Secure storage unavailable');
    try { const result = await this.invoke<T>(`plugin:secure-session|${command}`, args); this.availability = 'secure'; return result; }
    catch { this.availability = 'memory-unavailable'; throw new Error('Secure storage unavailable'); }
  }
  async loadIdentity(): Promise<InstallIdentity | null> {
    if (this.invoke) {
      // Failure is distinct from an empty store: never generate over an inaccessible identity.
      const { identity } = await this.call<{ identity?: unknown }>('identity_get');
      if (identity == null) return null;
      const raw = typeof identity === 'string' ? JSON.parse(identity) : identity;
      const parsed = unwrap(parseStoredIdentity(raw));
      return { seed: parsed.seed, recoveryRev: parsed.recovery_rev, confirmed: (raw as { confirmed?: unknown }).confirmed === true, wordsRequirePassword: (raw as { words_require_password?: unknown }).words_require_password === true };
    }
    return this.identity ? { ...this.identity, seed: this.identity.seed.slice() } : null;
  }
  async saveIdentity(value: InstallIdentity) {
    const raw = { ...JSON.parse(serialiseIdentity(value.seed, value.recoveryRev)), confirmed: value.confirmed, words_require_password: value.wordsRequirePassword === true };
    if (this.invoke) { const r = await this.call<{ ok: boolean }>('identity_set', { identity: raw }); if (!r.ok) { this.availability = 'memory-unavailable'; throw new Error('Secure storage unavailable'); } return; }
    this.identity?.seed.fill(0); this.identity = { ...value, seed: value.seed.slice() };
  }
  async removeIdentity() {
    if (this.invoke) { const r = await this.call<{ ok: boolean }>('identity_remove'); if (!r.ok) { this.availability = 'memory-unavailable'; throw new Error('Secure storage unavailable'); } }
    this.identity?.seed.fill(0); this.identity = null;
  }
  async clearBrowserSession() { if (this.native) throw new Error('Browser session only'); await this.removeIdentity(); this.pins.clear(); }
  private scope(origin: string, accountId: string) { return JSON.stringify([origin, accountId]); }
  async loadPins(origin: string, accountId: string) {
    const raw = this.invoke ? (await this.call<{ pins?: unknown }>('pins_get', { origin, userId: accountId })).pins ?? [] : this.pins.get(this.scope(origin, accountId)) ?? [];
    const local = unwrap(validatePins(typeof raw === 'string' ? JSON.parse(raw) : raw));
    if (local.some(p => p.origin !== origin)) throw new Error('Pin origin mismatch');
    if (accountId === '__linked__') return local;
    const inboxRaw = this.invoke ? (await this.call<{ pins?: unknown }>('pins_get', { origin, userId: '__linked__' })).pins ?? [] : this.pins.get(this.scope(origin, '__linked__')) ?? [];
    const inbox = unwrap(validatePins(typeof inboxRaw === 'string' ? JSON.parse(inboxRaw) : inboxRaw));
    if (inbox.some(p => p.origin !== origin)) throw new Error('Pin origin mismatch');
    return unwrap(mergePins(local, inbox));
  }
  async savePins(origin: string, accountId: string, pins: readonly Pin[]) {
    const value = unwrap(validatePins(pins));
    if (value.some(p => p.origin !== origin)) throw new Error('Pin origin mismatch');
    if (this.invoke) { const r = await this.call<{ ok: boolean }>('pins_set', { origin, userId: accountId, pins: value }); if (!r.ok) { this.availability = 'memory-unavailable'; throw new Error('Secure storage unavailable'); } return; }
    this.pins.set(this.scope(origin, accountId), value);
  }
}
let installStorage: IdentityStorage | undefined;
/** One vault per running install/page, shared by every authenticated host service. */
export function createIdentityStorage(): IdentityStorage {
  const invoke = typeof window === 'undefined' ? undefined : (window as unknown as { __TAURI_INTERNALS__?: { invoke: Invoke } }).__TAURI_INTERNALS__?.invoke;
  return installStorage ??= new IdentityStorage(invoke);
}
/** Explicit, UI-visible memory session after a native store failure; never chosen silently. */
export function memoryOnlyNativeStorage(): SecurityVault {
  if (typeof window === 'undefined' || !(window as unknown as { __TAURI_INTERNALS__?: { invoke?: unknown } }).__TAURI_INTERNALS__?.invoke) throw new Error('Native app required');
  const store = new IdentityStorage();
  return Object.assign(store, { native: true, availability: 'memory-unavailable' as const });
}
