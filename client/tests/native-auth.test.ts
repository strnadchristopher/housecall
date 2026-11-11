import { afterEach, describe, expect, it, vi } from "vitest";
import { Api } from "../src/transport/api";
import { authenticatePasskey, registerPasskey } from "../src/transport/passkeys";
import { parseInviteLink, subscribeInviteLinks } from "../src/transport/deepLinks";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";

vi.mock("@simplewebauthn/browser", () => ({ startAuthentication: vi.fn(), startRegistration: vi.fn() }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); vi.useRealTimers(); });
const origin = "https://chat.example.test";
const appOrigin = `android:apk-key-hash:${"A".repeat(43)}`;
const nativeStatus = { platform: "android", supported: true, configured: true, origin,
  rpId: "chat.example.test", appOrigin, associationVerified: false };
const credential = { id: "credential", rawId: "Y3JlZGVudGlhbA", type: "public-key",
  response: { clientDataJSON: "encoded-provider-response", authenticatorData: "data", signature: "signature" } };
function native(call: (command: string, args: {action: string; payload: Record<string, unknown>}) => Promise<unknown>) {
  vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke: call } });
}
function fixture(registration = false, androidOrigins = [appOrigin]) {
  const options = { challenge: "C".repeat(43), ...(registration ? { rp: { id: "chat.example.test", name: "Housecall" } } : { rpId: "chat.example.test" }) };
  const fetch = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(
    String(url).endsWith("/start") ? { challenge_id: "server-bound-id", options: { publicKey: options }, android_origins: androidOrigins } : { token: "fixture-token", device_key: "fixture-device" },
  ), { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetch);
  return { fetch, options };
}

