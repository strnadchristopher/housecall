import { test, expect } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
const server = 'https://localhost:43182/';
const username = () => 'browser_' + randomBytes(6).toString('hex');
const password = () => randomBytes(24).toString('base64url');
async function auth(page, name, pw, signup = false) {
  await page.locator('#account-tab').click();
  await page.getByLabel('HouseCall username', { exact: true }).fill(name);
  await page.getByLabel('HouseCall password', { exact: true }).fill(pw);
  await page.getByRole('button', { name: signup ? 'Create an account' : 'Log in', exact: true }).click();
}
test('actual browser signup/login/encrypted list, reload lock, export and logout', async ({ page, context }) => {
  const name = username(), pw = password();
  await page.goto('/app/'); await auth(page, name, pw, true);
  await expect(page.getByLabel('Server address to remember')).toBeVisible();
  await page.getByLabel('Server address to remember').fill(server);
  await page.getByRole('button', { name: 'Save address', exact: true }).click();
  await expect(page.locator('#servers')).toContainText(server);
  const encrypted = await page.evaluate(async () => {
    const response = await fetch('/api/account/vault', { headers: { 'X-HouseCall': '1' } }); return response.json();
  });
  const cookie = (await context.cookies()).find(value => value.name === '__Host-hc');
  expect(cookie !== undefined).toBe(true);
  expect({ secure: cookie.secure, httpOnly: cookie.httpOnly, sameSite: cookie.sameSite, path: cookie.path }).toEqual({ secure: true, httpOnly: true, sameSite: 'Strict', path: '/' });
  expect(await page.evaluate(() => document.cookie)).not.toContain('__Host-hc');
  expect(encrypted.revision).toBe(1); expect(encrypted.envelope.format).toBe(1);
  expect(JSON.stringify(encrypted)).not.toContain('43182');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download server list' }).click();
  expect((await download).suggestedFilename()).toBe('housecall-servers.json');
  await page.reload(); await expect(page.locator('#auth-form')).toBeVisible();
  await auth(page, name, password()); await expect(page.locator('#account-status')).toContainText('Incorrect');
  await auth(page, name, pw); await expect(page.locator('#servers')).toContainText(server);
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(page.locator('#auth-form')).toBeVisible();
  expect(await page.evaluate(async () => (await fetch('/api/account/vault', { headers: { 'X-HouseCall': '1' } })).status)).toBe(401);
  await auth(page, name, pw);
  await page.getByRole('button', { name: 'Lock and log in again' }).click();
  await expect(page.locator('#auth-form')).toBeVisible();
  await auth(page, name, pw);
  await page.getByRole('button', { name: 'Remove ' + server, exact: true }).click();
  await expect(page.locator('#servers li')).toHaveCount(0);
  await page.getByText('Delete HouseCall account', { exact: true }).click();
  await page.getByLabel('Type DELETE to confirm').fill('DELETE');
  await page.getByRole('button', { name: 'Delete account and saved list', exact: true }).click();
  await expect(page.locator('#account-status')).toContainText('account and saved list deleted');
  await auth(page, name, pw);
  await expect(page.locator('#account-status')).toContainText('Incorrect');
});
test('direct HTTPS path survives real account-service outage and sends no referrer', async ({ page, context }) => {
  await page.goto('/app/');
  // Shut down API access at the network layer; no fake auth response is supplied.
  await context.setOffline(true);
  await page.locator('#account-tab').click();
  await page.getByRole('button', { name: 'Check service again' }).click();
  await expect(page.locator('#account-status')).toContainText('Account service unavailable');
  await page.locator('#direct-tab').click();
  await page.getByLabel('Your server’s address').fill(server);
  await page.getByRole('button', { name: 'Review destination' }).click();
  await expect(page.locator('#destination-text')).toHaveText(server);
  await context.setOffline(false);
  await page.getByRole('link', { name: 'Continue to this server' }).click();
  await expect(page).toHaveURL(server); await expect(page.getByRole('heading')).toHaveText('Server-local login fixture');
});
test('accessible mobile and keyboard path; screenshots contain no account secrets', async ({ page }) => {
  const pageErrors = [], external = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('request', request => { if (new URL(request.url()).origin !== 'https://127.0.0.1:43181') external.push(request.url()); });
  await page.emulateMedia({ reducedMotion: 'reduce' }); await page.goto('/app/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Portal source', exact: true })).toHaveAttribute('href', '/source/housecall-public-source.tar.gz');
  await expect(page.getByRole('link', { name: 'Privacy', exact: true })).toHaveAttribute('href', '/privacy');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const sizes = await page.locator('button:visible, input:visible, header a, footer a').evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().height));
  expect(sizes.every(height => height >= 44)).toBe(true);
  await page.getByLabel('Your server’s address').focus(); await page.keyboard.type(server); await page.keyboard.press('Tab'); await page.keyboard.press('Enter');
  await expect(page.locator('#continue')).toBeFocused();
  mkdirSync('evidence', { recursive: true });
  await page.screenshot({ path: 'evidence/portal-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: 'evidence/portal-desktop.png', fullPage: true });
  await page.locator('#account-tab').click();
  await page.screenshot({ path: 'evidence/portal-account-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'evidence/portal-account-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator('#password')).toHaveCSS('min-height', '50px');
  expect(await page.locator('#login').evaluate(node => getComputedStyle(node).transitionDuration)).toBe('0s');
  expect(await page.locator('button:visible, input:visible, nav a, summary:visible, header a, footer a').evaluateAll(nodes => nodes.every(n => n.getBoundingClientRect().height >= 44))).toBe(true);
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => [...document.fonts].every(font => font.status === 'loaded'))).toBe(true);
  expect(pageErrors).toEqual([]); expect(external).toEqual([]);
});

