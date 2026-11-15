import { test, expect, type Page, type APIRequestContext, type BrowserContext } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { b64u, publicIdentityKey, deriveIdentity, destroyIdentity } from '../../src/crypto/identity';
import { copy } from '../../src/ui/copy';
import { DmService } from '../../src/adapters/legacy/dm';
import { IdentityStorage } from '../../src/transport/identityStorage';
import { Api } from '../../src/transport/api';
import { recoveryKey, recoveryWords, sealBackup } from '../../src/crypto/backup';
import { conversationKey, sealMessage } from '../../src/crypto/dm';
import jsQR from 'jsqr';
import { fillSignIn, logInButton, password, setupToken, send, row, act, openMenu } from './helpers';
import type { Auth } from '../../src/data/types';

// Real disposable server and real crypto. No production test switches. Native invoke stand-ins below
// test presentation/plumbing only, never Keychain/Keystore, FLAG_SECURE or OS owner verification.
const aliceSeed = new Uint8Array(32).fill(71), bobSeed = new Uint8Array(32).fill(72);
const headers = (a: Auth) => ({ Authorization: `Bearer ${a.token}`, 'X-Device-Key': a.device_key });
async function json(request: APIRequestContext, path: string, data: unknown, auth?: Auth, method = 'POST') {
  const response = await request.fetch(path, { method, data, headers: auth ? headers(auth) : undefined });
  expect(response.ok(), `${method} ${path}: HTTP ${response.status()}`).toBeTruthy();
  return response.json();
}
async function publish(request: APIRequestContext, auth: Auth, seed: Uint8Array, replacing = false) {
  await json(request, '/api/me/keys', { identity_key: b64u(publicIdentityKey(seed)), ...(replacing ? { password } : {}) }, auth, 'PUT');
  await json(request, '/api/me/key-backup', { key_backup: b64u(sealBackup(seed, 1)) }, auth, 'PUT');
}
async function login(page: Page, name: string) {
  await page.goto('/'); await fillSignIn(page, name); await logInButton(page).click();
  await expect(page.getByTestId('security-flow')).toBeVisible();
}
async function shots(page: Page, name: string) {
  if (process.env.HOUSECALL_SECURITY_SHOTS !== '1') return;
  const directory = resolve('../docs/ux/security-ui'); await mkdir(directory, { recursive: true });
  for (const [width, height] of [[1280, 800], [390, 844]]) for (const scheme of ['light', 'dark'] as const) {
    await page.setViewportSize({ width, height }); await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.screenshot({ path: resolve(directory, `${name}-${width}-${scheme}.png`), mask: [page.locator('.hc-words'), page.locator('.hc-qr:not(.is-hidden)'), page.locator('textarea'), page.locator('input[type="password"]'), page.locator('.hc-recovery__pair input'), page.locator('.hc-codefield'), page.locator('.hc-plates')] });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 1280, height: 800 });
}
async function importKey(page: Page, seed: Uint8Array, checkGate = false) {
  const flow = page.getByTestId('security-flow');
  await flow.getByRole('button', { name: 'Enter recovery key', exact: true }).click();
  await expect(flow.locator('textarea')).toHaveCount(0);
  await expect(flow).toContainText('whoever runs');
  if (checkGate) await shots(page, 'browser-warning');
  await flow.getByRole('button', { name: 'Continue', exact: true }).click();
  const field = flow.locator('textarea'); await expect(field).toBeVisible();
  if (checkGate) {
    await field.fill(Array(24).fill('notaword').join(' '));
    await flow.getByRole('button', { name: 'Unlock my DMs', exact: true }).click();
    await expect(flow.getByRole('alert')).toContainText("Those words aren't a recovery key.");
    await shots(page, 'recovery-error');
  }
  const r = recoveryKey(seed, 1);
  try { await field.evaluate((element, value) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })); }, recoveryWords(r)); } finally { r.fill(0); }
  await flow.getByRole('button', { name: 'Unlock my DMs', exact: true }).click();
  await expect(field).toHaveCount(0);
  await flow.getByRole('button', { name: 'Cancel', exact: true }).click();
}
async function openDm(page: Page, name = 'security pair') {
  await openMenu(page);
  const tab = page.getByRole('button', { name: 'Direct messages', exact: true });
  if (await tab.isVisible()) await tab.click();
  // Existing channel rows expose the conversation name as their accessible name.
  await page.getByRole('button', { name: `Open ${name}`, exact: true }).click();
  await expect(page.getByTestId('screen-composer').getByLabel('Message', { exact: true })).toBeVisible();
}

async function readShowingQr(page: Page): Promise<string> {
  const showing = page.getByTestId('screen-qr');
  const rendered = await showing.locator('svg.hc-qr__svg').evaluate(svg => ({ viewBox: svg.getAttribute('viewBox')!, path: svg.querySelector('path')!.getAttribute('d')! }));
  const modules = Number(rendered.viewBox.split(' ')[2]), scale = 5, width = modules * scale;
  const pixels = new Uint8ClampedArray(width * width * 4).fill(255);
  for (const match of rendered.path.matchAll(/M(\d+) (\d+)h1v1h-1z/g)) for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) { const offset = ((Number(match[2]) * scale + dy) * width + Number(match[1]) * scale + dx) * 4; pixels.fill(0, offset, offset + 3); }
  const qr = jsQR(pixels, width, width)!.data; pixels.fill(0); return qr;
}

