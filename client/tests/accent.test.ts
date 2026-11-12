import { describe, expect, it } from "vitest";
import { ACCENTS, applyAccent, readAccent } from "../src/ui/tokens/accent";

function memory(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return { getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => { data[k] = v; }, data };
}

describe("accent", () => {
  it("defaults to lavender and ignores unknown values", () => {
    expect(readAccent(memory())).toBe("lavender");
    expect(readAccent(memory({ "hc-accent": "chartreuse" }))).toBe("lavender");
  });
  it("applies and remembers a choice", () => {
    const store = memory();
    const root = { dataset: {} as Record<string, string> };
    expect(applyAccent("mint", root, store)).toBe("mint");
    expect(root.dataset.accent).toBe("mint");
    expect(readAccent(store)).toBe("mint");
  });
  it("offers six accents, lavender first", () => {
    expect(ACCENTS.map(a => a.id)).toEqual(["lavender", "sky", "mint", "rose", "coral", "amber"]);
  });
  it("still applies when storage throws", () => {
    const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    const root = { dataset: {} as Record<string, string> };
    expect(readAccent(broken)).toBe("lavender");
    expect(applyAccent("rose", root, broken)).toBe("rose");
    expect(root.dataset.accent).toBe("rose");
  });
});
