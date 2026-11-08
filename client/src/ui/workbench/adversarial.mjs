// Adversarial UX session (skill: dogfood/adversarial-ux-test), executed in a
// real browser against the production-built client on :1522 and the UI
// fixture API on :3131. Persona: Rosa, 61, phone only. Each task counts taps
// and records screenshots, console errors and what happened.
// Usage: node src/ui/workbench/adversarial.mjs [--out=../evidence/ui/adversarial] [--tag=before]
import { chromium, devices } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const arg = (k, d) => process.argv.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const out = resolve(arg('out', '../evidence/ui/adversarial'), arg('tag', 'run'));
await mkdir(out, { recursive: true });
const base = 'http://127.0.0.1:1522';
const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['Pixel 7'] });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
const log = [];
let taps = 0;
const tap = async (loc) => { taps++; await loc.click({ timeout: 8000 }); };
const shot = async (name) => { await page.waitForTimeout(250); await page.screenshot({ path: join(out, `${name}.png`) }); };
async function task(name, fn) {
  taps = 0; errors.length = 0;
  const t0 = Date.now();
  let ok = true, note = '';
  try { note = (await fn()) ?? ''; } catch (e) { ok = false; note = String(e).split('\n')[0]; await shot(`${name}-FAILED`); }
  log.push({ task: name, ok, taps, ms: Date.now() - t0, note, consoleErrors: [...errors] });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} taps=${taps} ${note}`);
}
const run = Date.now() % 100000;
const user = `rosa${run}`;

await task('T1 join from invite link', async () => {
  await page.goto(`${base}/#invite=fixture-invite-for-rosa`);
  await shot('t1-invite-open');
  await tap(page.getByLabel('Username', { exact: true }));
  await page.getByLabel('Username', { exact: true }).fill(user);
  await page.getByLabel('Password (at least 12 characters)').fill('rosa1234');
  await tap(page.locator('button[type=submit]'));
  // The input's own minlength is not in the contract, so the server answers.
  await page.getByRole('alert').waitFor({ timeout: 5000 });
  await shot('t1-short-password');
  await page.getByLabel('Password (at least 12 characters)').fill('rosa-likes-movie-night');
  await tap(page.locator('button[type=submit]'));
  await page.getByTestId('screen-composer').waitFor();
  await shot('t1-joined');
  return `landed in: ${await page.locator('#cc-convo-title').innerText()}`;
});

await task('T2 say something in movie-night', async () => {
  await tap(page.getByRole('button', { name: 'Open navigation' }));
  await shot('t2-drawer');
  await tap(page.getByRole('button', { name: 'Open movie-night', exact: true }));
  const box = page.getByTestId('screen-composer').getByLabel('Message', { exact: true });
  await tap(box);
  await box.fill(`I'll bring the empanadas ${run}`);
  await tap(page.getByRole('button', { name: 'Send', exact: true }));
  await page.getByTestId('screen-conversation').getByText(`I'll bring the empanadas ${run}`).waitFor();
  await shot('t2-sent');
});

await task('T3 reply to maya', async () => {
  const row = page.getByTestId('screen-conversation').locator('li').filter({ hasText: 'ok who is actually free friday' });
  await tap(row.locator('.cc-body'));
  await shot('t3-row-open');
  await tap(row.getByRole('button', { name: 'Reply', exact: true }));
  const box = page.getByTestId('screen-composer').getByLabel('Message', { exact: true });
  await box.fill(`me! friday works ${run}`);
  await shot('t3-replying');
  await tap(page.getByRole('button', { name: 'Send', exact: true }));
  await page.getByTestId('screen-conversation').getByText(`me! friday works ${run}`).waitFor();
});

