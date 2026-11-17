import { test as base, expect, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
// Unique per case/context, including each viewport project; fixture maps this to a
// trusted synthetic peer. Production limits and meaningful requests stay intact.
const fixtureState = () => ({ cookies: [{ name: '__Host-hosted-fixture', value: crypto.randomUUID(), domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Strict' as const }], origins: [] });
const test = base.extend({ storageState: async ({}, use) => { await use(fixtureState()); } });
const alpha = 'https://alpha.fixture.org:43186';
const beta = 'https://beta.fixture.org:43187';
const communityPassword = 'synthetic community password';
const accountPassword = 'synthetic account password';
const username = () => 'fixture_' + crypto.randomUUID().replaceAll('-', '').slice(0, 12);
async function account(page: Page, name: string, signup = true) {
  await page.goto('/#' + (signup ? 'signup' : 'login'));
  await page.getByLabel('Username', { exact: true }).fill(name);
  await page.getByLabel('Password', { exact: true }).fill(accountPassword);
  await page.getByRole('button', { name: signup ? 'Create account' : 'Log in', exact: true }).click();
  await expect(page.getByText('No servers yet', { exact: true })).toBeVisible();
}
async function direct(page: Page, origin: string, user = 'fixture_owner') {
  await page.goto('/#direct');
  await page.getByLabel('Server address', { exact: true }).fill(origin);
  await page.getByLabel('Username', { exact: true }).fill(user);
  await page.getByLabel('Password', { exact: true }).fill(communityPassword);
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page.getByTestId('screen-composer')).toBeVisible();
}
async function drawer(page: Page) {
  const menu = page.locator('[data-menu-button]');
  if (await menu.isVisible()) await menu.click();
}
async function settings(page: Page, section = 'HouseCall account') {
  if (await page.locator('.hc-hosted-home').isVisible()) { await page.getByRole('button', { name: 'HouseCall account', exact: true }).click(); return; }
  await drawer(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByTestId('screen-settings').getByRole('button', { name: section, exact: true }).click();
}
async function picker(page: Page) { await drawer(page); await page.locator('.hc-picker__trigger').click(); }
async function add(page: Page, origin: string, user = 'fixture_owner') {
  await picker(page); await page.getByRole('option', { name: 'Add server', exact: true }).click();
  await page.locator('.hc-picker__form input').fill(origin); await page.locator('.hc-picker__form button[type=submit]').click();
  const login = page.getByTestId('screen-sign-in');
  const name = login.getByLabel('Username', { exact: true }); if (await name.isVisible()) await name.fill(user);
  await login.getByLabel('Password', { exact: true }).fill(communityPassword); await login.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page.getByTestId('screen-composer')).toBeVisible();
}
async function closeSettings(page: Page) {
  const close = page.getByTestId('screen-settings').getByRole('button', { name: 'Close', exact: true });
  if (await close.isVisible()) await close.click();
  else { await page.getByTestId('screen-settings').locator('.hc-header button').click(); await page.getByTestId('screen-settings').locator('.hc-header button').click(); }
}

test('hosted root login modes, keyboard, 390px and visible errors', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/'); await expect(page.getByRole('heading', { name: 'Log in to HouseCall', exact: true })).toBeVisible();
  await page.getByLabel('Username', { exact: true }).fill('fixture_missing'); await page.keyboard.press('Enter');
  await expect(page.getByLabel('Password', { exact: true })).toBeFocused();
  await page.getByLabel('Password', { exact: true }).fill(accountPassword); await page.keyboard.press('Enter');
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByRole('button', { name: 'New here? Create an account', exact: true }).click();
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Username', { exact: true })).toHaveValue('fixture_missing');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  mkdirSync('hosted-evidence', { recursive: true });
  // Empty fields only: no credential-bearing traces/screenshots.
  await page.getByLabel('Username', { exact: true }).fill('');
  await page.screenshot({ path: `hosted-evidence/${info.project.name}-signup.png`, fullPage: true });
  await page.getByRole('button', { name: "Connect directly to a friend's server", exact: true }).click();
  await expect(page.getByRole('heading', { name: "Connect to a friend's server", exact: true })).toBeVisible();
  await page.screenshot({ path: `hosted-evidence/${info.project.name}-direct.png`, fullPage: true });
  expect(errors).toEqual([]);
});

test('direct-only survives real account outage; chat, image and RTC stay at community origin', async ({ page, request }, info) => {
  await page.addInitScript(() => {
    const Original = window.RTCPeerConnection; const peers: RTCPeerConnection[] = [];
    Object.assign(window, { hostedPeers: peers });
    window.RTCPeerConnection = class extends Original { constructor(config?: RTCConfiguration) { super(config); peers.push(this); } };
  });
  const destinations: { origin: string; path: string; auth: boolean }[] = [];
  page.on('request', req => { const url = new URL(req.url()); if (url.pathname.startsWith('/api/')) destinations.push({ origin: url.origin, path: url.pathname, auth: !!req.headers()['authorization'] }); });
  await request.post('/__fixture/accounts-down');
  try {
    await direct(page, alpha);
    await page.getByTestId('screen-composer').getByLabel('Message', { exact: true }).fill('Synthetic origin check');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('screen-conversation')).toContainText('Synthetic origin check');
    await page.locator('.hc-composer input[type=file]:not([capture])').setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64') });
    await expect(page.getByTestId('attached')).toBeVisible();
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => destinations.some(r => r.origin === alpha && r.path.startsWith('/api/media/'))).toBe(true);
    await page.reload(); await expect(page.getByTestId('screen-composer')).toBeVisible();
    await drawer(page); await page.getByRole('button', { name: 'Open Lounge', exact: true }).click();
    const join = page.getByRole('button', { name: 'Join voice', exact: true }); if (await join.isVisible()) await join.click();
    await expect(page.getByTestId('call-stage')).toHaveAttribute('data-phase', 'live', { timeout: 30000 });
    const camera = page.getByRole('button', { name: 'Camera on', exact: true }).first();
    await camera.click();
    await expect(page.getByRole('button', { name: 'Camera off', exact: true }).first()).toBeVisible();
    expect(destinations.filter(r => r.auth).every(r => r.origin === alpha)).toBe(true);
    expect(destinations.some(r => r.origin === alpha && r.path.endsWith('/voice/join'))).toBe(true);
    expect(destinations.some(r => r.origin === alpha && r.path === '/api/events')).toBe(true);
    expect(destinations.filter(r => r.path === '/api/login').map(r => r.origin)).toEqual([alpha]);
    const rtc = await page.evaluate(async () => {
      const peers = (window as unknown as { hostedPeers: RTCPeerConnection[] }).hostedPeers;
      const evidence = [];
      for (const peer of peers) { const stats = await peer.getStats(); const candidates: string[] = []; stats.forEach(report => { if (report.type === 'remote-candidate') candidates.push(report.address ?? report.ip); }); evidence.push({ connected: peer.connectionState === 'connected', candidates }); }
      return evidence;
    });
    expect(rtc.some(peer => peer.connected && peer.candidates.includes('127.0.0.1'))).toBe(true);
    mkdirSync('hosted-evidence', { recursive: true }); writeFileSync(`hosted-evidence/${info.project.name}-origins.json`, JSON.stringify({ requests: destinations, rtc }, null, 2));
  } finally { await request.post('/__fixture/accounts-up'); }
});

test('link after authentication, two communities, reload, fresh device auth and unlink keeps membership', async ({ page, browser }) => {
  const name = username(); await account(page, name);
  await page.getByRole('button', { name: 'Add server', exact: true }).click();
  await page.getByLabel('Server address', { exact: true }).fill(alpha);
  await page.getByLabel('Username', { exact: true }).fill('fixture_owner'); await page.getByLabel('Password', { exact: true }).fill(communityPassword);
  await page.getByRole('button', { name: 'Log in', exact: true }).click(); await expect(page.getByTestId('screen-composer')).toBeVisible();
  // First host login also saves only its address.
  await settings(page); await expect(page.locator('.hc-tiles')).toContainText('alpha.fixture.org'); await closeSettings(page);
  await page.getByTestId('screen-composer').getByLabel('Message', { exact: true }).fill('Synthetic alpha-only message'); await page.keyboard.press('Enter');
  await expect(page.getByTestId('screen-conversation')).toContainText('Synthetic alpha-only message');
  await add(page, beta, 'fixture_member');
  await expect(page.getByTestId('screen-conversation')).not.toContainText('Synthetic alpha-only message');
  await picker(page); await page.getByRole('option', { name: /Alpha fixture/ }).click();
  await expect(page.locator('.hc-picker__trigger')).toContainText('Alpha fixture');
  await page.reload(); await expect(page.getByTestId('screen-composer')).toBeVisible();
  const encrypted = await page.evaluate(async () => (await fetch('/api/account/vault', { headers: { 'X-HouseCall': '1' } })).json());
  expect(JSON.stringify(encrypted)).not.toContain('fixture.org'); expect(JSON.stringify(encrypted)).not.toContain(communityPassword);
  const fresh = await browser.newContext({ ignoreHTTPSErrors: true, storageState: fixtureState() }); const other = await fresh.newPage();
  try {
    await account(other, name, false); await picker(other); await expect(other.getByRole('option', { name: /alpha.fixture.org.*Log in needed/ })).toBeVisible();
    await other.getByRole('option', { name: /alpha.fixture.org.*Log in needed/ }).click(); await expect(other.getByTestId('screen-sign-in')).toBeVisible();
    await other.getByLabel('Username', { exact: true }).fill('fixture_owner'); await other.getByLabel('Password', { exact: true }).fill(communityPassword); await other.getByRole('button', { name: 'Log in', exact: true }).click();
    await expect(other.getByTestId('screen-composer')).toBeVisible(); await settings(other);
    const row = other.locator('.hc-tile-row').filter({ hasText: 'alpha.fixture.org' }); await row.getByRole('button', { name: 'Remove', exact: true }).click(); await row.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(other.locator('.hc-tiles')).not.toContainText('alpha.fixture.org'); await closeSettings(other); await expect(other.getByTestId('screen-composer')).toBeVisible();
  } finally { await fresh.close(); }
});

test('two-tab guest promotion, reload, non-overwriting CAS and explicit logout clears device keys', async ({ page, context }) => {
  await direct(page, alpha);
  // Open the other guest before promotion so the BroadcastChannel change is exercised.
  const tab = await context.newPage(); await tab.goto('/'); await expect(tab.getByTestId('screen-composer')).toBeVisible();
  await settings(page); await page.getByRole('button', { name: 'Create an account', exact: true }).click();
  const name = username(); await page.getByLabel('Username', { exact: true }).fill(name); await page.getByLabel('Password', { exact: true }).fill(accountPassword); await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save this server', exact: true })).toBeVisible(); await page.getByRole('button', { name: 'Save this server', exact: true }).click();
  await expect(page.locator('.hc-tiles')).toContainText('alpha.fixture.org');
  await expect(tab.getByTestId('screen-composer')).toBeVisible();
  await settings(tab); await expect(tab.getByText(`Username: ${name}`, { exact: true })).toBeVisible(); await closeSettings(tab);
  // Both tabs must retain the same persistent community login after the change.
  for (const target of [page, tab]) { await target.reload(); await expect(target.getByTestId('screen-composer')).toBeVisible(); }
  // Two independent Account instances exercise the actual account client and CAS, no fake crypto.
  const cas = await page.evaluate(async () => {
    const { Account } = await import(/* @vite-ignore */ '/__fixture/modules/account-client.mjs');
    const first = new Account(), second = new Account(); await first.restore(); await second.restore();
    await first.save({ format: 1, servers: [...first.list!.servers, 'https://cas.fixture.org/'] });
    try { await second.save({ format: 1, servers: [] }); return false; } catch { return true; }
  }); expect(cas).toBe(true);
  await settings(tab); await tab.getByRole('button', { name: 'Log out of HouseCall', exact: true }).click(); await tab.getByRole('button', { name: 'Log out', exact: true }).click();
  for (const target of [page, tab]) await expect(target.getByRole('heading', { name: 'Log in to HouseCall', exact: true })).toBeVisible();
  await page.reload(); await expect(page.getByRole('heading', { name: 'Log in to HouseCall', exact: true })).toBeVisible();
  await tab.close();
});

test('stale central writes and delete fail closed without deleting the replacement device key', async ({ page }) => {
  await account(page, username());
  // Change the shared account cookie while an older runtime still holds its old key.
  const binding = await page.evaluate(async ({ name, password }) => {
    const path = '/__fixture/modules/account-client.mjs'; const { Account } = await import(/* @vite-ignore */ path);
    const old = new Account(); await old.restore(); const replacement = new Account(); await replacement.authenticate(name, password, true); await replacement.remember();
    let refused = false; try { await old.save({ format: 1, servers: [] }); } catch (e) { refused = (e as { code?: string }).code === 'account_changed'; }
    let deleteRefused = false; try { await old.delete(); } catch (e) { deleteRefused = (e as { code?: string }).code === 'account_changed'; }
    await old.forgetDevice(); const restored = new Account(); return { refused, deleteRefused, retained: await restored.restore(), count: restored.list.servers.length };
  }, { name: username(), password: accountPassword });
  expect(binding).toEqual({ refused: true, deleteRefused: true, retained: true, count: 0 });
});

test('owner opt-in, search with no server probes, non-owner denied and unpublish', async ({ page, request }) => {
  await direct(page, alpha); await settings(page, 'Server profile');
  await page.getByLabel('Public description', { exact: true }).fill('Synthetic directory acceptance');
  const toggle = page.getByRole('switch', { name: 'List this server publicly', exact: true }); await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click(); await page.getByRole('button', { name: 'Publish', exact: true }).click(); await expect(page.getByText('Listed publicly', { exact: true })).toBeVisible();
  const response = await request.get('/api/directory?q=Synthetic%20directory&offset=0'); expect(response.ok()).toBe(true); expect((await response.json()).listings.map((r: { origin: string }) => r.origin)).toContain(alpha);
  await closeSettings(page); await picker(page); await page.getByRole('option', { name: 'Discover servers', exact: true }).click();
  const probes: string[] = []; page.on('request', r => { if ([alpha, beta].includes(new URL(r.url()).origin) && new URL(r.url()).pathname === '/api/instance') probes.push(new URL(r.url()).origin); });
  await page.getByLabel('Search public servers', { exact: true }).fill('Synthetic directory'); await expect(page.locator('.hc-tile-row')).toContainText('Alpha fixture'); expect(probes).toEqual([]);
  await page.getByRole('button', { name: 'Back', exact: true }).click(); await settings(page, 'Server profile'); await toggle.click(); await expect(toggle).toHaveAttribute('aria-checked', 'false');
  expect((await (await request.get('/api/directory?q=Synthetic%20directory&offset=0')).json()).listings).toEqual([]);
  // A separate member browser has no owner switch; server authorization is independently asserted.
  const member = await page.context().browser()!.newContext({ ignoreHTTPSErrors: true, storageState: fixtureState() }); const memberPage = await member.newPage();
  try { await direct(memberPage, beta, 'fixture_member'); await settings(memberPage); await expect(memberPage.getByRole('switch', { name: 'List this server publicly' })).toHaveCount(0); }
  finally { await member.close(); }
});
