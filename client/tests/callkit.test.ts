import { afterEach, describe, expect, it, vi } from "vitest";
import { callKit, isCallKit } from "../src/transport/callkit";
import { RING_FRESH_MS, toCallEvent } from "../src/state/callEvents";

const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15";

function stubApp(userAgent: string, invoke = vi.fn(async () => ({ supported: true })), maxTouchPoints = 5) {
  vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke } });
  vi.stubGlobal("navigator", { userAgent, maxTouchPoints });
  return invoke;
}

describe("isCallKit", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("is false in a plain browser and in the Tauri desktop and Android apps", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { userAgent: iphone, maxTouchPoints: 5 });
    expect(isCallKit()).toBe(false);
    stubApp("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15", undefined, 0);
    expect(isCallKit()).toBe(false);
    stubApp("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36");
    expect(isCallKit()).toBe(false);
  });

  it("is true in the Tauri iOS app, including an iPad that reports a desktop user agent", () => {
    stubApp(iphone);
    expect(isCallKit()).toBe(true);
    stubApp("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15", undefined, 5);
    expect(isCallKit()).toBe(true);
    stubApp("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15", undefined, 0);
    expect(isCallKit()).toBe(false);
  });
});

describe("callKit commands", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("answers unsupported without calling the app when not on iOS", async () => {
    const invoke = stubApp("Mozilla/5.0 (X11; Linux x86_64)", undefined, 0);
    expect(await callKit.register()).toEqual({ supported: false });
    expect(await callKit.reportIncoming("room", "Avery")).toBe(false);
    expect(await callKit.pending()).toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("sends the action and payload to the one app command on iOS", async () => {
    const invoke = stubApp(iphone, vi.fn(async () => ({ supported: true, pending: { channelId: "room", name: "Avery", answered: true } })));
    expect(await callKit.reportIncoming("room", "Avery")).toBe(true);
    await callKit.startOutgoing("room", "Avery");
    await callKit.connected("room");
    await callKit.end("room", { remote: true, declined: true });
    expect(await callKit.pending()).toEqual({ channelId: "room", name: "Avery", answered: true });
    expect(invoke.mock.calls).toEqual([
      ["callkit", { action: "report_incoming", payload: { channelId: "room", displayName: "Avery" } }],
      ["callkit", { action: "start_outgoing", payload: { channelId: "room", displayName: "Avery" } }],
      ["callkit", { action: "connected", payload: { channelId: "room" } }],
      ["callkit", { action: "end", payload: { channelId: "room", remote: true, declined: true } }],
      ["callkit", { action: "pending", payload: {} }],
    ]);
  });

  it("reports a refused system call as not shown, so the in-app toast can take over", async () => {
    stubApp(iphone, vi.fn(async () => { throw "The system call screen refused the request"; }));
    expect(await callKit.reportIncoming("room", "Avery")).toBe(false);
    await expect(callKit.register()).rejects.toThrow("refused");
  });
});

describe("toCallEvent", () => {
  const ring = { kind: "call.ring", channel_id: "room", payload: { channel_id: "room", from: "u1", from_name: "Avery" }, created_at: 1_000_000 };

  it("is fresh only within 30 seconds of the server's clock", () => {
    expect(toCallEvent(ring, 1_000_000 + RING_FRESH_MS - 1)?.fresh).toBe(true);
    expect(toCallEvent(ring, 1_000_000 + RING_FRESH_MS)?.fresh).toBe(false);
    expect(toCallEvent(ring, undefined)?.fresh).toBe(false);
    expect(toCallEvent(ring, 1_000_100)).toMatchObject({ kind: "call.ring", channelId: "room", fromId: "u1", fromName: "Avery" });
  });

  it("ignores other events and malformed ones", () => {
    expect(toCallEvent({ ...ring, kind: "message.created" }, 1_000_100)).toBeUndefined();
    expect(toCallEvent({ ...ring, payload: {} }, 1_000_100)).toBeUndefined();
  });
});
