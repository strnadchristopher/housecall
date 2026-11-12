import { describe, expect, it } from "vitest";
import { forgetConversation, lastConversation, readAccounts, remember } from "../src/state/remembered";

function memory() { const d: Record<string, string> = {}; return { getItem: (k: string) => d[k] ?? null, setItem: (k: string, v: string) => { d[k] = v; }, d }; }

describe("remembered accounts", () => {
  it("lists most recent first and updates in place", () => {
    const s = memory();
    remember({ origin: "https://a.test", username: "kim" }, s, 1);
    remember({ origin: "https://b.test", username: "kim" }, s, 2);
    remember({ origin: "https://a.test", username: "kim", lastConversationId: "c1" }, s, 3);
    expect(readAccounts(s).map(a => [a.origin, a.usedAt])).toEqual([["https://a.test", 3], ["https://b.test", 2]]);
    expect(lastConversation("https://a.test", "kim", s)).toBe("c1");
  });
  it("keeps the last conversation when a later update omits it", () => {
    const s = memory();
    remember({ origin: "https://a.test", username: "kim", lastConversationId: "c1" }, s, 1);
    remember({ origin: "https://a.test", username: "kim" }, s, 2);
    expect(lastConversation("https://a.test", "kim", s)).toBe("c1");
    forgetConversation("https://a.test", "kim", s);
    expect(lastConversation("https://a.test", "kim", s)).toBeUndefined();
  });
  it("survives junk and caps the list at ten", () => {
    const s = memory();
    s.setItem("hc-remembered-v1", "{not json");
    expect(readAccounts(s)).toEqual([]);
    for (let i = 0; i < 12; i++) remember({ origin: `https://${i}.test`, username: "kim" }, s, i);
    expect(readAccounts(s)).toHaveLength(10);
  });
  it("never stores anything but origin, username, conversation id and time", () => {
    const s = memory();
    remember({ origin: "https://a.test", username: "kim", token: "secret" } as never, s, 1);
    expect(s.d["hc-remembered-v1"]).not.toContain("secret");
  });
});