async function noticeLayout(page: Page) {
  // Notices now expire after six seconds. Trigger a fresh real device login at
  // this assertion, rather than relying on a notice from the start of the test.
  const response = await page.request.post('/api/login', { data: { username: 'security_owner', password, device_name: 'notice layout fixture' } });
  expect(response.ok()).toBe(true);
  const notice = page.locator('.hc-security-notice');
  await expect(notice).toContainText('notice layout fixture');
  await expect(notice).toBeVisible();
  for (const [width, height] of [[1280, 800], [390, 844], [390, 420]]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => document.documentElement.style.setProperty('--hc-safe-top', '24px'));
    const banner = await notice.boundingBox(), shell = await page.locator('.hc-shell').boundingBox();
    expect(banner && shell && banner.y + banner.height <= shell.y + 1).toBe(true);
    expect(await notice.evaluate(element => getComputedStyle(element).position)).toBe('static');
    await expect(page.locator('.hc-header .hc-lockline')).toBeInViewport();
  }
  await page.evaluate(() => document.documentElement.style.removeProperty('--hc-safe-top'));
  await page.setViewportSize({ width: 1280, height: 800 });
}

async function nativeFixture(context: BrowserContext, seed: Uint8Array) {
  await context.addInitScript(({ seed }) => {
    const records = new Map<string, unknown>(); records.set('identity', { seed: encodeFixtureSeed(seed), recovery_rev: 1, confirmed: true });
    function encodeFixtureSeed(bytes: number[]) { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
    Object.assign(window, { __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, any> = {}) => {
      if (command.endsWith('|identity_get')) return { identity: records.get('identity') };
      if (command.endsWith('|identity_set')) { records.set('identity', args.identity); return { ok: true }; }
      if (command.endsWith('|bindings_get')) return { bindings: records.get('bindings:' + args.origin + args.userId) ?? [] };
      if (command.endsWith('|bindings_set')) { records.set('bindings:' + args.origin + args.userId, args.bindings); return { ok: true }; }
      if (command.endsWith('|pins_get')) return { pins: records.get(args.origin + args.userId) ?? [] };
      if (command.endsWith('|pins_set')) { records.set(args.origin + args.userId, args.pins); return { ok: true }; }
      if (command.endsWith('|list')) return { origins: [] };
      if (command.endsWith('|set') || command.endsWith('|remove')) return { ok: true };
      if (command.endsWith('|verify_owner')) return { supported: false, verified: false }; // Explicit unsupported -> real password fallback.
      if (command.endsWith('|sensitive_surface')) return { ok: true, captured: false }; // Presentation only.
      if (command === 'native_push') return { supported: false, configured: false, enabled: false, permissionGranted: false };
      if (command === 'native_auth') return args.action === 'status' ? { platform: 'desktop' } : {};
      if (command === 'scheme_invite_take') return {};
      throw new Error('Native command unavailable in presentation fixture');
    } } });
  }, { seed: Array.from(seed) });
}

test.use({ actionTimeout: 10_000, navigationTimeout: 15_000 });
async function bounded<T>(work: Promise<T>, label: string, milliseconds = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), milliseconds); })]); }
  finally { clearTimeout(timer!); }
}
let fixture: { alice: Auth; bob: Auth; dm: { id: string }; seedId: string; seedText: string };
test.beforeAll(async ({ request }) => {
  const setup = await request.post('/api/setup', { data: { username: 'security_owner', password, setup_token: setupToken, device_name: 'synthetic fixture owner' } });
  const alice: Auth = setup.ok() ? await setup.json() : await json(request, '/api/login', { username: 'security_owner', password, device_name: 'synthetic shared setup' });
  const existing = await request.post('/api/login', { data: { username: 'security_friend', password, device_name: 'synthetic shared peer' } });
  let bob: Auth;
  if (existing.ok()) bob = await existing.json();
  else {
    const invitation = await json(request, '/api/invites', { expires_in_seconds: 300 }, alice);
    bob = await json(request, '/api/invites/accept', { token: invitation.token, username: 'security_friend', password, device_name: 'synthetic fixture friend' });
  }
  const channels = await (await request.get('/api/channels', { headers: headers(alice) })).json();
  let dm = channels.channels.find((row: { name: string }) => row.name === 'security pair');
  if (!dm) {
    dm = await json(request, '/api/channels', { name: 'security pair', kind: 'dm', member_ids: [bob.user.id] }, alice);
    await json(request, `/api/channels/${dm.id}/messages`, { body: 'old plaintext fixture' }, alice);
    await publish(request, alice, aliceSeed); await publish(request, bob, bobSeed);
  }
  const api = new Api('http://127.0.0.1:3031'); api.authenticate(alice);
  const vault = new IdentityStorage(); await vault.saveIdentity({ seed: aliceSeed, recoveryRev: 1, confirmed: true });
  const seedText = `shared setup sealed fixture ${randomUUID()}`;
  const service = new DmService(api, vault, 'http://127.0.0.1:3031', alice.user.id);
  const seed = await service.send({ id: dm.id, kind: 'dm', memberIds: [alice.user.id, bob.user.id] }, seedText); service.dispose();
  fixture = { alice, bob, dm, seedId: seed.id, seedText };
});

