import { ApiError } from "./api";
import { secureSession } from "./secureSession";
import type { Auth, User } from "../data/types";

export type Restored =
  | { status: "ok"; auth: Auth }
  /** Nothing stored for this origin. */
  | { status: "none" }
  /** Expired, or the server refused it (401/403). It was removed from secure storage. */
  | { status: "gone" }
  /** The server could not be asked. The session is kept for the next launch. */
  | { status: "offline" };

/**
 * Looks up the stored session for `origin` and asks the server (`probe`, normally GET /api/me
 * with that session) whether it still works. Only a definite refusal deletes it.
 */
export async function loadStoredSession(
  origin: string,
  probe: (session: { token: string; device_key: string }) => Promise<User>,
  now = Date.now(),
): Promise<Restored> {
  const stored = await secureSession.get(origin);
  if (!stored) return { status: "none" };
  if (stored.expires_at <= now) {
    await secureSession.remove(origin);
    return { status: "gone" };
  }
  try {
    const user = await probe({ token: stored.token, device_key: stored.device_key });
    return { status: "ok", auth: { token: stored.token, device_key: stored.device_key, expires_at: stored.expires_at, user } };
  } catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
      await secureSession.remove(origin);
      return { status: "gone" };
    }
    return { status: "offline" };
  }
}
