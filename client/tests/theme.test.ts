import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ACCENTS } from "../src/ui/tokens/accent";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const tokens = read("../src/ui/tokens/tokens.css");
const accents = read("../src/ui/tokens/accents.css");
const styles = read("../src/ui/styles/index.css");
const LIGHT = "@media (prefers-color-scheme: light)";

function block(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`missing ${selector}`);
  const body = css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start));
  return Object.fromEntries([...body.matchAll(/(--hc-[a-z-]+):\s*(#[0-9a-f]{6})\b/gi)].map(m => [m[1], m[2].toLowerCase()]));
}
function channels(hex: string) { return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)); }
function luminance(hex: string) {
  const [r, g, b] = channels(hex).map(v => v / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const dark = block(tokens, ":root");
const light = block(tokens.slice(tokens.indexOf(LIGHT)), ":root");

describe("theme tokens", () => {
  for (const [name, t] of [["dark", dark], ["light", light]] as const) {
    it(`${name}: text, muted text and field lines are readable`, () => {
      for (const surface of [t["--hc-surface"], t["--hc-surface-raised"]]) {
        expect(contrast(t["--hc-text"], surface)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(t["--hc-text-muted"], surface)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(t["--hc-line"], surface)).toBeGreaterThanOrEqual(3);
      }
    });
  }
  it("the sidebar (shell) is the lighter surface and the open area (stage) the darker one, with readable text on both", () => {
    const alias = (name: string) => tokens.match(new RegExp(`${name}:\\s*var\\((--hc-[a-z-]+)\\)`))?.[1];
    expect(alias("--hc-shell")).toBe("--hc-surface");
    expect(alias("--hc-stage")).toBe("--hc-bg");
    for (const [name, t] of [["dark", dark], ["light", light]] as const) {
      const shell = t["--hc-surface"], stage = t["--hc-bg"];
      expect(luminance(shell), `${name} shell lighter than stage`).toBeGreaterThan(luminance(stage));
      for (const surface of [shell, stage]) {
        expect(contrast(t["--hc-text-muted"], surface), `${name} muted on ${surface}`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(t["--hc-text"], surface), `${name} text on ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
  it("the shell and stage tokens are used where the sidebar and open area are drawn", () => {
    expect(styles).toMatch(/\.hc-center \{[^}]*background: var\(--hc-stage\)/);
    expect(styles).toMatch(/\.hc-root \{[^}]*background: var\(--hc-shell\)/);
    expect(styles).toMatch(/\.hc-settings-layer \{[^}]*background: var\(--hc-stage\)/);
  });
  it("dark surfaces are a cool blue, not neutral or warm", () => {
    for (const key of ["--hc-bg", "--hc-surface", "--hc-surface-raised"]) {
      const [r, , b] = channels(dark[key]);
      expect(b - r, key).toBeGreaterThanOrEqual(8);
    }
  });
  it("the default accent is lavender", () => {
    expect(dark["--hc-accent"]).toBe(block(accents, ':root[data-accent="lavender"]')["--hc-accent"]);
    expect(light["--hc-accent"]).toBe(block(accents.slice(accents.indexOf(LIGHT)), ':root[data-accent="lavender"]')["--hc-accent"]);
  });
  it("no amber is left outside the opt-in Amber accent", () => {
    for (const css of [tokens, styles]) expect(css).not.toMatch(/e6a94f|f7d9a8|1f1407|c4c0b8|2a2826|0a0908/i);
  });
  for (const { id } of ACCENTS) {
    it(`accent ${id} is readable in both schemes`, () => {
      const d = block(accents, `:root[data-accent="${id}"]`);
      const l = block(accents.slice(accents.indexOf(LIGHT)), `:root[data-accent="${id}"]`);
      for (const [a, t] of [[d, dark], [l, light]] as const) {
        expect(contrast(a["--hc-accent"], t["--hc-surface"])).toBeGreaterThanOrEqual(4.5);
        expect(contrast(a["--hc-accent"], t["--hc-surface-raised"])).toBeGreaterThanOrEqual(4.5);
        expect(contrast(a["--hc-on-accent"], a["--hc-accent"])).toBeGreaterThanOrEqual(4.5);
      }
      expect(d["--hc-accent-night"]).toBe(d["--hc-accent"]);
    });
    it(`swatch ${id} shows its own dark accent`, () => {
      const swatch = accents.match(new RegExp(`\\[data-accent-swatch="${id}"\\][^{]*\\{[^}]*background:\\s*(#[0-9a-f]{6})`, "i"));
      expect(swatch?.[1].toLowerCase()).toBe(block(accents, `:root[data-accent="${id}"]`)["--hc-accent"]);
    });
  }
});
