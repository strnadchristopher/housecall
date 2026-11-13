// Review aid: puts several screenshots from ./shots side by side in one picture.
//   node design/040/sheet.mjs <out.png> <shot> <shot> ...     (shot = file name in ./shots, without .png)
// Nothing here is a deliverable; the output path is yours to choose (keep it out of git).
import { createRequire } from "node:module";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { chromium } = createRequire(join(here, "../../client/package.json"))("playwright");
const [out, ...shots] = process.argv.slice(2);
const html = `<body style="margin:0;background:#777;display:flex;gap:10px;padding:10px;align-items:flex-start;width:max-content">${
  shots.map(name => `<figure style="margin:0;font:11px sans-serif;color:#fff"><img src="${pathToFileURL(join(here, "shots", name + ".png")).href}" style="display:block"><figcaption>${name}</figcaption></figure>`).join("")}</body>`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
writeFileSync(out + ".html", html); // file:// pictures only load from a file:// page
await page.goto(pathToFileURL(resolve(out + ".html")).href);
await page.waitForLoadState("load");
rmSync(out + ".html");
await page.screenshot({ path: out, fullPage: true });
await browser.close();
console.log(out);
