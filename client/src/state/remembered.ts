/**
 * Non-secret memory of where you signed in, so the next launch can prefill Log in and
 * reopen the last chat. Never holds tokens, device keys, passwords or invite tokens.
 */
export interface RememberedAccount { origin: string; username: string; lastConversationId?: string; usedAt: number }
type StorageLike = Pick<Storage, "getItem" | "setItem">;
const KEY = "hc-remembered-v1";
const LIMIT = 10;

function browserStorage(): StorageLike | undefined {
  try { return globalThis.localStorage; } catch { return undefined; }
}
export function readAccounts(storage: StorageLike | undefined = browserStorage()): RememberedAccount[] {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((a): a is RememberedAccount => !!a && typeof a.origin === "string" && typeof a.username === "string" && typeof a.usedAt === "number")
      .map(({ origin, username, lastConversationId, usedAt }) => ({ origin, username, usedAt, ...(typeof lastConversationId === "string" ? { lastConversationId } : {}) }))
      .sort((a, b) => b.usedAt - a.usedAt);
  } catch { return []; }
}
function write(accounts: RememberedAccount[], storage: StorageLike | undefined) {
  try { storage?.setItem(KEY, JSON.stringify(accounts.slice(0, LIMIT))); } catch { /* not remembered */ }
}
export function remember(
  entry: { origin: string; username: string; lastConversationId?: string },
  storage: StorageLike | undefined = browserStorage(),
  now = Date.now(),
): void {
  const accounts = readAccounts(storage);
  const previous = accounts.find(a => a.origin === entry.origin && a.username === entry.username);
  const conversation = entry.lastConversationId ?? previous?.lastConversationId;
  const next: RememberedAccount = {
    origin: entry.origin, username: entry.username, usedAt: now,
    ...(conversation ? { lastConversationId: conversation } : {}),
  };
  write([next, ...accounts.filter(a => a !== previous)].sort((a, b) => b.usedAt - a.usedAt), storage);
}
export function lastConversation(origin: string, username: string, storage: StorageLike | undefined = browserStorage()): string | undefined {
  return readAccounts(storage).find(a => a.origin === origin && a.username === username)?.lastConversationId;
}
export function forgetConversation(origin: string, username: string, storage: StorageLike | undefined = browserStorage()): void {
  write(readAccounts(storage).map(a => (a.origin === origin && a.username === username ? { origin: a.origin, username: a.username, usedAt: a.usedAt } : a)), storage);
}
/** Removes one remembered account entirely (used when its secure session is gone and the person chooses "Not you?"). */
export function forgetAccount(origin: string, username: string, storage: StorageLike | undefined = browserStorage()): void {
  write(readAccounts(storage).filter(a => !(a.origin === origin && a.username === username)), storage);
}
