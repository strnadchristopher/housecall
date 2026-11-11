import {
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import type { Api } from "./api";
import type { Auth } from "../data/types";

type Invoke = <T>(command: string, args: Record<string, unknown>) => Promise<T>;
export interface NativePasskeyStatus {
  platform: "android" | "unsupported";
  supported: boolean;
  configured: boolean;
  origin: string;
  rpId: string;
  appOrigin: string;
  /** Provider/Digital Asset Links verification occurs during the OS operation. */
  associationVerified: false;
}
const unavailable: NativePasskeyStatus = {
  platform: "unsupported", supported: false, configured: false,
  origin: "", rpId: "", appOrigin: "", associationVerified: false,
};
function nativeInvoke(): Invoke | undefined {
  return typeof window === "undefined" ? undefined :
    (window as unknown as { __TAURI_INTERNALS__?: { invoke: Invoke } }).__TAURI_INTERNALS__?.invoke;
}
export function isDesktopTauri(): boolean {
  return !!nativeInvoke() && typeof navigator !== "undefined" && !/Android/i.test(navigator.userAgent);
}
async function nativeCall<T>(call: Invoke, action: string, payload: Record<string, unknown> = {}): Promise<T> {
  try { return await call<T>("native_auth", { action, payload }); }
  catch (error) {
    throw error instanceof Error ? error : new Error(typeof error === "string" ? error : "Native authentication failed");
  }
}
export async function nativePasskeyStatus(): Promise<NativePasskeyStatus> {
  const call = nativeInvoke();
  if (!call) return { ...unavailable };
  try { return await nativeCall(call, "status"); }
  catch (error) {
    if (error instanceof Error && error.message === "Command native_auth not found") return { ...unavailable };
    throw error;
  }
}
/** UI/account teardown may cancel a pending provider prompt; no credential is retained. */
export async function cancelNativePasskey(): Promise<void> {
  const call = nativeInvoke();
  if (call && (await nativePasskeyStatus()).platform === "android") await nativeCall(call, "cancel");
}
function apiOrigin(api: Api): string {
  return new URL(api.mediaRequest("/api/passkeys/login/start").url).origin;
}
async function nativeContext(api: Api): Promise<NativePasskeyStatus | undefined> {
  if (!nativeInvoke()) return undefined;
  const status = await nativePasskeyStatus();
  if (!status.supported || !status.configured || status.platform !== "android")
    throw new Error("Native passkeys are unavailable in this app build; use password sign-in");
  if (status.origin !== apiOrigin(api) || status.rpId !== new URL(status.origin).hostname)
    throw new Error("This app build is not associated with the selected passkey server");
  return status;
}
async function nativeCredential(
  status: NativePasskeyStatus, action: "register" | "authenticate",
  options: PublicKeyCredentialCreationOptionsJSON | PublicKeyCredentialRequestOptionsJSON,
  androidOrigins: string[] | undefined,
): Promise<unknown> {
  const rpId = "rp" in options ? options.rp.id : options.rpId;
  if (rpId !== status.rpId || !androidOrigins?.includes(status.appOrigin))
    throw new Error("The server has not authorized passkeys for this app build");
  const call = nativeInvoke();
  if (!call) throw new Error("Native passkeys are unavailable");
  const result = await nativeCall<{ credentialJson: string }>(call, action, {
    origin: status.origin, androidOrigins, requestJson: JSON.stringify(options),
  });
  try {
    if (typeof result.credentialJson !== "string" || result.credentialJson.length > 131072) throw new Error();
    const value: unknown = JSON.parse(result.credentialJson);
    if (!value || typeof value !== "object" || !("type" in value) || value.type !== "public-key" ||
      !("id" in value) || typeof value.id !== "string" || !("rawId" in value) ||
      typeof value.rawId !== "string" || !("response" in value) || !value.response ||
      typeof value.response !== "object") throw new Error();
    return value;
  } catch { throw new Error("The credential provider returned an invalid response"); }
}

export async function registerPasskey(api: Api) {
  const native = await nativeContext(api);
  const origin = apiOrigin(api);
  const start = await api.post<{
    challenge_id: string;
    options: { publicKey: PublicKeyCredentialCreationOptionsJSON };
    android_origins?: string[];
  }>("/api/passkeys/register/start", {});
  const credential = native ? await nativeCredential(native, "register", start.options.publicKey, start.android_origins) : await startRegistration({
    optionsJSON: start.options.publicKey,
  });
  if (apiOrigin(api) !== origin) throw new Error("The selected server changed during passkey registration");
  return api.post("/api/passkeys/register/finish", {
    challenge_id: start.challenge_id,
    credential,
  });
}
export async function authenticatePasskey(api: Api, username: string) {
  const native = await nativeContext(api);
  const origin = apiOrigin(api);
  const start = await api.post<{
    challenge_id: string;
    options: { publicKey: PublicKeyCredentialRequestOptionsJSON };
    android_origins?: string[];
  }>("/api/passkeys/login/start", { username });
  const credential = native ? await nativeCredential(native, "authenticate", start.options.publicKey, start.android_origins) : await startAuthentication({
    optionsJSON: start.options.publicKey,
  });
  if (apiOrigin(api) !== origin) throw new Error("The selected server changed during passkey sign-in");
  return api.post<Auth>("/api/passkeys/login/finish", {
    challenge_id: start.challenge_id,
    credential,
    device_name: native ? "Housecall Android passkey" : "Housecall browser passkey",
  });
}
