// Renders every sound of sounds.js offline in headless Chromium and prints its peak and length, so the
// "never above 0.12" rule of HC-040 section 14 is measured, not hoped for. No server, no ports, no audio device.
//   node design/040/sounds-check.mjs
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { chromium } = createRequire(join(here, "../../client/package.json"))("playwright");
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(pathToFileURL(join(here, "sounds.html")).href);
const rows = await page.evaluate(async () => {
  const out = [];
  for (const name of Object.keys(window.HC_SOUNDS)) {
    const ctx = new OfflineAudioContext(1, 48000 * 2, 48000);
    const length = window.hcPlay(ctx, name, 0);
    const data = (await ctx.startRendering()).getChannelData(0);
    let peak = 0;
    for (const v of data) peak = Math.max(peak, Math.abs(v));
    out.push({ name, ms: Math.round(length * 1000), peak: Number(peak.toFixed(3)) });
  }
  return out;
});
await browser.close();
let bad = 0;
for (const row of rows) {
  const ok = row.peak <= 0.12 && row.peak > 0.02;
  if (!ok) bad++;
  console.log(`${ok ? "ok " : "BAD"} ${row.name.padEnd(13)} ${String(row.ms).padStart(5)} ms  peak ${row.peak}`);
}
process.exitCode = bad ? 1 : 0;
