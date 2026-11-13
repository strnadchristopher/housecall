// Screenshots every mockup in this folder: 1280x800 and 390x844, dark and light, into ./shots/.
// file:// only: no server, no ports. Chromium comes from client/node_modules (run `npm ci` in client first).
//
//   node design/040/shoot.mjs                 every mockup, every state
//   node design/040/shoot.mjs sidebar stage   only files whose name contains one of these words
//   node design/040/shoot.mjs --only=1280-dark sidebar
//
// A mockup lists its states in <meta name="hc-states" content="default,alone">; each is loaded as ?s=<state>.
// A state named t<ms> (for example t400) is shot with motion on and every animation paused at that time;
// everything else is shot with reduced motion, which is the resting state of the design.
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { chromium } = createRequire(join(here, "../../client/package.json"))("playwright");

const args = process.argv.slice(2);
const only = args.find(arg => arg.startsWith("--only="))?.slice(7);
const words = args.filter(arg => !arg.startsWith("--"));
const files = readdirSync(here).filter(name => name.endsWith(".html") && (!words.length || words.some(word => name.includes(word)))).sort();
const sizes = [{ name: "1280", width: 1280, height: 800 }, { name: "390", width: 390, height: 844, touch: true }];
const schemes = ["dark", "light"];
const out = join(here, "shots");
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
let count = 0;
const problems = [];
for (const size of sizes) {
  for (const scheme of schemes) {
    if (only && only !== `${size.name}-${scheme}`) continue;
    for (const motion of ["reduce", "no-preference"]) {
      const context = await browser.newContext({
        viewport: { width: size.width, height: size.height }, deviceScaleFactor: 1, colorScheme: scheme, reducedMotion: motion,
        hasTouch: !!size.touch, isMobile: !!size.touch,
      });
      const page = await context.newPage();
      page.on("console", message => { if (message.type() === "error") problems.push(`${message.text()}`); });
      page.on("pageerror", error => problems.push(String(error)));
      for (const file of files) {
        const html = readFileSync(join(here, file), "utf8");
        const states = (html.match(/<meta name="hc-states" content="([^"]*)"/)?.[1] ?? "default").split(",").map(state => state.trim()).filter(Boolean);
        for (const state of states) {
          const timed = /^t\d+$/.test(state);
          if (timed !== (motion === "no-preference")) continue;
          // A standalone page (no mock.js, such as link.html) may name a #fragment for its default state.
          const fragment = state === "default" ? html.match(/<meta name="hc-hash" content="([^"]*)"/)?.[1] : undefined;
          const url = pathToFileURL(join(here, file)).href + (state === "default" ? "" : `?s=${state}`) + (fragment ? `#${fragment}` : "");
          await page.goto("about:blank"); // a change of #fragment alone would not reload the page
          await page.goto(url);
          if (html.includes("mock.js")) await page.waitForSelector("html[data-ready]");
          await page.evaluate(() => document.fonts.ready);
          if (timed) {
            await page.evaluate(ms => { for (const animation of document.getAnimations()) { animation.pause(); animation.currentTime = ms; } }, Number(state.slice(1)));
          }
          await page.waitForTimeout(60);
          const name = `${file.replace(/\.html$/, "")}${state === "default" ? "" : `-${state}`}-${size.name}-${scheme}.png`;
          await page.screenshot({ path: join(out, name) });
          count++;
        }
      }
      await context.close();
    }
  }
}
await browser.close();
console.log(`${count} screenshots in ${out}`);
if (problems.length) { console.log("page problems:"); for (const line of new Set(problems)) console.log("  " + line); process.exitCode = 1; }
