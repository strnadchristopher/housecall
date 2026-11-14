import type { Pin } from '../crypto/link';
import type { StoredIdentity } from '../crypto/keystore';

export type StorageAvailability = 'secure' | 'memory-web' | 'memory-unavailable';
export interface InstallIdentity extends StoredIdentity { confirmed: boolean; wordsRequirePassword?: boolean }
export interface SecurityVault {
  readonly native: boolean;
  readonly availability: StorageAvailability;
  loadIdentity(): Promise<InstallIdentity | null>;
  saveIdentity(identity: InstallIdentity): Promise<void>;
  removeIdentity(): Promise<void>;
  loadPins(origin: string, accountId: string): Promise<Pin[]>;
  savePins(origin: string, accountId: string, pins: readonly Pin[]): Promise<void>;
}
export interface PublicKeys {
  user_id: string;
  identity_key: string | null;
  key_rev: number;
  history: { key_rev: number; identity_key: string; created_at?: number }[];
}
export type PeerKeyState = 'NONE' | 'PINNED' | 'CHANGED_UNACKNOWLEDGED' | 'KEY_ROLLBACK';
export interface PeerSecurity {
  state: PeerKeyState;
  pin?: Pin;
  candidate?: Pin;
  canAcknowledge: boolean;
  canSendEncrypted: boolean;
  canSendPlaintext: boolean;
}
export type IdentityPhase = 'uninitialized' | 'needs-identity' | 'needs-import' | 'pending-confirmation' | 'ready' | 'collision' | 'recovery-ahead';
export interface IdentityStatus {
  phase: IdentityPhase;
  storage: StorageAvailability;
  keyRev: number;
  exposure: 'none' | 'warning-required' | 'report-pending' | 'reported';
  wordDisplayRequiresPassword?: boolean;
  requiredNotices?: IdentityNotice[];
  replacementDeviceName?: string;
}
/** Explicit acknowledgements are UI actions, never inferred from entering a flow. */
export type IdentityNotice = 'security-introduction' | 'browser-exposure' | 'cross-host-linkability' | 'reset-loses-history' | 'replace-does-not-revoke-leaked-words' | 'replace-install-affects-other-hosts';

export interface KeyChangeEvent { user_id: string; key_rev: number; device_name: string }
export interface DeviceAddedEvent { session_id: string; device_name: string; added_via: import('../data/types').DeviceAddedVia }
