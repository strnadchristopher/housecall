type Invoke = <T>(command: string, args: Record<string, unknown>) => Promise<T>;

function nativeInvoke(): Invoke | undefined {
  return typeof window === "undefined" ? undefined :
    (window as unknown as { __TAURI_INTERNALS__?: { invoke: Invoke } }).__TAURI_INTERNALS__?.invoke;
}

/**
 * The interface has no passkey sign-in. This remains only so teardown can
 * cancel a prompt the Android bridge may still have open; nothing is retained.
 */
export async function cancelNativePasskey(): Promise<void> {
  const call = nativeInvoke();
  if (!call) return;
  try {
    const status = await call<{ platform: string }>("native_auth", { action: "status", payload: {} });
    if (status.platform === "android") await call("native_auth", { action: "cancel", payload: {} });
  } catch { /* no bridge in this build: nothing to cancel */ }
}
