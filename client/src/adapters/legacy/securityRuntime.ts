import { IdentityCoordinator } from '../../core/identityCoordinator';
import { IdentityService } from '../../core/identityService';
import { createIdentityStorage, memoryOnlyNativeStorage } from '../../transport/identityStorage';
import type { SecurityVault } from '../../core/security';
import type { Api } from '../../transport/api';
import { DmService } from './dm';
import { SecurityApi } from './security';

export const coordinator = new IdentityCoordinator();
let vault: SecurityVault;
export const installVault = () => vault ??= createIdentityStorage();
export interface SecuritySession { identity: IdentityService; dm: DmService }
const sessions = new Map<string, SecuritySession>();
const listeners = new Set<() => void>();
export const securityUpdates = {
  subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
  emit() { for (const fn of listeners) fn(); },
};
export function securitySession(api: Api, origin: string, userId: string) {
  const key = JSON.stringify([origin, userId]);
  let session = sessions.get(key);
  if (!session) {
    session = { identity: new IdentityService(installVault(), new SecurityApi(api), origin, userId), dm: new DmService(api, installVault(), origin, userId) };
    sessions.set(key, session); coordinator.register(session.identity);
  }
  return session;
}
export async function endSecuritySession(origin: string, userId: string) {
  const key = JSON.stringify([origin, userId]);
  pendingLinks.get(key)?.cancel(); pendingLinks.delete(key);
  sessions.get(key)?.dm.dispose(); coordinator.unregister(origin, userId); sessions.delete(key);
  // A browser sign-out forgets the entire page vault, including any other host service's cached pins.
  if (!installVault().native) {
    for (const s of sessions.values()) { s.dm.dispose(); coordinator.unregister(s.identity.origin, s.identity.userId); }
    sessions.clear(); for (const link of pendingLinks.values()) link.cancel(); pendingLinks.clear(); await createIdentityStorage().clearBrowserSession();
  }
  securityUpdates.emit();
}
export function chooseMemoryOnly() {
  for (const s of sessions.values()) { s.dm.dispose(); coordinator.unregister(s.identity.origin, s.identity.userId); }
  sessions.clear(); vault = memoryOnlyNativeStorage(); securityUpdates.emit();
}
export async function exportLinkPins() { return (await Promise.all([...sessions.values()].map(s => s.dm.linkPins()))).flat(); }

// Completed-link housekeeping survives leaving the success screen, in memory only, until retry/signout.
const pendingLinks = new Map<string, import('../../core/linkService').ReceivingLink>();
export function pendingLink(origin: string, userId: string) { return pendingLinks.get(JSON.stringify([origin, userId])); }
export function retainLink(origin: string, userId: string, link: import('../../core/linkService').ReceivingLink) {
  const state = link.snapshot(), key = JSON.stringify([origin, userId]);
  if (state.phase !== 'completed') return;
  if (!(state.exposureReportPending || state.oldSessionRevocationPending || link.nativeSessionPending())) {
    if (pendingLinks.get(key) === link) pendingLinks.delete(key);
    return;
  }
  const previous = pendingLinks.get(key);
  if (previous !== link) previous?.cancel();
  pendingLinks.set(key, link);
}
export const linkIsRetained = (link?: import('../../core/linkService').ReceivingLink) => !!link && [...pendingLinks.values()].includes(link);
export function finishLinkHousekeeping(origin: string, userId: string) {
  const key = JSON.stringify([origin, userId]), link = pendingLinks.get(key), state = link?.snapshot();
  if (state?.phase === 'completed' && !state.exposureReportPending && !state.oldSessionRevocationPending && !link!.nativeSessionPending()) { link!.cancel(); pendingLinks.delete(key); }
}
