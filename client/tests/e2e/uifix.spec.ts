import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fillSignIn, logInButton, password, setupToken, openMenu } from './helpers';
import { homedir } from 'node:os';
import { join } from 'node:path';
const evidence = join(homedir(), '.local/state/housecall-takeover-20261113/uifix-evidence');
test.use({ actionTimeout: 10_000 });
const prefix = process.env.HOUSECALL_UIFIX_BEFORE === '1' ? 'before' : 'after';
const headers = (a: any) => ({ Authorization: `Bearer ${a.token}`, 'X-Device-Key': a.device_key });
let owner: any;
test.beforeAll(async ({ request }) => {
  await mkdir(evidence, { recursive: true });
  const response = await request.post('/api/setup', { data: { username: 'ui_owner', password, setup_token: setupToken, device_name: 'fixture' } });
  owner = await (response.ok() ? response : await request.post('/api/login', { data: { username: 'ui_owner', password, device_name: 'fixture retry' } })).json();
});
async function native(context: BrowserContext) {
  await context.addInitScript(() => {
    const records = new Map<string, unknown>();
    Object.assign(window, { __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, any> = {}) => {
      if (command.endsWith('|identity_get')) return { identity: records.get('identity') };
      if (command.endsWith('|identity_set')) { records.set('identity', args.identity); return { ok: true }; }
      if (command.endsWith('|bindings_get')) return { bindings: [] };
      if (command.endsWith('|pins_get')) return { pins: [] };
      if (command.endsWith('|list')) return { origins: [] };
      if (/\|(set|remove|bindings_set|pins_set|sensitive_surface)$/.test(command)) return { ok: true };
      if (command === 'native_push') return { supported: false };
      if (command === 'native_auth') return args.action === 'status' ? { platform: 'desktop' } : {};
      if (command === 'scheme_invite_take') return {};
      throw new Error('Fixture command unavailable');
    } } });
  });
}
async function shot(page: Page, name: string) {
  await page.evaluate(async () => {
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    await Promise.all(document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})));
  });
  await page.screenshot({ path: `${evidence}/${prefix}-${name}.png`, mask: [page.locator('.hc-words')] });
}
for (const [width, height] of [[390, 844], [430, 932], [1280, 800]]) test(`native bootstrap stays open through words ${width}`, async ({ browser, request }) => {
  const invite = await (await request.post('/api/invites', { headers: headers(owner), data: {} })).json();
  const name = randomUUID().replace(/-/g, '');
  expect((await request.post('/api/invites/accept', { data: { token: invite.token, username: name, password, device_name: 'fixture' } })).ok()).toBe(true);
  const context = await browser.newContext({ viewport: { width, height }, isMobile: width < 768, hasTouch: width < 768 }); await native(context);
  const page = await context.newPage(); await page.goto('/'); await fillSignIn(page, name);
  await page.getByLabel('Server address', { exact: true }).fill('http://localhost:1420');
  await logInButton(page).click(); const flow = page.getByTestId('security-flow');
  if (width < 768) await page.addStyleTag({ content: ':root { --hc-safe-top: 47px; --hc-safe-bottom: 34px; }' });
  await expect(flow).toContainText('One new thing'); await shot(page, `recovery-${width}`);
  await expect(flow.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
  await expect(flow.getByRole('button', { name: 'Back', exact: true })).toHaveCount(0);
  expect(await flow.evaluate(e => e.getBoundingClientRect().width)).toBe(width);
  const centered = await flow.evaluate(element => { const box = element.getBoundingClientRect(), title = element.querySelector('h1')!.getBoundingClientRect(), button = element.querySelector('.hc-btn')!.getBoundingClientRect(); return { x: title.x + title.width / 2 - (box.x + box.width / 2), y: (title.y + button.bottom) / 2 - (box.y + box.height / 2) }; });
  expect(Math.abs(centered.x)).toBeLessThanOrEqual(1); expect(Math.abs(centered.y)).toBeLessThanOrEqual(24);
  await flow.getByRole('button', { name: 'How security works', exact: true }).click();
  await expect(flow.locator('.hc-slide')).toBeVisible();
  for (let i = 0; i < 2; i++) await flow.getByRole('button', { name: 'Next', exact: true }).click();
  await flow.getByRole('button', { name: 'Show my recovery key', exact: true }).click();
  await expect(flow.locator('.hc-words li')).toHaveCount(24); await shot(page, `recovery-words-${width}`);
  const words = await flow.locator('.hc-words li').allTextContents();
  await flow.getByRole('button', { name: "I've written them down", exact: true }).click();
  const fields = flow.locator('input');
  for (let i = 0; i < 2; i++) {
    const label = await fields.nth(i).evaluate(e => (e as HTMLInputElement).labels![0].innerText);
    await fields.nth(i).fill(words[Number(label.match(/\d+/)![0]) - 1]);
  }
  await flow.getByRole('button', { name: 'Finish', exact: true }).click();
  await expect(flow).toHaveCount(0); await expect(page.getByTestId('screen-composer')).toBeVisible();
  await context.close();
});

test('web reload restores sealed session; logout and server revocation remove it', async ({ page, request }) => {
  await page.goto('/'); await fillSignIn(page, 'ui_owner'); await logInButton(page).click();
  await expect(page.getByTestId('screen-composer')).toBeVisible();
  await page.reload(); await expect(page.getByTestId('screen-composer')).toBeVisible();
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  const stored = () => page.evaluate(async () => {
    const { webSession } = await import('/src/transport/webSession.ts' as string); return webSession.list();
  });
  expect(await stored()).toHaveLength(1);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByTestId('screen-settings').getByRole('button', { name: 'Profile', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByTestId('screen-welcome').or(page.getByTestId('screen-sign-in'))).toBeVisible();
  expect(await stored()).toHaveLength(0); await page.reload();
  await fillSignIn(page, 'ui_owner');
  const login = page.waitForResponse(r => new URL(r.url()).pathname === '/api/login' && r.request().method() === 'POST');
  await logInButton(page).click(); const auth = await (await login).json();
  await expect(page.getByTestId('screen-composer')).toBeVisible();
  const me = await (await request.get('/api/me', { headers: headers(auth) })).json();
  expect((await request.delete(`/api/devices/${me.session_id}`, { headers: headers(owner) })).ok()).toBe(true);
  await page.reload(); await expect(page.getByTestId('screen-welcome').or(page.getByTestId('screen-sign-in'))).toBeVisible();
  expect(await stored()).toHaveLength(0); await page.reload();
  await expect(page.getByTestId('screen-welcome').or(page.getByTestId('screen-sign-in'))).toBeVisible();
});

test('hostile message widths stay inside chat on phones', async ({ page, request }) => {
  const channels = (await (await request.get('/api/channels', { headers: headers(owner) })).json()).channels;
  const channel = channels.find((c: any) => c.kind === 'channel');
  const bodies = ['x'.repeat(300), 'https://example.com/' + 'longpath'.repeat(45), '```\n' + 'code'.repeat(100) + '\n```', '| ' + Array(20).fill('wide column').join(' | ') + ' |\n| ' + Array(20).fill('---').join(' | ') + ' |\n| ' + Array(20).fill('table value').join(' | ') + ' |'];
  let reactionMessage = '';
  for (const body of bodies) {
    const response = await request.post(`/api/channels/${channel.id}/messages`, { headers: headers(owner), data: { body } });
    expect(response.ok()).toBe(true); reactionMessage = (await response.json()).id;
  }
  for (const emoji of ['😀', '👍', '❤️', '🎉', '🔥', '👀', '✅', '💯', '🤔', '👏', '🚀', '🙂'])
    expect((await request.post(`/api/messages/${reactionMessage}/reactions`, { headers: headers(owner), data: { emoji } })).ok()).toBe(true);
  await page.goto('/'); await fillSignIn(page, 'ui_owner'); await logInButton(page).click(); await expect(page.getByTestId('screen-composer')).toBeVisible();
  const png = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 1600; canvas.height = 900; const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#718175'; ctx.fillRect(0, 0, 1600, 900); return canvas.toDataURL('image/png').split(',')[1]; });
  await page.getByTestId('screen-composer').locator('input[type="file"]').setInputFiles({ name: 'wide-fixture.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await expect(page.getByTestId('attached')).toBeVisible();
  await page.getByTestId('screen-composer').getByLabel('Message', { exact: true }).fill('wide image fixture');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('.hc-media img')).toBeVisible();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.locator('.hc-messages pre').scrollIntoViewIfNeeded(); await shot(page, `overflow-${width}`);
    const metrics = await page.evaluate(() => [document.documentElement, document.querySelector('.hc-messages')!].map(e => ({ width: e.clientWidth, scroll: e.scrollWidth })));
    console.log('chat/document widths', width, metrics);
    for (const m of metrics) expect(m.scroll).toBeLessThanOrEqual(m.width + 1);
    expect(await page.locator('.hc-messages pre').evaluate(e => e.scrollWidth > e.clientWidth)).toBe(true);
  }
});

test('phone headers omit channel/group lock labels but keep the DM details target', async ({ browser, request }) => {
  const peers = [];
  for (let i = 0; i < 2; i++) {
    const invite = await (await request.post('/api/invites', { headers: headers(owner), data: {} })).json();
    const response = await request.post('/api/invites/accept', { data: { token: invite.token, username: randomUUID().replace(/-/g, ''), password, device_name: 'fixture peer' } });
    expect(response.ok()).toBe(true); peers.push((await response.json()).user.id);
  }
  for (const [kind, member_ids, name] of [['group_dm', peers, 'Header group fixture'], ['dm', peers.slice(0, 1), 'Header pair fixture']] as const)
    expect((await request.post('/api/channels', { headers: headers(owner), data: { kind, member_ids, name } })).ok()).toBe(true);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage(); await page.goto('/'); await fillSignIn(page, 'ui_owner'); await logInButton(page).click();
  await expect(page.getByTestId('screen-composer')).toBeVisible();
  await expect(page.locator('.hc-header .hc-lockline')).toHaveCount(0); await shot(page, 'header-channel');
  for (const name of ['Header group fixture', 'Header pair fixture']) {
    await openMenu(page);
    if (!(await page.getByTestId('screen-direct-messages').isVisible())) await page.getByRole('button', { name: 'Direct messages', exact: true }).click();
    await page.getByRole('button', { name: `Open ${name}`, exact: true }).click();
    await expect(page.locator('.hc-header h1')).toHaveText(name);
    await shot(page, name.includes('group') ? 'header-group' : 'header-dm');
    if (name.includes('group')) await expect(page.locator('.hc-header .hc-lockline')).toHaveCount(0);
    else {
      await page.locator('.hc-header .hc-lockline').click();
      await expect(page.getByTestId('dm-security-details')).toBeVisible();
      await page.getByTestId('dm-security-details').getByRole('button', { name: 'Done', exact: true }).click();
      await expect(page.getByTestId('dm-security-details')).toHaveCount(0);
    }
  }
  await context.close();
});

test('device notice slides out while its allocated height collapses; auto expiry and reduced motion leave no gap', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/'); await fillSignIn(page, 'ui_owner'); await logInButton(page).click();
  await expect(page.getByTestId('screen-composer')).toBeVisible();
  await page.evaluate(() => document.documentElement.style.setProperty('--hc-safe-top', '24px'));
  await expect(page.getByTestId('device-notice')).toHaveCount(0, { timeout: 10000 });
  const loginDevice = async (device_name: string) => { expect((await request.post('/api/login', { data: { username: 'ui_owner', password, device_name } })).ok()).toBe(true); };
  await loginDevice('UI notice fixture'); const notice = page.getByTestId('device-notice');
  await expect(notice).toContainText('UI notice fixture');
  expect(await notice.evaluate(e => getComputedStyle(e).animationName)).toBe('hc-notice-in');
  await notice.evaluate(async e => { await Promise.all(e.getAnimations().map(a => a.finished)); });
  await shot(page, 'device-notice');
  const initialHeight = await page.locator('.hc-notices').evaluate(e => e.getBoundingClientRect().height);
  await page.evaluate(() => {
    const samples: number[] = []; Object.assign(window, { noticeHeightSamples: samples });
    const start = performance.now(); const sample = () => { samples.push(document.querySelector('.hc-notices')!.getBoundingClientRect().height); if (performance.now() - start < 500) requestAnimationFrame(sample); }; requestAnimationFrame(sample);
  });
  await notice.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(notice).toHaveCount(0);
  await expect.poll(() => page.locator('.hc-notices').evaluate(e => e.getBoundingClientRect().height)).toBe(0);
  const samples = await page.evaluate(() => (window as any).noticeHeightSamples as number[]);
  expect(samples.some(h => h > 0 && h < initialHeight - 1)).toBe(true);
  expect(await page.locator('.hc-shell').evaluate(e => e.getBoundingClientRect().y)).toBe(0);
  expect(await page.evaluate(() => document.body.style.getPropertyValue('--hc-notices-height'))).toBe('0px');
  await shot(page, 'device-notice-dismissed');
  await loginDevice('UI auto expiry fixture'); await expect(notice).toContainText('UI auto expiry fixture');
  await expect(notice).toHaveCount(0, { timeout: 10000 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await loginDevice('UI reduced motion fixture'); await expect(notice).toContainText('UI reduced motion fixture');
  expect(await notice.evaluate(e => getComputedStyle(e).animationName)).toBe('none');
  await notice.getByRole('button', { name: 'Dismiss', exact: true }).click(); await expect(notice).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.body.style.getPropertyValue('--hc-notices-height'))).toBe('0px');
});

test('concurrent first writes share one non-extractable browser wrapping key', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { webSession } = await import('/src/transport/webSession.ts' as string);
    const fixture = { token: 'synthetic-token', device_key: 'synthetic-device-key', username: 'fixture', expires_at: Date.now() + 60000 };
    const origins = ['https://fixture-one.invalid', 'https://fixture-two.invalid'];
    const writes = await Promise.all(origins.map(origin => webSession.set(origin, fixture)));
    const reads = await Promise.all(origins.map(origin => webSession.get(origin)));
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('housecall-session', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const key = await new Promise<CryptoKey>((resolve, reject) => { const r = db.transaction('kv').objectStore('kv').get('wrap-key'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); db.close();
    await Promise.all(origins.map(origin => webSession.remove(origin)));
    return { writes, match: reads.every(value => value?.token === fixture.token), extractable: key.extractable, algorithm: key.algorithm.name };
  });
  expect(result).toEqual({ writes: [true, true], match: true, extractable: false, algorithm: 'AES-GCM' });
});
