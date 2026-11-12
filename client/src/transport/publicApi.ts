import { isInviteOrigin } from "../data/inviteCode";
import { ApiError } from "./api";

/**
 * Unauthenticated calls to a server that is not (yet) a signed-in host: instance info and
 * access requests. Same origin rule as invite codes (https, or http on loopback); no cookies,
 * no redirects, no cache, and a time limit. Never carries a session.
 */
export async function publicJson<T>(origin: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  if (!isInviteOrigin(origin)) throw new Error("The server must use HTTPS");
  if (!path.startsWith("/api/")) throw new Error("API path required");
  const timeout = AbortSignal.timeout(15_000);
  const response = await fetch(origin + path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  }).catch(() => { throw new Error("Could not reach that server"); });
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(response.status, data.error ?? `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}
