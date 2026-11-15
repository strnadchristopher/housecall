import { parseStoredIdentity, serialiseIdentity } from '../crypto/identity';
import { unwrap } from '../crypto/common';
import { mergePins, validatePins, validOrigin, type Pin } from '../crypto/link';
import type { ConversationBinding, InstallIdentity, PinImport, SecurityVault, StorageAvailability } from '../core/security';

type VaultIdentity = InstallIdentity & { pinImport?: PinImport[] };
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
export class IdentityStorage implements SecurityVault {
  readonly native: boolean;
  availability: StorageAvailability;
  private identity: VaultIdentity | null = null;
  private bindings = new Map<string, ConversationBinding[]>();
  private pins = new Map<string, Pin[]>();
  constructor(private invoke?: Invoke) { this.native = !!invoke; this.availability = invoke ? 'memory-unavailable' : 'memory-web'; }
  private async call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    if (!this.invoke) throw new Error('Secure storage unavailable');
    try { const result = await this.invoke<T>(`plugin:secure-session|${command}`, args); this.availability = 'secure'; return result; }
    catch { this.availability = 'memory-unavailable'; throw new Error('Secure storage unavailable'); }
  }
  private queue: Promise<unknown> = Promise.resolve();
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(work); this.queue = pending.catch(() => {}); return pending;
  }
  private validateImport(value: unknown): PinImport[] {
    if (!Array.isArray(value) || value.length > 1000) throw new Error('Invalid pin import');
    return value.map(row => {
      if (!row || !validOrigin(row.origin) || typeof row.account !== 'string' || !row.account || row.account.length > 128 || /[\u0000-\u001f\u007f]/.test(row.account)) throw new Error('Invalid pin import');
      const pins = unwrap(validatePins(row.pins));
      if (pins.some(p => p.origin !== row.origin)) throw new Error('Pin origin mismatch');
      return { origin: row.origin, account: row.account, pins };
    });
  }
  /** Replay the durable journal before exposing either identity or trust to any service.
   * Writes are idempotent; a failed write leaves the complete journal in the identity record.
   * The same gate covers plaintext/TOFU readers, even on other host accounts. */
  private async recoverImport(): Promise<VaultIdentity | null> {
    const identity = await this.loadIdentityRecord();
    if (!identity?.pinImport) return identity;
    try {
      for (const update of identity.pinImport) {
        const current = await this.loadPinsRecord(update.origin, update.account);
        await this.savePinsRecord(update.origin, update.account, unwrap(mergePins(current, update.pins)));
      }
      delete identity.pinImport;
      await this.saveIdentityRecord(identity);
      return identity;
    } catch (error) { identity.seed.fill(0); throw error; }
  }
  async loadIdentity(): Promise<InstallIdentity | null> { return this.serial(() => this.recoverImport()); }
  async saveIdentity(value: InstallIdentity) {
    return this.serial(async () => { (await this.recoverImport())?.seed.fill(0); await this.saveIdentityRecord(value); });
  }
  async importIdentity(value: InstallIdentity, pins: readonly PinImport[]) {
    return this.serial(async () => {
      const updates = this.validateImport(pins);
      (await this.recoverImport())?.seed.fill(0);
      // One OS record write durably couples the adopted seed to every origin's trust.
      await this.saveIdentityRecord({ ...value, pinImport: updates });
      (await this.recoverImport())?.seed.fill(0);
    });
  }
  private async loadIdentityRecord(): Promise<VaultIdentity | null> {
    if (this.invoke) {
      // Failure is distinct from an empty store: never generate over an inaccessible identity.
      const { identity } = await this.call<{ identity?: unknown }>('identity_get');
      if (identity == null) return null;
      try {
        const raw = typeof identity === 'string' ? JSON.parse(identity) : identity;
        const parsed = unwrap(parseStoredIdentity(raw));
        const fields = raw as { confirmed?: unknown; words_require_password?: unknown; pin_import?: unknown };
        let pinImport: PinImport[] | undefined;
        try { pinImport = fields.pin_import === undefined ? undefined : this.validateImport(fields.pin_import); }
        catch (error) { parsed.seed.fill(0); throw error; }
        return { seed: parsed.seed, recoveryRev: parsed.recovery_rev, confirmed: fields.confirmed === true, wordsRequirePassword: fields.words_require_password === true, ...(pinImport ? { pinImport } : {}) };
      } catch { this.availability = 'memory-unavailable'; throw new Error('Secure storage unavailable'); }
    }
    return this.identity ? { ...this.identity, seed: this.identity.seed.slice() } : null;
  }
  private async saveIdentityRecord(value: VaultIdentity) {
    const raw = { ...JSON.parse(serialiseIdentity(value.seed, value.recoveryRev)), confirmed: value.confirmed, words_require_password: value.wordsRequirePassword === true, ...(value.pinImport ? { pin_import: value.pinImport } : {}) };
    if (this.invoke) { const r = await this.call<{ ok: boolean }>('identity_set', { identity: raw }); if (!r.ok) { this.availability = 'memory-unavailable'; throw new Error('Secure storage unavailable'); } return; }
    this.identity?.seed.fill(0); this.identity = { ...value, seed: value.seed.slice() };
  }
  async removeIdentity() { return this.serial(async () => {
    (await this.recoverImport())?.seed.fill(0);
    if (this.invoke) { const r = await this.call<{ ok: boolean }>('identity_remove'); if (!r.ok) { this.availability = 'memory-unavailable'; throw new Error('Secure storage unavailable'); } }
    this.identity?.seed.fill(0); this.identity = null;
  }); }
  async clearBrowserSession() { if (this.native) throw new Error('Browser session only'); await this.removeIdentity(); this.pins.clear(); this.bindings.clear(); }
  private scope(origin: string, accountId: string) { return JSON.stringify([origin, accountId]); }
  async loadBindings(origin: string, accountId: string): Promise<ConversationBinding[]> {
    const raw = this.invoke ? (await this.call<{ bindings?: unknown }>('bindings_get', { origin, userId: accountId })).bindings ?? [] : this.bindings.get(this.scope(origin, accountId)) ?? [];
    const value: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(value) || value.some(row => !row || typeof row.id !== 'string' || !row.id || !(row.peer === null || (typeof row.peer === 'string' && row.peer && row.peer !== accountId))) || new Set(value.map(row => row.id)).size !== value.length) throw new Error('Secure conversation storage unavailable');
    return value.map(row => ({ id: row.id, peer: row.peer }));
  }
  async saveBindings(origin: string, accountId: string, bindings: readonly ConversationBinding[]) {
    const value = bindings.map(row => ({ ...row }));
    if (this.invoke) { const r = await this.call<{ ok: boolean }>('bindings_set', { origin, userId: accountId, bindings: value }); if (!r.ok) throw new Error('Secure conversation storage unavailable'); return; }
    this.bindings.set(this.scope(origin, accountId), value);
  }
  async loadPins(origin: string, accountId: string) {
    return this.serial(async () => { (await this.recoverImport())?.seed.fill(0); return this.loadPinsRecord(origin, accountId); });
  }
  private async loadPinsRecord(origin: string, accountId: string) {
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
    return this.serial(async () => { (await this.recoverImport())?.seed.fill(0); await this.savePinsRecord(origin, accountId, pins); });
  }
  private async savePinsRecord(origin: string, accountId: string, pins: readonly Pin[]) {
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