test('security vertical slice: real browser imports, sealed send/read/edit/reply/file, key change/rollback and signout', async ({ browser, request }) => {
  const { alice, bob, dm } = fixture;
  const contexts = await Promise.all([browser.newContext({ viewport: { width: 1280, height: 800 } }), browser.newContext({ viewport: { width: 1280, height: 800 } })]);
  const [a, b] = await Promise.all(contexts.map(c => c.newPage()));
  await login(a, alice.user.username); await importKey(a, aliceSeed, true);
  await login(b, bob.user.username); await importKey(b, bobSeed);
  await openDm(a); await openDm(b);
  await expect(a.locator('.hc-header .hc-lockline')).toContainText('Encrypted in browser');
  await expect(row(a, 'old plaintext fixture')).toContainText('Not encrypted');
  await expect(a.getByRole('button', { name: 'Show my QR code', exact: true })).toHaveCount(0);
  const sentRequest = a.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/channels/${dm.id}/messages`);
  await send(a, 'sealed fixture message');
  const sent = await (await sentRequest).json();
  const outgoing = JSON.parse((await sentRequest).request().postData()!);
  expect(outgoing.mention_ids).toEqual([bob.user.id]); expect(outgoing).not.toHaveProperty('body');
  // Recipient's normal read loop may immediately consume this notification, so the focused
  // standalone case below verifies durable creation before any recipient opens the DM.
  expect(sent.enc).toBe(1); await expect(row(b, 'sealed fixture message')).toBeVisible();
  const history = await request.get(`/api/channels/${dm.id}/messages`, { headers: headers(alice) });
  const rows = (await history.json()).messages;
  expect(rows.some((r: { enc: number; body: string }) => r.enc === 1 && !r.body.includes('sealed fixture message'))).toBe(true);
  await act(b, 'sealed fixture message', 'Reply'); await send(b, 'authenticated fixture reply');
  await expect(row(a, 'authenticated fixture reply').locator('.hc-msg__reply')).toContainText('sealed fixture message');
  await act(a, 'sealed fixture message', 'Edit');
  await a.getByTestId('screen-composer').getByLabel('Message', { exact: true }).fill('edited sealed fixture');
  await a.getByRole('button', { name: 'Save edit', exact: true }).click();
  await expect(row(b, 'edited sealed fixture')).toBeVisible();
  await expect(row(b, 'authenticated fixture reply')).toContainText('The message this replies to was edited.');
  await a.getByTestId('screen-composer').locator('input[type="file"]').setInputFiles({ name: 'fixture.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>throw 1</script></svg>') });
  await expect(a.getByTestId('attached')).toContainText('fixture.svg');
  await send(a, 'sealed file fixture');
  const file = row(b, 'sealed file fixture'); await expect(file).toContainText('Not virus-scanned (encrypted)');
  await expect(file.locator('img, iframe, object, embed')).toHaveCount(0);
  const downloadPromise = b.waitForEvent('download'); await file.getByRole('button', { name: 'Download fixture.svg', exact: true }).click();
  const download = await downloadPromise; const downloaded = await download.path();
  expect(download.suggestedFilename()).toBe('fixture.svg'); expect(await readFile(downloaded!, 'utf8')).toContain('<svg');
  await expect(a.getByRole('button', { name: "GIFs aren't available in encrypted DMs yet.", exact: true })).toBeDisabled();
  // A legitimate peer reset is real server state. Seal a new row with actual new keys to exercise held rows.
  const oldBob = await (await request.get(`/api/users/${bob.user.id}/keys`, { headers: headers(alice) })).json();
  const newBobSeed = new Uint8Array(32).fill(73); await publish(request, bob, newBobSeed, true);
  const identity = deriveIdentity(newBobSeed), key = conversationKey({ channelId: dm.id, myId: bob.user.id, peerId: alice.user.id, myIdentity: identity, peerIdentityKey: publicIdentityKey(aliceSeed) });
  const envelope = b64u(sealMessage({ key, channelId: dm.id, senderId: bob.user.id, recipientId: alice.user.id, senderKeyRev: 2, recipientKeyRev: 1, payload: { v: 1, text: 'held fixture message' } })); key.fill(0); destroyIdentity(identity);
  await json(request, `/api/channels/${dm.id}/messages`, { enc: 1, envelope }, bob);
  await expect(a.locator('.hc-keybanner')).toContainText('security key changed');
  await expect(a.getByTestId('screen-composer').getByLabel('Message', { exact: true })).toBeDisabled();
  await expect(a.getByTestId('screen-conversation')).not.toContainText('held fixture message');
  await expect(a.getByTestId('screen-conversation')).toContainText('messages are waiting'); await shots(a, 'key-changed');
  await a.locator('.hc-keybanner').getByRole('button', { name: 'I understand', exact: true }).click();
  await expect(row(a, 'held fixture message')).toBeVisible();
  await noticeLayout(a);
  // Adversarial server response only: never substitute crypto or the send/read integration above.
  await a.route(`**/api/users/${bob.user.id}/keys`, route => route.fulfill({ json: oldBob }));
  await a.locator('.hc-header .hc-lockline').click();
  await a.getByTestId('dm-security-details').getByRole('button', { name: 'Mark as verified', exact: true }).click();
  await a.getByTestId('dm-security-details').getByRole('button', { name: 'Close', exact: true }).click();
  await expect(a.locator('.hc-header .hc-lockline')).toContainText('Key problem');
  await expect(a.getByRole('button', { name: 'I understand', exact: true })).toHaveCount(0);
  await expect(a.getByTestId('screen-composer').getByLabel('Message', { exact: true })).toBeDisabled(); await shots(a, 'key-rollback');
  await a.unroute(`**/api/users/${bob.user.id}/keys`);
  // Signout tears down all page memory. Fresh login must gate recovery input again.
  await a.getByRole('button', { name: 'Settings', exact: true }).click();
  await a.getByTestId('screen-settings').getByRole('button', { name: 'Profile', exact: true }).click();
  await a.getByRole('button', { name: 'Sign out', exact: true }).click();
  await fillSignIn(a, alice.user.username); await logInButton(a).click();
  await expect(a.getByTestId('security-flow')).toContainText('Get your security key');
  await a.getByTestId('security-flow').getByRole('button', { name: 'Enter recovery key', exact: true }).click();
  await expect(a.getByTestId('security-flow').locator('textarea')).toHaveCount(0);
  for (const c of contexts) await c.close();
});

test('fragment removal and native QR number/verification presentation use real link endpoints', async ({ browser, request }) => {
  // Explicit shared beforeAll provisions this account even when this case is run alone.
  const auth: Auth = await json(request, '/api/login', { username: 'security_owner', password, device_name: 'fixture native session' });
  const nativeContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await nativeFixture(nativeContext, aliceSeed);
  const native = await nativeContext.newPage(); await native.goto('/');
  await fillSignIn(native, 'security_owner');
  const address = native.getByLabel('Server address', { exact: true }); if (await address.isVisible()) await address.fill('http://localhost:1420');
  await logInButton(native).click();
  const bootstrap = native.getByTestId('security-flow'); if (await bootstrap.isVisible()) await bootstrap.getByRole('button', { name: 'Cancel', exact: true }).click();
  await native.getByRole('button', { name: 'Settings', exact: true }).click();
  await native.getByTestId('screen-settings').getByRole('button', { name: 'Devices', exact: true }).click();
  await native.getByRole('button', { name: 'Log in with QR code', exact: true }).click();
  const showing = native.getByTestId('screen-qr'); await shots(native, 'qr-hidden');
  let approvals = 0; native.on('request', req => { if (/\/api\/link\/[^/]+\/approve$/.test(new URL(req.url()).pathname)) approvals++; });
  await showing.getByRole('button', { name: 'Show my QR code', exact: true }).click();
  await expect(showing.locator('.hc-qr')).not.toHaveClass(/is-hidden/);
  // Decode actual rendered QR modules; no product hook, secret attribute or test-only QR injection.
  const qr = await readShowingQr(native);
  const browserContext = await browser.newContext();
  await browserContext.addInitScript(value => history.replaceState(null, '', '/#link=' + value), qr.split('#')[1]);
  const receiving = await browserContext.newPage(); await receiving.goto('/');
  expect(new URL(receiving.url()).hash).toBe('');
  await expect(receiving.getByTestId('screen-link-receive')).toContainText('Log in on');
  await receiving.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(receiving.getByTestId('screen-link-receive')).toContainText('whoever runs'); await shots(receiving, 'qr-browser-warning');
  await receiving.getByRole('button', { name: 'Continue', exact: true }).click();
  const number = await receiving.locator('.hc-plates').getAttribute('aria-label');
  await receiving.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(showing.locator('#hc-link-code')).toBeVisible();
  await expect(showing.getByRole('button', { name: /^(Approve|Yes)$/ })).toHaveCount(0);
  expect(approvals).toBe(0);
  await showing.locator('#hc-link-code').fill(number!);
  await expect(showing.getByLabel('Your password', { exact: true })).toBeVisible();
  expect(approvals).toBe(0); await shots(native, 'qr-verification');
  await showing.getByRole('button', { name: 'Deny', exact: true }).click();
  expect(approvals).toBe(0); await shots(native, 'qr-denied');
  await expect(receiving.getByTestId('screen-link-receive')).toContainText('Your other device said no');
  const successContext = await browser.newContext();
  const successPage = await successContext.newPage();
  await showing.getByRole('button', { name: 'Make a new code', exact: true }).click();
  await expect(showing.locator('.hc-qr')).not.toHaveClass(/is-hidden/);
  const nextQr = await readShowingQr(native);
  await successContext.addInitScript(value => history.replaceState(null, '', '/#link=' + value), nextQr.split('#')[1]);
  let failExposureOnce = true;
  await successPage.route('**/api/me/key-exposure', route => {
    if (route.request().method() === 'POST' && failExposureOnce) { failExposureOnce = false; return route.fulfill({ status: 503, json: { error: 'temporary fixture report failure' } }); }
    return route.continue();
  });
  await successPage.goto('/');
  await successPage.getByRole('button', { name: 'Continue', exact: true }).click();
  await successPage.getByRole('button', { name: 'Continue', exact: true }).click();
  const nextNumber = await successPage.locator('.hc-plates').getAttribute('aria-label');
  await successPage.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(showing.locator('#hc-link-code')).toBeVisible();
  await showing.locator('#hc-link-code').fill(nextNumber!);
  const ownerPassword = showing.getByLabel('Your password', { exact: true }); await expect(ownerPassword).toBeVisible();
  expect(approvals).toBe(0);
  await ownerPassword.fill(password);
  await showing.getByRole('button', { name: 'Log in Housecall browser', exact: true }).click();
  await expect(showing).toContainText('Housecall browser is now logged in');
  expect(approvals).toBe(1); await shots(native, 'qr-approved');
  await expect(successPage.getByTestId('screen-link-receive')).toContainText('Browser exposure report failed.');
  await shots(successPage, 'qr-exposure-retry');
  // Leaving success retains pending housekeeping in the real Security pane.
  await successPage.getByRole('button', { name: 'Done', exact: true }).click();
  await successPage.getByRole('button', { name: 'Settings', exact: true }).click();
  await successPage.getByTestId('screen-settings').getByRole('button', { name: 'Security', exact: true }).click();
  await expect(successPage.getByTestId('screen-security')).toContainText('Browser exposure report failed.');
  await successPage.getByTestId('screen-security').getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(successPage.getByTestId('screen-security')).not.toContainText('Browser exposure report failed.');
  await successPage.getByTestId('screen-settings').getByRole('button', { name: 'Close', exact: true }).click();
  await openDm(successPage); await expect(successPage.locator(`li[data-message-id="${fixture.seedId}"] .hc-md`)).toHaveText(fixture.seedText);
  await showing.getByRole('button', { name: 'Done', exact: true }).click();
  await native.getByTestId('screen-settings').getByRole('button', { name: 'Security', exact: true }).click();
  await native.getByTestId('screen-security').getByRole('button', { name: 'View recovery key', exact: true }).click();
  const keyFlow = native.getByTestId('security-flow');
  await keyFlow.getByRole('button', { name: 'View recovery key', exact: true }).click();
  await keyFlow.getByLabel('Your password', { exact: true }).fill(password);
  await keyFlow.getByRole('button', { name: 'Show key', exact: true }).click();
  await expect(keyFlow.locator('.hc-words li')).toHaveCount(24); await shots(native, 'recovery-view');
  await keyFlow.getByRole('button', { name: 'Done', exact: true }).click();
  await keyFlow.getByRole('button', { name: 'Replace recovery key', exact: true }).click();
  await expect(keyFlow).toContainText('Replacing does not stop old words that have already leaked.'); await shots(native, 'recovery-replace-warning');
  await keyFlow.getByRole('button', { name: 'Cancel', exact: true }).click();
  await successContext.close();
  await nativeContext.close(); await browserContext.close();
  // Both /link delivery paths reject missing/malformed data without an actionable link.
  const staticPage = await request.get('http://127.0.0.1:3031/link');
  expect(staticPage.ok()).toBe(true); expect(await staticPage.text()).toContain('href="housecall://link-scan"');
  const staticScript = await request.get('http://127.0.0.1:3031/link/link.js'); expect(staticScript.ok()).toBe(true);
  const page = await browser.newPage(); await page.goto('/link/index.html#malformed');
  expect(new URL(page.url()).hash).toBe(''); await expect(page.locator('a')).toHaveCount(0); await shots(page, 'link-invalid');
  await page.close();
});

async function freshPair(request: APIRequestContext, suffix: string, publishPeer = true) {
  const alice = fixture.alice;
  const invitation = await json(request, '/api/invites', { expires_in_seconds: 300 }, alice);
  // Keep the full scenario label in the channel name; usernames allow at most 32 ASCII characters.
  const peer: Auth = await json(request, '/api/invites/accept', { token: invitation.token, username: randomUUID().replace(/-/g, ''), password, device_name: 'synthetic isolated peer' });
  if (publishPeer) await publish(request, peer, bobSeed);
  const name = `security ${suffix}`;
  const dm = await json(request, '/api/channels', { name, kind: 'dm', member_ids: [peer.user.id] }, alice);
  const api = new Api('http://127.0.0.1:3031'); api.authenticate(peer);
  const vault = new IdentityStorage(); await vault.saveIdentity({ seed: bobSeed, recoveryRev: 1, confirmed: true });
  const service = new DmService(api, vault, 'http://127.0.0.1:3031', peer.user.id);
  const context = { id: dm.id, kind: 'dm' as const, memberIds: [alice.user.id, peer.user.id] };
  return { alice, peer, dm, name, service, context };
}

test('hostile DM metadata cannot send plaintext through actual composer or attachment handlers', async ({ browser, request }) => {
  const pair = await freshPair(request, 'metadata');
  const context = await browser.newContext(), page = await context.newPage();
  await login(page, pair.alice.user.username); await importKey(page, aliceSeed); await openDm(page, pair.name);
  const baseline = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/channels/${pair.dm.id}/messages`);
  await send(page, 'established encrypted metadata fixture');
  const sent = await baseline; await sent.finished();
  expect(JSON.parse(sent.request().postData()!).enc).toBe(1);
  await expect(page.getByTestId('screen-composer').getByLabel('Message', { exact: true })).toHaveValue('');
  await expect(page.locator('.hc-header .hc-lockline')).toContainText('Encrypted in browser');
  let mutation: Record<string, unknown> = {};
  await page.route('**/api/channels', async route => {
    const response = await route.fetch(), data = await response.json();
    data.channels = data.channels.map((row: { id: string }) => row.id === pair.dm.id ? { ...row, ...mutation } : row);
    await route.fulfill({ response, json: data });
  });
  const leaked: string[] = [];
  page.on('request', req => {
    if (['POST', 'PATCH', 'PUT'].includes(req.method()) && /\/api\/(channels\/[^/]+\/messages|messages\/|uploads)/.test(new URL(req.url()).pathname)) leaked.push(req.postData() ?? '<binary>');
  });
  for (const change of [{ peer_id: null }, { peer_id: pair.alice.user.id }, { peer_id: pair.peer.user.id + '-substituted' }, { kind: 'group_dm' }, { kind: 'channel' }]) {
    // Start from the retained legitimate binding, with a draft already present at the attack.
    mutation = {};
    const restored = page.waitForResponse(r => new URL(r.url()).pathname === '/api/channels');
    await pair.service.send(pair.context, 'metadata restore tick'); await restored;
    const input = page.getByTestId('screen-composer').getByLabel('Message', { exact: true });
    await expect(input).toBeEnabled(); await input.fill('metadata secret must never reach network');
    mutation = change;
    const changed = page.waitForResponse(r => new URL(r.url()).pathname === '/api/channels');
    await pair.service.send(pair.context, 'metadata attack tick'); await (await changed).finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    // Disabled state proves the channel response reached the actual application adapter.
    await expect(input).toBeDisabled();
    // Dispatch the actual form handler even while its controls are disabled. The old candidate
    // enables this form and posts plaintext after peer_id=null; this assertion catches that POST.
    await page.getByTestId('screen-composer').dispatchEvent('submit');
    await page.getByTestId('screen-composer').locator('input[type="file"]').setInputFiles({ name: 'metadata-private.txt', mimeType: 'text/plain', buffer: Buffer.from('private attachment fixture') });
    expect(leaked, 'Hostile metadata must never permit a plaintext message or raw file request').toEqual([]);
    await expect(input).toBeDisabled();
  }
  await context.close(); pair.service.dispose();
});

