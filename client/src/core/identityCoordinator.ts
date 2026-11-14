import type { IdentityService } from './identityService';
import type { IdentityStatus } from './security';
export interface HostIdentitySync { origin: string; userId: string; status: IdentityStatus; outcome: 'synced' | 'action-required' | 'failed' }
/** Register every signed-in host on the install. No password is retained; callers provide
 * each host's password only after its explicit collision/reset confirmation. */
export class IdentityCoordinator {
  private hosts = new Map<string, IdentityService>();
  register(service: IdentityService) { this.hosts.set(JSON.stringify([service.origin, service.userId]), service); }
  unregister(origin: string, userId: string) { const key = JSON.stringify([origin, userId]); this.hosts.get(key)?.dispose(); this.hosts.delete(key); }
  async synchronize(passwords: ReadonlyMap<IdentityService, string> = new Map()): Promise<HostIdentitySync[]> {
    const results: HostIdentitySync[] = [];
    for (const service of this.hosts.values()) {
      try {
        const status = await service.bootstrap();
        if (['needs-import', 'recovery-ahead', 'uninitialized'].includes(status.phase)) { results.push({ origin: service.origin, userId: service.userId, status, outcome: 'action-required' }); continue; }
        try { await service.publish(passwords.get(service)); results.push({ origin: service.origin, userId: service.userId, status: service.snapshot(), outcome: 'synced' }); }
        catch { results.push({ origin: service.origin, userId: service.userId, status: service.snapshot(), outcome: 'action-required' }); }
      } catch { results.push({ origin: service.origin, userId: service.userId, status: service.snapshot(), outcome: 'failed' }); }
    }
    return results;
  }
}
