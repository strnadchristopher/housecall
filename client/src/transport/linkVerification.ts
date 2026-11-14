import type { SecurityApi } from '../adapters/legacy/security';
/** Cancelled/failed OS verification cannot fall through to password or approval. */
export async function verifyLinkApproval(remote: SecurityApi, deviceName: string, password?: string): Promise<boolean> {
  const invoke = typeof window === 'undefined' ? undefined : (window as unknown as { __TAURI_INTERNALS__?: { invoke: <T>(name: string, args?: Record<string, unknown>) => Promise<T> } }).__TAURI_INTERNALS__?.invoke;
  if (!invoke) throw new Error('Native app required');
  const result = await invoke<{ supported: boolean; verified: boolean }>('plugin:secure-session|verify_owner', { reason: `Approve logging in on ${deviceName}` });
  if (result.supported === true) return result.verified === true;
  if (result.supported !== false || password === undefined) throw new Error('Password required');
  await remote.password(password); return true;
}