test('actual encrypted app send creates generic peer notification without disclosing sealed text', async ({ browser, request }) => {
  const pair = await freshPair(request, 'notification');
  const context = await browser.newContext(), page = await context.newPage();
  await login(page, pair.alice.user.username); await importKey(page, aliceSeed); await openDm(page, pair.name);
  const text = `@${pair.peer.user.username} sealed notification fixture`;
  const sentResponse = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/channels/${pair.dm.id}/messages`);
  await send(page, text);
  const sent = await sentResponse, row = await sent.json(), payload = JSON.parse(sent.request().postData()!);
  expect(payload.mention_ids).toEqual([pair.peer.user.id]); expect(payload).not.toHaveProperty('body');
  expect(JSON.stringify(payload)).not.toContain(text); expect(row.enc).toBe(1);
  // No recipient UI is open: no mark-read races can erase the asserted notification.
  const notifications = await (await request.get('/api/notifications', { headers: headers(pair.peer) })).json();
  expect(notifications.notifications.some((n: { message_id: string }) => n.message_id === row.id)).toBe(true);
  expect(JSON.stringify(notifications)).not.toContain(text); expect(JSON.stringify(notifications)).not.toContain('sealed notification fixture');
  await context.close(); pair.service.dispose();
});

test('pending Show key responses are discarded after close and blur, including reopen', async ({ browser }) => {
  const context = await browser.newContext(); await nativeFixture(context, aliceSeed);
  const page = await context.newPage(); await page.goto('/'); await fillSignIn(page, 'security_owner');
  const address = page.getByLabel('Server address', { exact: true }); if (await address.isVisible()) await address.fill('http://localhost:1420');
  await logInButton(page).click();
  await expect(page.getByTestId('screen-composer')).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByTestId('screen-settings').getByRole('button', { name: 'Security', exact: true }).click();
  for (const interruption of ['close', 'blur'] as const) {
    await page.getByTestId('screen-security').getByRole('button', { name: 'View recovery key', exact: true }).click();
    const flow = page.getByTestId('security-flow');
    await flow.getByRole('button', { name: 'View recovery key', exact: true }).click();
    await flow.getByLabel('Your password', { exact: true }).fill(password);
    let release!: () => void, reached!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), requested = new Promise<void>(resolve => { reached = resolve; });
    await page.route('**/api/me/password-check', async route => {
      const response = await route.fetch(); reached(); await held; await route.fulfill({ response });
    }, { times: 1 });
    await flow.getByRole('button', { name: 'Show key', exact: true }).click(); await bounded(requested, 'delayed password-check request');
    if (interruption === 'close') await flow.getByRole('button', { name: 'Close', exact: true }).click();
    else await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    // Resolve only after interruption, then let every actual backup/auth request settle.
    let backupReads = 0, finished!: () => void;
    const displayChecked = new Promise<void>(resolve => { finished = resolve; });
    const onResponse = (response: import('@playwright/test').Response) => {
      if (new URL(response.url()).pathname === '/api/me/key-backup' && response.request().method() === 'GET' && ++backupReads === 2) void response.finished().then(finished);
    };
    page.on('response', onResponse);
    const checked = page.waitForResponse(r => new URL(r.url()).pathname === '/api/me/password-check');
    release(); await checked; await bounded(displayChecked, 'both recovery backup checks after password response');
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    page.off('response', onResponse);
    await expect(page.locator('.hc-words')).toHaveCount(0);
    if (interruption === 'blur') await flow.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByTestId('screen-security').getByRole('button', { name: 'View recovery key', exact: true }).click();
    await flow.getByRole('button', { name: 'View recovery key', exact: true }).click();
    await expect(flow.getByLabel('Your password', { exact: true })).toHaveValue('');
    await expect(flow.locator('.hc-words')).toHaveCount(0);
    await expect(flow.getByRole('button', { name: 'Show key', exact: true })).toBeDisabled();
    await flow.getByRole('button', { name: 'Close', exact: true }).click();
  }
  await context.close();
});

async function showingDevice(context: BrowserContext) {
  await nativeFixture(context, aliceSeed);
  const page = await context.newPage(); await page.goto('/'); await fillSignIn(page, 'security_owner');
  const address = page.getByLabel('Server address', { exact: true }); if (await address.isVisible()) await address.fill('http://localhost:1420');
  await logInButton(page).click(); await expect(page.getByTestId('screen-composer')).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByTestId('screen-settings').getByRole('button', { name: 'Devices', exact: true }).click();
  await page.getByRole('button', { name: 'Log in with QR code', exact: true }).click();
  await page.getByTestId('screen-qr').getByRole('button', { name: 'Show my QR code', exact: true }).click();
  await expect(page.getByTestId('screen-qr').locator('.hc-qr')).not.toHaveClass(/is-hidden/);
  return page;
}

test('signed-in locked QR receiver adopts before revoking and ignores an in-flight old 401 while success stays open', async ({ browser, request }) => {
  const showingContext = await browser.newContext(), receivingContext = await browser.newContext();
  const source = await showingDevice(showingContext), qr = await readShowingQr(source);
  const receiver = await receivingContext.newPage();
  const loginResponse = receiver.waitForResponse(r => new URL(r.url()).pathname === '/api/login' && r.request().method() === 'POST');
  await login(receiver, 'security_owner'); const old: Auth = await (await loginResponse).json();
  await receiver.route('**/api/me/key-exposure', route => route.fulfill({ status: 503, json: { error: 'temporary signed-in fixture exposure failure' } }), { times: 1 });
  const oldMe = await (await request.get('/api/me', { headers: headers(old) })).json();
  // Hold one genuine old-session event request. Release it with the real 401 only after
  // revocation; the replacement must already be driving the app by then.
  let release!: () => void, reached!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), inflight = new Promise<void>(resolve => { reached = resolve; });
  await receiver.route('**/api/events?*', async route => {
    if (route.request().headers().authorization === `Bearer ${old.token}`) {
      reached(); await held;
      const response = await request.get(route.request().url(), { headers: headers(old) });
      expect(response.status()).toBe(401);
      try { await route.fulfill({ response }); }
      catch (error) { if (!route.request().failure()) throw error; } // Auth adoption may already have aborted the old poll.
    } else await route.continue();
  });
  await bounded(inflight, 'old-session event poll');
  // Feed real QR pixels through the actual getUserMedia/video/jsQR scanner path.
  await receiver.evaluate(async value => {
    const { default: qrcode } = await import('/node_modules/qrcode-generator/dist/qrcode.mjs' as string);
    const code = qrcode(0, 'M'); code.addData(value, 'Byte'); code.make();
    const count = code.getModuleCount(), scale = 6, margin = 4;
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = (count + margin * 2) * scale;
    const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.fillStyle = '#000';
    for (let y = 0; y < count; y++) for (let x = 0; x < count; x++) if (code.isDark(y, x)) ctx.fillRect((x + margin) * scale, (y + margin) * scale, scale, scale);
    // StrictMode cancels its first camera acquisition. Its cleanup stops a shared stream;
    // return a fresh live track for every acquisition, like a real camera.
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => {
      const stream = canvas.captureStream(10);
      const frame = () => {
        if (!stream.active) return;
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 1, 1);
        (stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack).requestFrame();
        requestAnimationFrame(frame);
      }; frame();
      return stream;
    } });
  }, qr);
  const identity = receiver.getByTestId('security-flow');
  await identity.getByRole('button', { name: "Scan a QR code from a device where you're logged in", exact: true }).click();
  await receiver.getByTestId('screen-link-receive').getByRole('button', { name: 'Scan QR code', exact: true }).click();
  const receiving = receiver.getByTestId('screen-link-receive');
  try { await expect(receiving).toContainText('Log in on'); }
  catch (error) {
    const diagnostic = await receiver.getByTestId('snap-camera-video').evaluate((video: HTMLVideoElement) => ({
      readyState: video.readyState, width: video.videoWidth, height: video.videoHeight, paused: video.paused,
      tracks: (video.srcObject as MediaStream | null)?.getVideoTracks().map(track => ({ readyState: track.readyState, enabled: track.enabled, muted: track.muted })),
    })).catch(() => ({ cameraMounted: false }));
    throw new Error(`Real QR video did not decode: ${JSON.stringify(diagnostic)}`, { cause: error });
  }
  await receiving.getByRole('button', { name: 'Continue', exact: true }).click();
  await receiving.getByRole('button', { name: 'Continue', exact: true }).click();
  const number = await receiving.locator('.hc-plates').getAttribute('aria-label');
  await receiving.getByRole('button', { name: 'Continue', exact: true }).click();
  const showing = source.getByTestId('screen-qr'); await expect(showing.locator('#hc-link-code')).toBeVisible();
  await showing.locator('#hc-link-code').fill(number!);
  await showing.getByLabel('Your password', { exact: true }).fill(password);
  const adoption = receiver.waitForRequest(req => new URL(req.url()).pathname === '/api/me' && !!req.headers().authorization && req.headers().authorization !== `Bearer ${old.token}`);
  await showing.getByRole('button', { name: 'Log in Housecall browser', exact: true }).click();
  const replacementHeaders = (await adoption).headers();
  await expect(receiving).toContainText("You're in");
  await expect.poll(async () => (await request.get('/api/me', { headers: headers(old) })).status()).toBe(401);
  release();
  // Observe two current-session polls, rather than sleeping or clicking Done early.
  let currentPolls = 0;
  receiver.on('response', response => {
    if (new URL(response.url()).pathname === '/api/events' && response.request().headers().authorization === replacementHeaders.authorization && response.ok()) currentPolls++;
  });
  await expect.poll(() => currentPolls, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
  await expect(receiving).toContainText("You're in");
  const notice = receiver.locator('.hc-security-notice');
  if (await notice.count()) {
    const banner = await notice.boundingBox(), flow = await receiving.boundingBox();
    expect(banner && flow && banner.y + banner.height <= flow.y + 1).toBe(true);
  }
  const currentMe = await request.get('/api/me', { headers: { Authorization: replacementHeaders.authorization, 'X-Device-Key': replacementHeaders['x-device-key'] } });
  expect(currentMe.ok()).toBe(true); expect((await currentMe.json()).session_id).not.toBe(oldMe.session_id);
  await expect(receiving).toContainText('Browser exposure report failed.');
  // Adoption already happened. Leaving via Back must retain pending completion work too.
  await receiving.getByRole('button', { name: 'Back', exact: true }).click();
  await receiver.getByRole('button', { name: 'Settings', exact: true }).click();
  await receiver.getByTestId('screen-settings').getByRole('button', { name: 'Security', exact: true }).click();
  const securityPane = receiver.getByTestId('screen-security');
  await expect(securityPane).toContainText('Browser exposure report failed.');
  await securityPane.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(securityPane).not.toContainText('Browser exposure report failed.');
  await receiver.getByTestId('screen-settings').getByRole('button', { name: 'Close', exact: true }).click();
  await openDm(receiver); await expect(receiver.locator(`li[data-message-id="${fixture.seedId}"] .hc-md`)).toHaveText(fixture.seedText);
  // A genuine revocation of the current generation must still sign out and clear browser keys.
  const currentSession = (await (await request.get('/api/me', { headers: { Authorization: replacementHeaders.authorization, 'X-Device-Key': replacementHeaders['x-device-key'] } })).json()).session_id;
  await json(request, `/api/devices/${currentSession}`, undefined, fixture.alice, 'DELETE');
  await expect(receiver.getByTestId('screen-welcome').or(receiver.getByTestId('screen-sign-in'))).toBeVisible();
  await showingContext.close(); await receivingContext.close();
});


for (const mode of ['paused-resume', 'between-chunks'] as const) {
  test(`legacy attachment stops when encryption activates: ${mode}`, async ({ browser, request }) => {
    const pair = await freshPair(request, `upload-${mode}`, false);
    const context = await browser.newContext(), page = await context.newPage();
    await login(page, pair.alice.user.username); await importKey(page, aliceSeed); await openDm(page, pair.name);
    const composer = page.getByTestId('screen-composer');
    await expect(composer.getByLabel('Message', { exact: true })).toBeEnabled();
    await expect(composer).toContainText('Not encrypted');
    const plaintext = Buffer.alloc(9 * 1024 * 1024, 65);
    let atServer!: () => void, release!: () => void, intercepted = false;
    const receivedFirst = new Promise<void>(resolve => { atServer = resolve; });
    const holdResponse = new Promise<void>(resolve => { release = resolve; });
    const outbound: { method: string; path: string; bytes: number }[] = [];
    page.on('request', req => {
      const path = new URL(req.url()).pathname;
      if (path.startsWith('/api/uploads') && ['POST', 'PATCH'].includes(req.method()))
        outbound.push({ method: req.method(), path, bytes: req.postDataBuffer()?.length ?? 0 });
    });
    await page.route('**/api/uploads/*', async route => {
      if (route.request().method() !== 'PATCH' || intercepted) { await route.continue(); return; }
      intercepted = true;
      const response = await route.fetch(); // The real server accepted the first plaintext chunk.
      expect(response.ok()).toBe(true); atServer(); await holdResponse;
      // Pause aborts the WebView request while the independent route.fetch has completed.
      if (mode === 'paused-resume') await route.abort();
      else await route.fulfill({ response });
    });
    await composer.locator('input[type="file"]').setInputFiles({ name: 'legacy-private.txt', mimeType: 'text/plain', buffer: plaintext });
    await receivedFirst;
    if (mode === 'paused-resume') {
      await composer.getByRole('button', { name: 'Pause', exact: true }).click();
      await expect(composer.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
    }
    await publish(request, pair.peer, bobSeed);
    release();
    await expect(page.locator('.hc-header .hc-lockline')).toContainText('Encrypted in browser');
    await expect(page.getByTestId('upload')).toHaveCount(0);
    await expect(composer.getByRole('button', { name: 'Resume', exact: true })).toHaveCount(0);
    await expect(page.getByTestId('attached')).toHaveCount(0);
    await expect(page.getByRole('alert')).toContainText(copy.security.reattachEncrypted);
    // Cumulative assertion includes all requests from the start, rather than clearing at transition.
    expect(outbound.filter(row => row.method === 'PATCH').map(row => row.bytes)).toEqual([4 * 1024 * 1024]);
    expect(outbound.some(row => row.path.endsWith('/complete'))).toBe(false);
    await shots(page, `legacy-upload-${mode}`);
    // Reattachment still follows the actual encrypted composer path.
    const created = page.waitForRequest(req => req.method() === 'POST' && new URL(req.url()).pathname === '/api/uploads');
    await composer.locator('input[type="file"]').setInputFiles({ name: 'reattached.txt', mimeType: 'text/plain', buffer: Buffer.from('reattached encrypted positive path') });
    expect((await created).postDataJSON()).toMatchObject({ class: 'sealed', filename: 'sealed' });
    await expect(page.getByTestId('attached')).toContainText('reattached.txt');
    await context.close(); pair.service.dispose();
  });
}