describe("native passkey transport", () => {
  it("preserves browser WebAuthn and uses the original challenge ID", async () => {
    vi.stubGlobal("window", {});
    const { fetch, options } = fixture();
    vi.mocked(startAuthentication).mockResolvedValue(credential as never);
    await authenticatePasskey(new Api(origin), "owner");
    expect(startAuthentication).toHaveBeenCalledWith({ optionsJSON: options });
    expect(JSON.parse((fetch.mock.calls[1] as unknown as [string, RequestInit])[1].body as string))
      .toEqual({ challenge_id: "server-bound-id", credential, device_name: "Housecall browser passkey" });
  });
  it("uses Credential Manager JSON unchanged and preserves device headers during registration", async () => {
    const { fetch, options } = fixture(true);
    const call = vi.fn(async (_command: string, args: { action: string; payload: Record<string, unknown> }) => args.action === "status" ? nativeStatus : { credentialJson: JSON.stringify(credential) });
    native(call);
    const api = new Api(origin);
    api.authenticate({ token: "session-token", device_key: "device-secret" });
    await registerPasskey(api);
    expect(startRegistration).not.toHaveBeenCalled();
    expect(call.mock.calls[1][1]).toEqual({ action: "register", payload: {
      origin, androidOrigins: [appOrigin], requestJson: JSON.stringify(options),
    } });
    for (const [, init] of fetch.mock.calls as unknown as [string, RequestInit][]) {
      expect(new Headers(init.headers).get("Authorization")).toBe("Bearer session-token");
      expect(new Headers(init.headers).get("X-Device-Key")).toBe("device-secret");
    }
    expect(JSON.parse((fetch.mock.calls[1] as unknown as [string, RequestInit])[1].body as string))
      .toEqual({ challenge_id: "server-bound-id", credential });
  });
  it("rejects unapproved certificates and wrong RP IDs before any native prompt", async () => {
    fixture(false, []);
    const call = vi.fn(async () => nativeStatus);
    native(call);
    await expect(authenticatePasskey(new Api(origin), "owner")).rejects.toThrow("not authorized");
    expect(call).toHaveBeenCalledTimes(1);
    expect(startAuthentication).not.toHaveBeenCalled();
    fixture();
    call.mockResolvedValue({ ...nativeStatus, rpId: "other.example.test" });
    await expect(authenticatePasskey(new Api(origin), "owner")).rejects.toThrow("not associated");
  });
  it("never falls back to WebView authentication for unsupported iOS/desktop native runtimes", async () => {
    const { fetch } = fixture();
    native(async () => { throw "Command native_auth not found"; });
    await expect(authenticatePasskey(new Api(origin), "owner")).rejects.toThrow("unavailable");
    expect(fetch).not.toHaveBeenCalled();
    expect(startAuthentication).not.toHaveBeenCalled();
  });
  it("does not submit a response after cancellation or server replacement", async () => {
    const { fetch } = fixture();
    native(async (_command, args) => {
      if (args.action === "status") return nativeStatus;
      throw "Passkey request cancelled";
    });
    await expect(authenticatePasskey(new Api(origin), "owner")).rejects.toThrow("cancelled");
    expect(fetch).toHaveBeenCalledTimes(1);
    const api = new Api(origin);
    native(async (_command, args) => {
      if (args.action === "status") return nativeStatus;
      api.configure("https://other.example.test");
      return { credentialJson: JSON.stringify(credential) };
    });
    await expect(authenticatePasskey(api, "owner")).rejects.toThrow("server changed");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("invite links", () => {
  const token = "b".repeat(64);
  it("accepts only an exact origin/root and fragment-held canonical token", () => {
    expect(parseInviteLink(`${origin}/#invite=${token}`, origin)).toEqual({ token, server_origin: origin });
    for (const raw of [
      `https://evil.test/#invite=${token}`, `${origin}/?invite=${token}`, `${origin}/other#invite=${token}`,
      `${origin}/a/../#invite=${token}`, `${origin}/#invite=${token}&server_origin=https://evil.test`,
      `${origin}/#invite=${token}%0a`, `${origin}/#invite=${"B".repeat(64)}`, `housecall://invite/#invite=${token}`,
      `https://user@chat.example.test/#invite=${token}`, `${origin}:443/#invite=${token}`,
    ]) expect(parseInviteLink(raw, origin)).toBeUndefined();
  });
  it("strips browser token before delivering an invite without making a request", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("location", { href: `${origin}/#invite=${token}`, origin, hash: `#invite=${token}`, pathname: "/", search: "" });
    const replaceState = vi.fn();
    vi.stubGlobal("history", { state: null, replaceState });
    const receive = vi.fn(() => { expect(replaceState).toHaveBeenCalledWith(null, "", "/"); });
    const stop = subscribeInviteLinks(receive);
    await vi.advanceTimersByTimeAsync(1);
    expect(receive).toHaveBeenCalledWith({ token, server_origin: origin });
    stop();
  });
  it("does not acknowledge native intent until a live subscriber has received it", async () => {
    vi.useFakeTimers();
    let finish: (value: unknown) => void = () => {};
    const call = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const events = Object.assign(new EventTarget(), { __TAURI_INTERNALS__: { invoke: call } });
    vi.stubGlobal("window", events);
    const receive = vi.fn();
    const stop = subscribeInviteLinks(receive);
    await vi.advanceTimersByTimeAsync(1);
    stop();
    finish({ id: "00000000-0000-0000-0000-000000000001", invite: { token, server_origin: origin } });
    await Promise.resolve();
    expect(receive).not.toHaveBeenCalled();
    expect(call).toHaveBeenCalledTimes(1);
  });
  it("acknowledges only after delivery and never forwards token in the receipt", async () => {
    vi.useFakeTimers();
    const receive = vi.fn();
    const id = "00000000-0000-0000-0000-000000000001";
    const call = vi.fn(async (_command: string, args: { action: string; payload: Record<string, unknown> }) => {
      if (args.action === "takeInvite") return { id, invite: { token, server_origin: origin } };
      expect(receive).toHaveBeenCalledOnce();
      expect(args).toEqual({ action: "acknowledgeInvite", payload: { id } });
      return {};
    });
    vi.stubGlobal("window", Object.assign(new EventTarget(), { __TAURI_INTERNALS__: { invoke: call } }));
    const stop = subscribeInviteLinks(receive);
    await vi.advanceTimersByTimeAsync(1);
    expect(receive).toHaveBeenCalledWith({ token, server_origin: origin });
    expect(call).toHaveBeenCalledTimes(2);
    stop();
  });
});
