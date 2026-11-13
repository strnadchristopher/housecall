// WCAG contrast of text tokens on --hc-shell and --hc-stage, read from the real token files.
// Run: node design/040/contrast.mjs   (prints the table in docs/design/HC-040.md section 2)
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const tokens = join(dirname(fileURLToPath(import.meta.url)), "../../client/src/ui/tokens");
const read = file => readFileSync(join(tokens, file), "utf8");

/** Every `--hc-x: #hex` inside the first block that follows `marker`. */
function block(css, marker, from = 0) {
  const at = css.indexOf(marker, from);
  if (at < 0) throw new Error(`no block ${marker}`);
  const open = css.indexOf("{", at + marker.length - 1);
  let depth = 0, end = open;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}" && --depth === 0) { end = i; break; }
  }
  const out = {};
  for (const [, name, value] of css.slice(open, end).matchAll(/--hc-([a-z-]+):\s*(#[0-9a-f]{6})/g)) out[name] = value;
  return out;
}

const a = read("tokens.css"), b = read("directions/b.css"), c = read("directions/c.css");
const aDark = block(a, ":root {");
const aLight = { ...aDark, ...block(a, "@media (prefers-color-scheme: light)") };
const bLight = block(b, ':root[data-direction="b"] {');
const bDark = { ...bLight, ...block(b, "@media (prefers-color-scheme: dark)") };
const cDark = block(c, ':root[data-direction="c"] {');
const cLight = { ...cDark, ...block(c, "@media (prefers-color-scheme: light)") };

const lin = v => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const lum = hex => { const n = parseInt(hex.slice(1), 16); return 0.2126 * lin((n >> 16) / 255) + 0.7152 * lin(((n >> 8) & 255) / 255) + 0.0722 * lin((n & 255) / 255); };
export const ratio = (x, y) => { const [hi, lo] = [lum(x), lum(y)].sort((p, q) => q - p); return (hi + 0.05) / (lo + 0.05); };

const rows = [["A dark", aDark], ["A light", aLight], ["B light", bLight], ["B dark", bDark], ["C dark", cDark], ["C light", cLight]];
console.log("| Scheme | shell | stage | text/shell | text/stage | muted/shell | muted/stage | muted/raised | accent/shell | accent/stage | danger/shell | danger/stage | line/shell | line/stage |");
console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const [name, t] of rows) {
  const shell = t.surface, stage = t.bg;
  const f = (fg, bg) => ratio(fg, bg).toFixed(2);
  console.log(`| ${name} | \`${shell}\` | \`${stage}\` | ${f(t.text, shell)} | ${f(t.text, stage)} | ${f(t["text-muted"], shell)} | ${f(t["text-muted"], stage)} | ${f(t["text-muted"], t["surface-raised"])} | ${f(t.accent, shell)} | ${f(t.accent, stage)} | ${f(t.danger, shell)} | ${f(t.danger, stage)} | ${f(t.line, shell)} | ${f(t.line, stage)} |`);
}
if (process.argv[2]) console.log(ratio(process.argv[2], process.argv[3]).toFixed(2));
