export interface InviteLink { token: string; server_origin: string }
type Invoke = <T>(command: string, args: Record<string, unknown>) => Promise<T>;

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
      const result = await call<{ id?: string; invite?: InviteLink }>("native_auth", { action: "takeInvite", payload: {} });
      if (!stopped && result.invite) {
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
  window.addEventListener("hashchange", browserLink);
  // Defer so React StrictMode's setup/cleanup probe cannot consume the one-shot invite.
  timer = setTimeout(() => { browserLink(); void poll(); }, 0);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    window.removeEventListener("hashchange", browserLink);
  };
}
