import { b64u, publicIdentityKey, unb64u } from '../../crypto/identity';
import { parseBackup, sealBackup } from '../../crypto/backup';
import { unwrap } from '../../crypto/common';
import { validatePublicKeys } from '../../core/pins';
import type { Api } from '../../transport/api';
import type { PublicKeys } from '../../core/security';

/** Authenticated REST boundary: uses the same Api/session headers as ordinary chat. */
export class SecurityApi {
  constructor(readonly api: Api) {}
  keys(userId: string) { return this.api.get<PublicKeys>(`/api/users/${encodeURIComponent(userId)}/keys`); }
  publish(identity_key: string, password?: string) { return this.api.put<{ key_rev: number }>('/api/me/keys', { identity_key, ...(password === undefined ? {} : { password }) }); }
  backup() { return this.api.get<{ key_backup: string | null }>('/api/me/key-backup'); }
  putBackup(key_backup: string) { return this.api.put<{ recovery_rev: number }>('/api/me/key-backup', { key_backup }); }
  async password(password: string) { const r = await this.api.post<{ ok: boolean }>('/api/me/password-check', { password }); if (r.ok !== true) throw new Error('Password verification failed'); }
  /** LINK section 7 / DM 11.3: a confirmed transferred seed may join this host,
   * but this operation never replaces a different account key or rolls back a backup. */
  async synchronizeTransferred(userId: string, origin: string, seed: Uint8Array, recoveryRev: number) {
    const own = await this.keys(userId); validatePublicKeys(own, origin, userId);
    const key = b64u(publicIdentityKey(seed));
    if (own.identity_key && own.identity_key !== key) throw new Error('Link account key changed');
    if (!own.identity_key) await this.publish(key);
    const backup = await this.backup();
    const remoteRev = backup.key_backup ? unwrap(parseBackup(unwrap(unb64u(backup.key_backup)))).recoveryRev : 0;
    if (remoteRev < recoveryRev) await this.putBackup(b64u(sealBackup(seed, recoveryRev)));
    return { recoveryAhead: remoteRev > recoveryRev };
  }
  exposure() { return this.api.post('/api/me/key-exposure', { kind: 'browser' }); }
  exposures() { return this.api.get<{ exposures: { kind: 'browser'; device_name: string; created_at: number }[] }>('/api/me/key-exposure'); }
}
