import { describe, expect, it } from "vitest";
import { addPending, readPending, removePending } from "../src/state/pendingRequests";

function memory() { const d: Record<string, string> = {}; return { getItem: (k: string) => d[k] ?? null, setItem: (k: string, v: string) => { d[k] = v; }, d }; }
const id = (n: number) => String(n).padStart(64, "0");

describe("pending requests", () => {
  it("lists newest first and replaces by id", () => {
    const s = memory();
    addPending({ origin: "https://a.test", id: id(1), username: "kim", serverName: "A" }, s, 1);
    addPending({ origin: "https://b.test", id: id(2), username: "kim", serverName: "B" }, s, 2);
    addPending({ origin: "https://a.test", id: id(1), username: "kim", serverName: "A2" }, s, 3);
    expect(readPending(s).map(p => [p.serverName, p.createdAt])).toEqual([["A2", 3], ["B", 2]]);
  });
  it("removes one entry", () => {
    const s = memory();
    addPending({ origin: "https://a.test", id: id(1), username: "kim", serverName: "A" }, s, 1);
    removePending(id(1), s);
    expect(readPending(s)).toEqual([]);
  });
  it("survives junk, drops malformed ids and never stores extra fields", () => {
    const s = memory();
    s.setItem("hc-pending-v1", "{nope");
    expect(readPending(s)).toEqual([]);
    s.setItem("hc-pending-v1", JSON.stringify([{ origin: "https://a.test", id: "short", username: "k", serverName: "A", createdAt: 1 }]));
    expect(readPending(s)).toEqual([]);
    addPending({ origin: "https://a.test", id: id(1), username: "kim", serverName: "A", password: "secret" } as never, s, 1);
    expect(s.d["hc-pending-v1"]).not.toContain("secret");
  });
});
