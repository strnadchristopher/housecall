/**
 * Access requests this device has sent, so the Pending requests screen survives a restart.
 * Non-secret: the request id only lets someone read a status word. The password is never kept.
 */
export interface PendingRequest { origin: string; id: string; username: string; serverName: string; createdAt: number }
type StorageLike = Pick<Storage, "getItem" | "setItem">;
const KEY = "hc-pending-v1";
const LIMIT = 20;

function browserStorage(): StorageLike | undefined {
  try { return globalThis.localStorage; } catch { return undefined; }
}
export function readPending(storage: StorageLike | undefined = browserStorage()): PendingRequest[] {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((p): p is PendingRequest => !!p && typeof p.origin === "string" && typeof p.id === "string" && /^[a-f0-9]{64}$/.test(p.id) &&
        typeof p.username === "string" && typeof p.serverName === "string" && typeof p.createdAt === "number")
      .map(({ origin, id, username, serverName, createdAt }) => ({ origin, id, username, serverName, createdAt }))
      .sort((a, b) => b.createdAt - a.createdAt);
  } catch { return []; }
}
function write(list: PendingRequest[], storage: StorageLike | undefined) {
  try { storage?.setItem(KEY, JSON.stringify(list.slice(0, LIMIT))); } catch { /* not remembered */ }
}
export function addPending(
  entry: { origin: string; id: string; username: string; serverName: string },
  storage: StorageLike | undefined = browserStorage(),
  now = Date.now(),
): void {
  const { origin, id, username, serverName } = entry;
  write([{ origin, id, username, serverName, createdAt: now }, ...readPending(storage).filter(p => p.id !== id)], storage);
}
export function removePending(id: string, storage: StorageLike | undefined = browserStorage()): void {
  write(readPending(storage).filter(p => p.id !== id), storage);
}
