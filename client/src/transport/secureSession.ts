/**
 * The signed-in session in OS secure storage (iOS Keychain, Android Keystore, desktop keyring),
 * through src-tauri/plugins/tauri-plugin-secure-session. The web build uses ./webSession instead
 * (sealed with a non-extractable browser key) so a reload keeps you signed in.
 * Every function degrades to "nothing stored" when the app is not native, the command is
 * missing, or the OS store is unavailable, so the app silently stays memory-only.
 * Values are never logged.
 */
import { webSession } from "./webSession";
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export interface StoredSession {
  token: string;
  device_key: string;
  username: string;
  expires_at: number;
}

function invoke(): Invoke | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { __TAURI_INTERNALS__?: { invoke: Invoke } }).__TAURI_INTERNALS__?.invoke;
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T | undefined> {
  const run = invoke();
  if (!run) return undefined;
  try {
    return await run<T>(`plugin:secure-session|${command}`, args);
  } catch {
    return undefined;
  }
}

function valid(value: unknown): value is StoredSession {
  const s = value as Partial<StoredSession> | null;
  return !!s && typeof s === "object" && typeof s.token === "string" && typeof s.device_key === "string" &&
    typeof s.username === "string" && typeof s.expires_at === "number";
}

export const secureSession = {
  /** The stored session for a server origin, or null. */
  async get(origin: string): Promise<StoredSession | null> {
    if (!invoke()) return webSession.get(origin);
    const result = await call<{ session?: unknown }>("get", { origin });
    let value: unknown = result?.session;
    if (typeof value === "string") {
      try { value = JSON.parse(value); } catch { return null; }
    }
    return valid(value) ? value : null;
  },
  /** Resolves true when the session was stored. */
  async set(origin: string, session: StoredSession): Promise<boolean> {
    if (!invoke()) return webSession.set(origin, session);
    const { token, device_key, username, expires_at } = session;
    return (await call<{ ok?: boolean }>("set", { origin, session: { token, device_key, username, expires_at } }))?.ok === true;
  },
  async remove(origin: string): Promise<void> {
    if (!invoke()) return webSession.remove(origin);
    await call("remove", { origin });
  },
  /** Origins with a stored session, most recently used first. */
  async list(): Promise<string[]> {
    if (!invoke()) return webSession.list();
    const result = await call<{ origins?: unknown }>("list");
    return Array.isArray(result?.origins) ? result.origins.filter((o): o is string => typeof o === "string") : [];
  },
};
