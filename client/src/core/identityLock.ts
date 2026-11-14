import type { SecurityVault } from './security';
const queues = new WeakMap<SecurityVault, Promise<unknown>>();
/** All host services on an install share one vault. Serialize mutations across network
 * awaits so a concurrent create/reset cannot replace the seed being confirmed/published. */
export function withIdentityLock<T>(vault: SecurityVault, operation: () => Promise<T>): Promise<T> {
  const pending = (queues.get(vault) ?? Promise.resolve()).then(operation);
  queues.set(vault, pending.catch(() => {})); return pending;
}
