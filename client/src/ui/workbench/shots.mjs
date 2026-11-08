// Screenshot runner for the UI workbench (fixture props, not a live backend).
// Usage: node src/ui/workbench/shots.mjs [--themes=basalt,moss] [--scenes=all|key|a,b] [--viewports=desktop,mobile] [--out=DIR]
// Expects the workbench dev server on http://127.0.0.1:1520 (npx vite --config src/ui/workbench/vite.config.ts).
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const arg = (k, d) => process.argv.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const base = arg('base', 'http://127.0.0.1:1520/');
const out = resolve(arg('out', '../evidence/ui/screens'));
const themes = arg('themes', 'basalt').split(',');
const viewports = arg('viewports', 'desktop,mobile').split(',');
const VIEW = {
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  mobile: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const log = [];
try {
  const probe = await browser.newPage();
  await probe.goto(base);
  const all = await probe.evaluate(() => Array.from(document.querySelectorAll('li a')).map(a => new URL(a.href).searchParams.get('scene')).filter(Boolean));
  await probe.close();
  const want = arg('scenes', 'all');
  const key = ['login', 'invite', 'chat', 'chat-mention', 'voice-live', 'activity-plex', 'activity-dj', 'plex', 'uploads-progress', 'settings', 'report', 'devices'];
  const scenes = want === 'all' ? all : want === 'key' ? key : want.split(',');
  for (const theme of themes) for (const vp of viewports) {
    const ctx = await browser.newContext({ ...VIEW[vp], colorScheme: 'dark', reducedMotion: 'no-preference' });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    const dir = join(out, theme, vp);
    await mkdir(dir, { recursive: true });
    for (const scene of scenes) {
      errors.length = 0;
      await page.goto(`${base}?scene=${scene}&theme=${theme}`);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(700);
      const file = join(dir, `${scene}.png`);
      await page.screenshot({ path: file });
      log.push({ theme, viewport: vp, scene, file, errors: [...errors] });
      process.stdout.write(`${theme}/${vp}/${scene}${errors.length ? ` ERRORS ${errors.length}` : ''}\n`);
    }
    await ctx.close();
  }
} finally {
  await browser.close();
}
await writeFile(join(out, `shots-${Date.now()}.json`), JSON.stringify(log, null, 2));
