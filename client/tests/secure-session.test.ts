import { afterEach, describe, expect, it, vi } from "vitest";
import { secureSession } from "../src/transport/secureSession";
import { loadStoredSession } from "../src/transport/sessionRestore";
import { ApiError } from "../src/transport/api";
import { initialConversation } from "../src/state/initialConversation";
import { lastConversation, remember } from "../src/state/remembered";

const ORIGIN = "https://chat.example.test";
const session = { token: "t0k", device_key: "d3v", username: "kim", expires_at: Date.now() + 86_400_000 };
const user = { id: "u1", username: "kim", is_owner: false };

/** A fake OS store behind the plugin commands. */
function stubNative(initial: Record<string, unknown> = { [ORIGIN]: session }) {
  const store: Record<string, unknown> = { ...initial };
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    const origin = String(args?.origin ?? "");
    switch (command) {
      case "plugin:secure-session|get": return { session: store[origin] ?? null };
      case "plugin:secure-session|set": store[origin] = args?.session; return { ok: true };
      case "plugin:secure-session|remove": delete store[origin]; return { ok: true };
      case "plugin:secure-session|list": return { origins: Object.keys(store) };
      default: throw new Error("Command not found");
    }
  });
  vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke } });
  return { invoke, store };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("secure session", () => {
  it("restore success reopens the last chat", async () => {
    stubNative();
    const memory: Record<string, string> = {};
    const storage = { getItem: (k: string) => memory[k] ?? null, setItem: (k: string, v: string) => { memory[k] = v; } };
    remember({ origin: ORIGIN, username: "kim", lastConversationId: "random" }, storage, 1);
    const found = await loadStoredSession(ORIGIN, async s => { expect(s).toEqual({ token: "t0k", device_key: "d3v" }); return user; });
    expect(found.status).toBe("ok");
    if (found.status !== "ok") return;
    expect(found.auth.user.username).toBe("kim");
    const channels = [{ id: "general", kind: "channel" }, { id: "random", kind: "channel" }];
    const open = initialConversation(channels, [{ general_channel_id: "general" }], lastConversation(ORIGIN, found.auth.user.username, storage));
    expect(open).toBe("random");
  });

  it("a 401 removes the stored session and leaves the person signed out", async () => {
    const { store } = stubNative();
    const found = await loadStoredSession(ORIGIN, async () => { throw new ApiError(401, "invalid or expired session"); });
    expect(found.status).toBe("gone");
    expect(store[ORIGIN]).toBeUndefined();
  });

  it("an offline server keeps the session for next time", async () => {
    const { store } = stubNative();
    const found = await loadStoredSession(ORIGIN, async () => { throw new TypeError("network"); });
    expect(found.status).toBe("offline");
    expect(store[ORIGIN]).toBeDefined();
  });

  it("an expired session is removed without asking the server", async () => {
    const { store } = stubNative({ [ORIGIN]: { ...session, expires_at: 1 } });
    const probe = vi.fn();
    expect((await loadStoredSession(ORIGIN, probe)).status).toBe("gone");
    expect(probe).not.toHaveBeenCalled();
    expect(store[ORIGIN]).toBeUndefined();
  });

  it("sign-out removes it, and set/list round-trip only the four known fields", async () => {
    const { invoke, store } = stubNative({});
    expect(await secureSession.set(ORIGIN, { ...session, extra: "x" } as never)).toBe(true);
    expect(Object.keys(store[ORIGIN] as object).sort()).toEqual(["device_key", "expires_at", "token", "username"]);
    expect(await secureSession.list()).toEqual([ORIGIN]);
    await secureSession.remove(ORIGIN);
    expect(store[ORIGIN]).toBeUndefined();
    expect(invoke).toHaveBeenCalledWith("plugin:secure-session|remove", { origin: ORIGIN });
  });

  it("the web build never calls invoke and reports nothing stored", async () => {
    const invoke = vi.fn();
    vi.stubGlobal("window", { invoke });
    expect(await secureSession.get(ORIGIN)).toBeNull();
    expect(await secureSession.set(ORIGIN, session)).toBe(false);
    expect(await secureSession.list()).toEqual([]);
    await secureSession.remove(ORIGIN);
    expect(invoke).not.toHaveBeenCalled();
    expect((await loadStoredSession(ORIGIN, vi.fn())).status).toBe("none");
  });

  it("a missing command or failing store degrades to memory-only without throwing", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke: async () => { throw "Command not found"; } } });
    expect(await secureSession.get(ORIGIN)).toBeNull();
    expect(await secureSession.set(ORIGIN, session)).toBe(false);
    expect(await secureSession.list()).toEqual([]);
  });
});
