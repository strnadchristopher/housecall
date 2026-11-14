import { unwrap } from '../crypto/common';
import { validatePins, type Pin } from '../crypto/link';
import type { PeerSecurity, PublicKeys } from './security';

export function validatePublicKeys(value: PublicKeys, origin: string, userId: string): Pin | undefined {
  if (!value || value.user_id !== userId) throw new Error('Invalid key history');
  if (value.key_rev === 0 && value.identity_key === null && Array.isArray(value.history) && value.history.length === 0) return;
  return unwrap(validatePins([{ origin, user_id: userId, identity_key: value.identity_key, key_rev: value.key_rev, verified: false, history: value.history }]))[0];
}
/** Closed history: server answers may never backfill an unknown old revision. */
export function evaluatePeer(pin: Pin | undefined, response: PublicKeys, origin: string, userId: string): PeerSecurity {
  const state = (s: PeerSecurity['state'], p = pin): PeerSecurity => ({ state: s, pin: p, canAcknowledge: s === 'CHANGED_UNACKNOWLEDGED', canSendEncrypted: s === 'PINNED', canSendPlaintext: s === 'NONE' && !p });
  let next: Pin | undefined;
  try { next = validatePublicKeys(response, origin, userId); } catch { return state('KEY_ROLLBACK'); }
  if (!pin) return next ? state('PINNED', next) : state('NONE');
  if (!next) return state('CHANGED_UNACKNOWLEDGED');
  if (next.key_rev < pin.key_rev) return state('KEY_ROLLBACK');
  for (const h of next.history) {
    const known = pin.history.find(k => k.key_rev === h.key_rev);
    if (known && known.identity_key !== h.identity_key) return state('KEY_ROLLBACK');
    if (pin.history.some(k => k.identity_key === h.identity_key && k.key_rev !== h.key_rev)) return state('KEY_ROLLBACK');
  }
  if (next.key_rev === pin.key_rev) return next.identity_key === pin.identity_key ? state('PINNED') : state('KEY_ROLLBACK');
  return { ...state('CHANGED_UNACKNOWLEDGED'), candidate: next };
}
export function acknowledgePeer(pin: Pin, response: PublicKeys): Pin {
  const state = evaluatePeer(pin, response, pin.origin, pin.user_id);
  if (state.state !== 'CHANGED_UNACKNOWLEDGED' || !response.identity_key) throw new Error('Key change cannot be acknowledged');
  const next = validatePublicKeys(response, pin.origin, pin.user_id)!;
  return unwrap(validatePins([{ ...next, history: [...pin.history, ...next.history.filter(h => h.key_rev > pin.key_rev)], verified: false }]))[0];
}
