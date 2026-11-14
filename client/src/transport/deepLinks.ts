import { decodeInviteCode } from "../data/inviteCode";

export interface InviteLink { token: string; server_origin: string }
type Invoke = <T>(command: string, args: Record<string, unknown>) => Promise<T>;

/**
 * The app's custom scheme, `housecall://invite?code=<hc1 code>`, and nothing else: no other host, path,
 * parameter or fragment. The code carries the server origin (same origin rule as invite codes).
 */
export function parseSchemeInvite(url: string): InviteLink | undefined {
  if (url.length > 2048) return;
  const match = /^housecall:\/\/invite\?code=([A-Za-z0-9._-]+)$/.exec(url);
  const code = match ? decodeInviteCode(match[1]) : undefined;
  return code ? { token: code.token, server_origin: code.origin } : undefined;
}

/** Strict original-string check prevents URL normalization from accepting alternate paths. */
export function parseInviteLink(value: string, expectedOrigin: string): InviteLink | undefined {
  try {
    const origin = new URL(expectedOrigin);
    if (origin.origin !== expectedOrigin || origin.username || origin.password ||
      (origin.protocol !== "https:" && !(origin.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)))) return;
    const prefix = `${expectedOrigin}/#invite=`;
    if (!value.startsWith(prefix)) return;
    const token = value.slice(prefix.length);
    if (!/^[a-f0-9]{64}$/.test(token)) return;
    return { token, server_origin: expectedOrigin };
  } catch { return; }
}

/** Prefill only: this transport never redeems an invite or replaces an account. */
export function subscribeInviteLinks(
  onInvite: (invite: InviteLink) => void,
  onError?: (error: Error) => void,
  onLinkScan?: () => void,
): () => void {
  let stopped = false;
  let busy = false;
  let unsupported = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const call = (window as unknown as { __TAURI_INTERNALS__?: { invoke: Invoke } }).__TAURI_INTERNALS__?.invoke;
  const browserLink = () => {
    if (stopped || call || !location.hash.startsWith("#invite=")) return;
    const invite = parseInviteLink(location.href, location.origin);
    // Strip before callback/render, with no token in browser history or later requests.
    history.replaceState(history.state, "", location.pathname + location.search);
    if (invite) onInvite(invite);
    else onError?.(new Error("Invalid invitation link"));
  };
  const poll = async () => {
    if (stopped || busy || unsupported || !call) return;
    busy = true;
    try {
      const result = await call<{ id?: string; invite?: InviteLink; url?: string }>("native_auth", { action: "takeInvite", payload: {} });
      if (!stopped && typeof result.url === "string") {
        // Android: a housecall:// link captured by InviteLinkInbox.
        if (result.url === 'housecall://link-scan') {
          onLinkScan?.();
          await call("native_auth", { action: "acknowledgeInvite", payload: { id: result.id } });
          return;
        }
        const parsed = parseSchemeInvite(result.url);
        if (!parsed || typeof result.id !== "string" || !/^[a-f0-9-]{36}$/.test(result.id)) throw new Error("Invalid invitation link");
        onInvite(parsed);
        await call("native_auth", { action: "acknowledgeInvite", payload: { id: result.id } });
      } else if (!stopped && result.invite) {
        const { token, server_origin } = result.invite;
        const parsed = parseInviteLink(`${server_origin}/#invite=${token}`, server_origin);
        if (!parsed || !server_origin.startsWith("https://") ||
          typeof result.id !== "string" || !/^[a-f0-9-]{36}$/.test(result.id)) throw new Error("Invalid invitation link");
        onInvite(parsed);
        await call("native_auth", { action: "acknowledgeInvite", payload: { id: result.id } });
      }
    } catch (error) {
      if (String(error) === "Command native_auth not found" ||
        (error instanceof Error && error.message === "Command native_auth not found")) unsupported = true;
      else if (!stopped) { unsupported = true; onError?.(new Error("Unable to receive native invitation links")); }
    } finally {
      busy = false;
      if (!stopped && !unsupported) timer = setTimeout(() => { void poll(); }, 500);
    }
  };
  // iOS (and macOS): housecall:// URLs arrive as RunEvent::Opened in src-tauri and wait in a one-shot inbox.
  let schemeBusy = false;
  let schemeUnsupported = false;
  let schemeTimer: ReturnType<typeof setTimeout> | undefined;
  const pollScheme = async () => {
    if (stopped || schemeBusy || schemeUnsupported || !call) return;
    schemeBusy = true;
    try {
      const result = await call<{ url?: string | null }>("scheme_invite_take", {});
      if (!stopped && typeof result?.url === "string") {
        if (result.url === 'housecall://link-scan') { onLinkScan?.(); return; }
        const parsed = parseSchemeInvite(result.url);
        if (parsed) onInvite(parsed);
        else onError?.(new Error("Invalid invitation link"));
      }
    } catch {
      schemeUnsupported = true; // Android and the web build: the command does not exist.
    } finally {
      schemeBusy = false;
      if (!stopped && !schemeUnsupported) schemeTimer = setTimeout(() => { void pollScheme(); }, 500);
    }
  };
  window.addEventListener("hashchange", browserLink);
  // Defer so React StrictMode's setup/cleanup probe cannot consume the one-shot invite.
  timer = setTimeout(() => { browserLink(); void poll(); void pollScheme(); }, 0);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (schemeTimer) clearTimeout(schemeTimer);
    window.removeEventListener("hashchange", browserLink);
  };
}

/** Web handoff: strip the fragment synchronously before parsing/rendering/network calls.
 * Native callers must scan with their own camera; never use this code as a native handoff. */
export function takeBrowserLinkFragment(): string | undefined {
  if (typeof window === 'undefined' || !location.hash.startsWith('#link=')) return;
  const fragment = location.hash.slice(6);
  history.replaceState(history.state, '', location.pathname + location.search);
  return `${location.origin}/link#${fragment}`;
}
