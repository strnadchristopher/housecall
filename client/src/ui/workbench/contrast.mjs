// WCAG 2.x contrast audit of the theme tokens (client/src/ui/tokens/themes.ts).
// Usage: node src/ui/workbench/contrast.mjs > ../evidence/ui/contrast.txt
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../tokens/themes.ts', import.meta.url), 'utf8');
const themes = {};
for (const m of src.matchAll(/(\w+): \{\s*id: '(\w+)'[\s\S]*?tokens: \{([\s\S]*?)\n    \}/g)) {
  const t = {};
  for (const kv of m[3].matchAll(/(\w+): '(#[0-9a-f]{6})'/gi)) t[kv[1]] = kv[2];
  themes[m[2]] = t;
}
const lum = hex => { const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const pairs = [
  ['ink', 'surface1', 4.5], ['ink2', 'surface1', 4.5], ['ink3', 'surface1', 4.5], ['ink', 'surface0', 4.5], ['ink3', 'surface0', 4.5],
  ['ink2', 'surface2', 4.5], ['ink3', 'surface2', 3], ['accent', 'surface1', 4.5], ['accent', 'surface0', 4.5], ['accentInk', 'accentFill', 4.5],
  ['danger', 'surface1', 4.5], ['ok', 'surface1', 3], ['warn', 'surface1', 3], ['bg', 'danger', 4.5],
];
let fails = 0;
for (const [id, t] of Object.entries(themes)) {
  console.log(`\n${id}`);
  for (const [fg, bg, min] of pairs) {
    if (!t[fg] || !t[bg]) continue;
    const r = ratio(t[fg], t[bg]);
    const ok = r >= min;
    if (!ok) fails++;
    console.log(`  ${ok ? 'pass' : 'FAIL'} ${fg} on ${bg}: ${r.toFixed(2)} (min ${min})`);
  }
}
console.log(`\n${fails} failing pairs`);
