import type { Session } from "./api";

type Invoke = <T>(command: string, args: Record<string, unknown>) => Promise<T>;
export interface NativePushStatus {
  supported: boolean;
  configured: boolean;
  enabled: boolean;
  permissionGranted: boolean;
}
function invoke(): Invoke | undefined {
  return (window as unknown as { __TAURI_INTERNALS__?: { invoke: Invoke } })
    .__TAURI_INTERNALS__?.invoke;
}
async function callNative<T>(call: Invoke, action: string, payload: Record<string, unknown> = {}): Promise<T> {
  try { return await call<T>("native_push", { action, payload }); }
  catch (error) {
    // Tauri serializes Rust Result<_, String> failures as strings, not Error objects.
    throw error instanceof Error ? error : new Error(typeof error === "string" ? error : "Native push operation failed");
  }
}
const unsupported: NativePushStatus = {
  supported: false, configured: false, enabled: false, permissionGranted: false,
};
/** Android only. Does not request permission, register a token, or persist credentials. */
export async function nativePushStatus(): Promise<NativePushStatus> {
  const call = invoke();
  if (!call) return { ...unsupported };
  try { return await callNative(call, "status"); }
  catch (error) {
    if (!/Android/i.test(navigator.userAgent) && error instanceof Error && error.message === "Command native_push not found")
      return { ...unsupported };
    throw error;
  }
}
/** Call only from an explicit user opt-in; Android requests OS permission here. */
export async function enableNativePush(origin: string, session: Session): Promise<void> {
  const call = invoke();
  if (!call) throw new Error("Native push is unavailable");
  await callNative(call, "enable", {
    origin, token: session.token, deviceKey: session.device_key,
  });
}
/** Call after reconnect/resume. Native Android also schedules this independently. */
export async function reconcileNativePush(): Promise<void> {
  const call = invoke();
  if (call && (await nativePushStatus()).supported)
    await callNative(call, "reconcile");
}
/** Await before account replacement and before server logout; errors must not be swallowed. */
export async function clearNativePush(): Promise<void> {
  const call = invoke();
  if (call && (await nativePushStatus()).supported)
    await callNative(call, "clear");
}