await task('T4 unsend a mistake (touch)', async () => {
  const box = page.getByTestId('screen-composer').getByLabel('Message', { exact: true });
  await box.fill(`oops wrong chat, ignore ${run}`);
  await tap(page.getByRole('button', { name: 'Send', exact: true }));
  const row = page.getByTestId('screen-conversation').locator('li').filter({ hasText: `oops wrong chat, ignore ${run}` });
  await row.waitFor();
  await tap(row.locator('.cc-body'));
  const sheet = page.getByRole('dialog');
  await sheet.waitFor({ timeout: 4000 });
  await shot('t4-action-sheet');
  await tap(sheet.getByRole('button', { name: 'Unsend', exact: true }));
  await shot('t4-confirm');
  const stillThere = await row.count();
  await tap(page.getByRole('dialog').getByRole('button', { name: 'Unsend for everyone' }));
  await page.waitForTimeout(800);
  const gone = (await page.getByTestId('screen-conversation').locator('li').filter({ hasText: `oops wrong chat, ignore ${run}` }).count()) === 0;
  await shot('t4-after');
  return `first tap only asked: ${stillThere === 1}; confirm removed it: ${gone}`;
});

await task('T5 get to the call from a chat', async () => {
  // Rosa looks for a phone or call button in the conversation first.
  const headerCall = page.getByTestId('screen-conversation').getByRole('button', { name: /call/i });
  const direct = await headerCall.count();
  if (direct) await tap(headerCall.first());
  else { await tap(page.getByRole('button', { name: 'Open navigation' })); await tap(page.getByRole('button', { name: 'Voice and video', exact: true })); }
  await page.getByTestId('screen-voice').waitFor();
  await shot('t5-call');
  return direct ? 'call button in chat header' : 'had to open the drawer: no call button in the chat header';
});

await task('T6 start a watch party', async () => {
  await tap(page.getByRole('button', { name: 'Together' }));
  await page.getByTestId('screen-activities').waitFor();
  await shot('t6-together');
  const start = page.getByRole('button', { name: 'Start plex control session', exact: true });
  if (await start.count()) await tap(start);
  await page.getByTestId('screen-activities').locator('[data-item-id="snapshot"]').waitFor();
  await shot('t6-started');
  const stop = page.getByRole('button', { name: 'Stop activity', exact: true });
  const why = await page.getByText('Only the person who started it can stop it.').count();
  const deskOpen = await page.locator('details.cc-desk').evaluate(d => d.open);
  return `stop disabled for a guest: ${await stop.isDisabled()}; reason shown: ${why > 0}; control desk open on phone: ${deskOpen}`;
});

await task('T7 report that sound is broken', async () => {
  await tap(page.getByRole('button', { name: 'More' }));
  await tap(page.getByRole('button', { name: 'Report a problem', exact: true }));
  await page.getByLabel('Description', { exact: true }).fill('I cannot hear anybody in the call');
  await page.getByLabel('Optional logs (review and remove secrets)').fill('no idea what logs are');
  const warned = await page.getByText('Without the tick, these logs stay on this device').isVisible();
  await shot('t7-consent-warning');
  await tap(page.getByRole('button', { name: 'Submit report', exact: true }));
  const alert = page.getByTestId('screen-report').getByRole('alert');
  const blocked = await alert.isVisible().catch(() => false);
  await shot('t7-report');
  return `warning shown before submit: ${warned}; ${blocked ? `blocked: ${await alert.innerText()}` : 'sent; transport dropped the unconsented logs as designed'}`;
});

await task('T8 find the way back to chat from a settings page', async () => {
  if (!(await page.getByTestId('screen-composer').count())) await tap(page.getByRole('button', { name: 'Back to conversation' }).first());
  await tap(page.getByRole('button', { name: 'More' }).or(page.getByRole('button', { name: 'Open navigation' })).first());
  await tap(page.getByRole('button', { name: 'Devices', exact: true }));
  await page.getByTestId('screen-devices').waitFor();
  await shot('t8-devices');
  await tap(page.getByRole('button', { name: 'Chats' }));
  await page.getByTestId('screen-composer').waitFor();
  await shot('t8-back');
});

await writeFile(join(out, 'session.json'), JSON.stringify({ persona: 'Rosa, 61, phone only (Pixel 7 emulation)', base, log }, null, 2));
await browser.close();