test('shared browser cookie cannot retarget a stale tab save or deletion', async ({ page: a, context }) => {
  test.setTimeout(120000);
  // The shared real service enforces 30 requests/IP/minute across tests. Let the
  // previous tests' window expire; do not bypass limits or install a time hook.
  await new Promise(resolve => setTimeout(resolve, 61000));
  const b = await context.newPage();
  const accounts = Array.from({ length: 3 }, () => ({ name: username(), pw: password() }));
  const mutations = [];
  context.on('request', request => { if (request.url().includes('/api/account/') && request.method() !== 'GET') mutations.push(request.url()); });
  async function unlock(page, who, signup = false) {
    await auth(page, who.name, who.pw, signup);
    await expect(page.getByLabel('Server address to remember')).toBeVisible();
  }
  async function vault(page) {
    return page.evaluate(async () => {
      const response = await fetch('/api/account/vault', { headers: { 'X-HouseCall': '1' } });
      return { status: response.status, body: await response.json() };
    });
  }
  async function changed(response) {
    expect(response.status()).toBe(409);
    expect((await response.json()).code).toBe('account_changed');
    await expect(a.locator('#auth-form')).toBeVisible();
    await expect(a.locator('#unlocked')).toBeHidden();
    await expect(a.locator('#servers li')).toHaveCount(0);
    await expect(a.locator('#account-status')).toHaveText('Account changed in another tab. Log in again.');
    await expect(a.locator('#username')).toBeFocused();
  }
  await a.goto('/app/'); await unlock(a, accounts[0], true);
  await b.goto('/app/'); await unlock(b, accounts[1], true);
  const beforeB = await vault(b), cookieB = await context.cookies();
  expect(beforeB.status).toBe(200); expect(beforeB.body.revision).toBe(0);
  await a.getByLabel('Server address to remember').fill('https://must-not-overwrite-other-account.example/');
  const saving = a.waitForResponse(r => r.url().endsWith('/api/account/vault') && r.request().method() === 'PUT');
  await a.getByRole('button', { name: 'Save address', exact: true }).click();
  const saved = await saving;
  expect(saved.request().postDataJSON().expectedRevision).toBe(beforeB.body.revision);
  expect(saved.request().postDataJSON().expectedBinding).not.toBe(beforeB.body.binding);
  await changed(saved);
  expect(await vault(b)).toEqual(beforeB); expect(await context.cookies()).toEqual(cookieB);
  await expect(b.getByLabel('Server address to remember')).toBeVisible();
  await expect(a.locator('#saved-address')).toHaveValue('');

  // Unlock A again, THEN signup/login C in the other tab, THEN delete from A.
  await unlock(a, accounts[0]);
  await b.getByRole('button', { name: 'Lock and log in again', exact: true }).click();
  await unlock(b, accounts[2], true);
  const beforeC = await vault(b), cookieC = await context.cookies();
  expect(beforeC.status).toBe(200);
  await a.getByText('Delete HouseCall account', { exact: true }).click();
  await a.getByLabel('Type DELETE to confirm').fill('DELETE');
  const deleting = a.waitForResponse(r => r.url().endsWith('/api/account/') && r.request().method() === 'DELETE');
  await a.getByRole('button', { name: 'Delete account and saved list', exact: true }).click();
  const deleted = await deleting;
  expect(deleted.request().postDataJSON().expectedBinding).not.toBe(beforeC.body.binding);
  await changed(deleted);
  expect(await vault(b)).toEqual(beforeC); expect(await context.cookies()).toEqual(cookieC);
  await expect(a.locator('#delete-confirm')).toHaveValue('');
  await b.getByRole('button', { name: 'Lock and log in again', exact: true }).click();
  await unlock(b, accounts[2]); // C remains login-capable, not merely cached in B's UI.
  expect(mutations.some(url => url.endsWith('/logout'))).toBe(false);
});
