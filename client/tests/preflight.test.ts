import { describe, expect, it } from "vitest";
import { preflightRows } from "../src/ui/setup/preflight";

const good = { https: { ok: true }, call_port: { ok: true }, storage: { ok: true } };

describe("first-run checklist rows", () => {
  it("never treats a configured call port as externally verified", () => {
    const rows = preflightRows(good);
    expect(rows.map(r => r.id)).toEqual(["https", "call_port", "storage"]);
    expect(rows.filter(r => r.ok).map(r => r.id)).toEqual(["https", "storage"]);
    expect(rows[1].help).toContain("another network");
  });
  it("gives one sentence and a SELF-HOSTING link per failed check", () => {
    const rows = preflightRows({ https: { ok: false, reason: "plain_http" }, call_port: { ok: false, reason: "voice_off" }, storage: { ok: false, reason: "not_writable" } });
    for (const row of rows) {
      expect(row.ok).toBe(false);
      expect(row.help).toMatch(/^[^.]+\.$/);
      expect(row.help).not.toMatch(/—|!/);
      expect(row.href).toMatch(/^docs\/SELF-HOSTING\.md#[a-z-]+$/);
    }
    expect(new Set(rows.map(r => r.href)).size).toBe(3);
  });
  it("falls back to the generic sentence for an unknown reason", () => {
    const [row] = preflightRows({ ...good, https: { ok: false, reason: "something_new" } });
    expect(row.ok).toBe(false);
    expect(row.help).toBeTruthy();
  });
});
