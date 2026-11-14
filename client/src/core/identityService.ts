import { checkConfirm, openBackup, parseBackup, pickConfirmPositions, recoveryKey, recoveryWords, sealBackup, wordsToRecoveryKey } from '../crypto/backup';
import { b64u, newSeed, publicIdentityKey, unb64u } from '../crypto/identity';
import { ctEqual, unwrap } from '../crypto/common';
import { validOrigin } from '../crypto/link';
import type { SecurityApi } from '../adapters/legacy/security';
import type { IdentityNotice, IdentityStatus, InstallIdentity, KeyChangeEvent, SecurityVault } from './security';
import { withIdentityLock } from './identityLock';
import { validatePublicKeys } from './pins';

/** One instance per install vault + authenticated host/account. No implicit creation or publication. */
export class IdentityService {
  private status: IdentityStatus;
  private notices = new Set<IdentityNotice>();
  private positions?: [number, number];
  private displayOpen = false;
  private challengeIdentity?: string;
  private replacement = false;
  private wordAccessAuthorized = false;
  private disposed = false;
  private active() { if (this.disposed) throw new Error('Security session ended'); }
  constructor(readonly vault: SecurityVault, readonly remote: SecurityApi, readonly origin: string, readonly userId: string) {
    if (!validOrigin(origin) || !userId) throw new Error('Invalid identity scope');
    this.status = { phase: 'uninitialized', keyRev: 0, storage: vault.availability, exposure: vault.native ? 'none' : 'warning-required' };
  }
  snapshot(): IdentityStatus { return { ...this.status, requiredNotices: this.status.requiredNotices?.filter(n => !this.notices.has(n)), storage: this.vault.availability }; }
  acknowledgeNotice(notice: IdentityNotice) { this.notices.add(notice); }
  private requireNotice(notice: IdentityNotice) { if (!this.notices.has(notice)) throw new Error(`Notice required: ${notice}`); }
  private native() { this.active(); if (!this.vault.native) throw new Error('Native app required'); }
  async bootstrap(): Promise<IdentityStatus> {
    this.active(); const own = await this.remote.keys(this.userId);
    this.active(); validatePublicKeys(own, this.origin, this.userId);
    const local = await this.vault.loadIdentity();
    try {
      this.active(); this.status.keyRev = own.key_rev;
      this.status.wordDisplayRequiresPassword = !!local && (local.confirmed || !!local.wordsRequirePassword) && !this.wordAccessAuthorized;
      this.status.requiredNotices = !this.vault.native ? ['browser-exposure'] : !own.identity_key ? local ? ['cross-host-linkability'] : ['security-introduction'] : [];
      this.status.phase = !local ? (own.key_rev ? 'needs-import' : 'needs-identity') : !local.confirmed ? 'pending-confirmation' : !own.identity_key ? 'needs-identity' : b64u(publicIdentityKey(local.seed)) === own.identity_key ? 'ready' : 'collision';
      if (this.status.phase === 'ready') {
        const backup = await this.remote.backup();
        if (backup.key_backup) {
          const parsed = unwrap(parseBackup(unwrap(unb64u(backup.key_backup))));
          if (parsed.recoveryRev > local!.recoveryRev) this.status.phase = 'recovery-ahead';
        }
      }
      return this.snapshot();
    } finally { local?.seed.fill(0); }
  }
  async onKeysChanged(event: KeyChangeEvent) {
    if (event.user_id !== this.userId) return this.snapshot();
    const status = await this.bootstrap();
    this.status.replacementDeviceName = status.phase === 'collision' ? event.device_name.slice(0, 80) : undefined;
    return this.snapshot();
  }
  private async beginCreationUnlocked() {
    this.native();
    this.requireNotice('security-introduction');
    if (this.status.phase !== 'needs-identity') throw new Error('Identity creation unavailable');
    const local = await this.vault.loadIdentity();
    if (local) { local.seed.fill(0); throw new Error('Install identity already exists; confirm cross-host use'); }
    const value: InstallIdentity = { seed: newSeed(), recoveryRev: 1, confirmed: false };
    try { this.active(); await this.vault.saveIdentity(value); this.status.phase = 'pending-confirmation'; } finally { value.seed.fill(0); }
  }
  /** New install identity after explicit loss warning + server password verification. */
  private async beginResetUnlocked(password: string) {
    this.native(); this.requireNotice('reset-loses-history');
    await this.remote.password(password);
    const value = { seed: newSeed(), recoveryRev: 1, confirmed: false, wordsRequirePassword: true };
    try { this.active(); await this.vault.saveIdentity(value); this.wordAccessAuthorized = true; this.status.phase = 'pending-confirmation'; this.positions = undefined; } finally { value.seed.fill(0); }
  }
  private async local() { const value = await this.vault.loadIdentity(); if (!value) throw new Error('Identity required'); return value; }
  /** Pending setup words need no password. Existing words always check the host password + backup revision. */
  async showWords(password?: string): Promise<string> {
    this.native();
    if (this.status.phase !== 'pending-confirmation') {
      if (password === undefined) throw new Error('Password required');
      await this.remote.password(password);
      await this.bootstrap();
      if (this.status.phase !== 'ready') throw new Error('Current recovery key required');
    }
    const local = await this.local();
    try {
      if (this.status.phase === 'pending-confirmation' && local.wordsRequirePassword && !this.wordAccessAuthorized) {
        if (password === undefined) throw new Error('Password required');
        await this.remote.password(password); this.wordAccessAuthorized = true;
      }
      this.active(); this.status.wordDisplayRequiresPassword = false;
      const r = recoveryKey(local.seed, local.recoveryRev); try { this.displayOpen = true; this.challengeIdentity = `${b64u(publicIdentityKey(local.seed))}:${local.recoveryRev}`; return recoveryWords(r); } finally { r.fill(0); } }
    finally { local.seed.fill(0); }
  }
  /** UI closes the word list before rendering these positions. Returning to the list excludes both old positions. */
  confirmationChallenge(): readonly [number, number] {
    this.native(); if (!this.displayOpen || this.status.phase !== 'pending-confirmation') throw new Error('Display recovery words first');
    this.displayOpen = false; this.positions = pickConfirmPositions(undefined, this.positions); return [...this.positions];
  }
  private async confirmWordsUnlocked(typed: readonly [string, string]) {
    this.native();
    if (this.displayOpen || !this.positions || this.status.phase !== 'pending-confirmation') throw new Error('Confirmation required');
    const local = await this.local();
    try {
      if (this.challengeIdentity !== `${b64u(publicIdentityKey(local.seed))}:${local.recoveryRev}`) throw new Error('Recovery challenge changed');
      const r = recoveryKey(local.seed, local.recoveryRev);
      let valid: boolean; try { valid = checkConfirm(recoveryWords(r), this.positions, typed); } finally { r.fill(0); }
      if (!valid) return false;
      local.confirmed = true; this.active(); await this.vault.saveIdentity(local); this.positions = undefined;
      return true;
    } finally { local.seed.fill(0); }
  }
  /** Explicit publish/resume action. Password is required by the server for collision/reset. */
  private async publishUnlocked(password?: string) {
    this.native(); const local = await this.local();
    try {
      if (!local.confirmed) throw new Error('Recovery words must be confirmed');
      const own = await this.remote.keys(this.userId); validatePublicKeys(own, this.origin, this.userId);
      const key = b64u(publicIdentityKey(local.seed));
      if (own.identity_key && own.identity_key !== key) { this.requireNotice('reset-loses-history'); if (!password) throw new Error('Password required'); }
      if (!own.identity_key && this.status.phase !== 'pending-confirmation') this.requireNotice('cross-host-linkability');
      this.active(); const published = await this.remote.publish(key, password); this.status.keyRev = published.key_rev;
      await this.syncBackup(local); this.replacement = false; this.status.phase = 'ready';
    } finally { local.seed.fill(0); }
  }
  private async syncBackup(local: InstallIdentity) {
    const remote = await this.remote.backup();
    if (remote.key_backup) {
      const rev = unwrap(parseBackup(unwrap(unb64u(remote.key_backup)))).recoveryRev;
      if (rev > local.recoveryRev) { this.status.phase = 'recovery-ahead'; throw new Error('A newer recovery key exists'); }
      if (rev === local.recoveryRev && !this.replacement) return;
    }
    this.active(); await this.remote.putBackup(b64u(sealBackup(local.seed, local.recoveryRev)));
  }
  private async replaceRecoveryUnlocked(password: string) {
    this.native(); this.requireNotice('replace-does-not-revoke-leaked-words');
    await this.remote.password(password); await this.bootstrap();
    if (this.status.phase !== 'ready') throw new Error('Current recovery key required');
    const local = await this.local();
    try { if (local.recoveryRev === 0xffffffff) throw new Error('Recovery revision exhausted'); local.recoveryRev++; local.confirmed = false; local.wordsRequirePassword = true; this.active(); await this.vault.saveIdentity(local); this.wordAccessAuthorized = true; this.replacement = true; this.status.phase = 'pending-confirmation'; this.positions = undefined; }
    finally { local.seed.fill(0); }
  }
  /** Browser warning must be acknowledged before the UI accepts words. */
  canEnterRecovery(): boolean { return this.vault.native || this.notices.has('browser-exposure'); }
  private async importRecoveryUnlocked(words: string) {
    this.active();
    if (!this.canEnterRecovery()) throw new Error('Browser exposure warning required');
    const own = await this.remote.keys(this.userId); validatePublicKeys(own, this.origin, this.userId);
    if (!own.identity_key) throw new Error('Account has no security key');
    const backup = await this.remote.backup(); if (!backup.key_backup) throw new Error('Recovery backup unavailable');
    const blob = unwrap(unb64u(backup.key_backup)), r = unwrap(wordsToRecoveryKey(words));
    let seed: Uint8Array | undefined;
    try {
      seed = unwrap(openBackup(blob, r, unwrap(unb64u(own.identity_key))));
      const old = await this.vault.loadIdentity();
      try { if (old && !ctEqual(publicIdentityKey(old.seed), publicIdentityKey(seed))) this.requireNotice('replace-install-affects-other-hosts'); } finally { old?.seed.fill(0); }
      this.active(); await this.vault.saveIdentity({ seed, recoveryRev: unwrap(parseBackup(blob)).recoveryRev, confirmed: true, wordsRequirePassword: true });
      this.status.phase = 'ready'; this.status.keyRev = own.key_rev;
      if (!this.vault.native) await this.reportExposure();
    } finally { r.fill(0); seed?.fill(0); }
  }
  /** Sign-out discards this host's challenges/notices; the per-install key stays stored. */
  dispose() { this.disposed = true; this.positions = undefined; this.challengeIdentity = undefined; this.displayOpen = false; this.wordAccessAuthorized = false; this.notices.clear(); }
  beginCreation() { return withIdentityLock(this.vault, () => this.beginCreationUnlocked()); }
  beginReset(password: string) { return withIdentityLock(this.vault, () => this.beginResetUnlocked(password)); }
  confirmWords(typed: readonly [string, string]) { return withIdentityLock(this.vault, () => this.confirmWordsUnlocked(typed)); }
  publish(password?: string) { return withIdentityLock(this.vault, () => this.publishUnlocked(password)); }
  replaceRecovery(password: string) { return withIdentityLock(this.vault, () => this.replaceRecoveryUnlocked(password)); }
  importRecovery(words: string) { return withIdentityLock(this.vault, () => this.importRecoveryUnlocked(words)); }
  removeDeviceKey() { return withIdentityLock(this.vault, () => this.removeDeviceKeyUnlocked()); }
  async reportExposure() { this.active(); this.status.exposure = 'report-pending'; await this.remote.exposure(); this.status.exposure = 'reported'; }
  /** Only explicit device-key removal calls this. Ordinary host sign-out never does. */
  private async removeDeviceKeyUnlocked() { this.active(); await this.vault.removeIdentity(); this.status.phase = 'uninitialized'; this.positions = undefined; this.displayOpen = false; }
}
