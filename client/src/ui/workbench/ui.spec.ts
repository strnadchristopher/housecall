import { expect, test, type Page } from '@playwright/test';

/**
 * Drives client/src/App.tsx (engineering's adapter, unchanged) through the
 * designed UI against the in-memory fixture API. Selectors follow the
 * engineering E2E suite on purpose: accessible names and field labels from the
 * contract must survive the redesign.
 */

const SHOTS = '../evidence/ui/app';

async function signIn(page: Page, user = 'christopher', password = 'fixture-password-owner') {
  await page.goto('/');
  await expect(page.getByTestId('screen-login')).toBeVisible();
  await page.getByLabel('Username', { exact: true }).fill(user);
  await page.getByLabel('Password (at least 12 characters)').fill(password);
  await page.locator('button[type=submit]').click();
  await expect(page.getByTestId('screen-composer')).toBeVisible();
}

async function send(page: Page, body: string) {
  const box = page.getByTestId('screen-composer').getByLabel('Message', { exact: true });
  await box.fill(body);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByTestId('screen-conversation').getByText(body, { exact: false })).toBeVisible();
}

test('wrong password shows an alert and keeps the form', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Username', { exact: true }).fill('christopher');
  await page.getByLabel('Password (at least 12 characters)').fill('not-the-password');
  await page.locator('button[type=submit]').click();
  await expect(page.getByTestId('screen-login').getByRole('alert')).toContainText('Invalid username or password');
  await expect(page.getByLabel('Username', { exact: true })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/login-error.png` });
});

test('chat: send, mention autocomplete, reply, pin, edit, unsend, react', async ({ page }) => {
  await signIn(page);
  await page.getByRole('button', { name: 'Open movie-night', exact: true }).click();
  await expect(page.getByTestId('screen-conversation')).toContainText('ok who is actually free friday');

  await send(page, 'Fixture hello from the designed UI');

  // Mention autocomplete: App computes candidates from the draft; Enter picks the highlighted one.
  const box = page.getByTestId('screen-composer').getByLabel('Message', { exact: true });
  await box.pressSequentially('see you @ma');
  const option = page.getByRole('option', { name: 'Mention maya' });
  await expect(option).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/mention-autocomplete.png` });
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('screen-composer').getByLabel('Message', { exact: true })).toHaveValue('see you @maya ');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByTestId('screen-conversation')).toContainText('see you @maya');

  const row = () => page.getByTestId('screen-conversation').locator('li').filter({ hasText: 'Fixture hello from the designed UI' });
  await row().getByRole('button', { name: 'Reply', exact: true }).click();
  await expect(page.getByTestId('screen-composer')).toContainText('Replying to a message');
  await send(page, 'Fixture reply');
  await expect(page.getByTestId('screen-conversation')).toContainText('Fixture reply (reply)');

  await row().getByRole('button', { name: 'Pin', exact: true }).click();
  await expect(page.getByTestId('screen-conversation')).toContainText('Fixture hello from the designed UI (pinned)');

  await row().getByRole('button', { name: 'React 👍', exact: true }).click();
  await expect(row()).toContainText('👍');

  await row().getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByTestId('screen-composer').getByLabel('Message', { exact: true }).fill('Fixture edited message');
  await page.getByRole('button', { name: 'Save edit' }).click();
  await expect(page.getByTestId('screen-conversation')).toContainText('Fixture edited message');
  await page.screenshot({ path: `${SHOTS}/chat-after-actions.png` });

  const edited = page.getByTestId('screen-conversation').locator('li').filter({ hasText: 'Fixture edited message' });
  await edited.getByRole('button', { name: 'Unsend', exact: true }).click();
  await expect(page.getByTestId('screen-conversation')).not.toContainText('Fixture edited message');
});

test('composer /gimme routes to the Gimme intent, not a message', async ({ page }) => {
  await signIn(page);
  await page.getByRole('button', { name: 'Open movie-night', exact: true }).click();
  const box = page.getByTestId('screen-composer').getByLabel('Message', { exact: true });
  await box.fill('/gimme movie Arrival');
  await box.press('Enter');
  await expect(page.getByTestId('screen-conversation')).toContainText('Arrival: Preview saved — no provider request sent');
  await expect(page.getByTestId('screen-conversation').locator('li').filter({ hasText: '/gimme' })).toHaveCount(0);
  await expect(box).toHaveValue('');
  await page.screenshot({ path: `${SHOTS}/gimme-slash.png` });
});

test('navigation, theme switching, activity control, report, devices', async ({ page }) => {
  await signIn(page);
  await page.getByRole('button', { name: 'Capabilities', exact: true }).click();
  await page.getByRole('radio', { name: /Moss/ }).click();
  await expect(page.locator('html')).toHaveAttribute('data-cc-theme', 'moss');
  await page.screenshot({ path: `${SHOTS}/settings-moss.png` });
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-cc-theme', 'moss');
  await signIn(page);

  await page.getByRole('button', { name: 'Activity controls', exact: true }).click();
  await page.getByRole('button', { name: 'Start plex control session', exact: true }).click();
  await expect(page.getByTestId('screen-activities').locator('[data-item-id="snapshot"]')).toContainText('plex revision');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.getByTestId('screen-activities').locator('[data-item-id="snapshot"]')).toContainText('playing');
  await page.getByRole('button', { name: 'Forward 10 seconds' }).click();
  await expect(page.getByTestId('screen-activities')).toContainText('position 10000');
  await page.screenshot({ path: `${SHOTS}/activity-plex-fixture.png` });
  await page.getByRole('button', { name: 'Stop activity', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start dj control session', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back to conversation' }).click();

  await page.getByRole('button', { name: 'Report a problem', exact: true }).click();
  await page.getByLabel('Description', { exact: true }).fill('Fixture report from the UI suite');
  await page.getByRole('button', { name: 'Submit report', exact: true }).click();
  await expect(page.getByTestId('screen-composer')).toBeVisible();

  await page.getByRole('button', { name: 'Review reports', exact: true }).click();
  await expect(page.getByTestId('screen-reports-admin')).toContainText('Fixture report from the UI suite');
  await page.getByRole('button', { name: 'Resolve', exact: true }).click();
  await expect(page.getByTestId('screen-reports-admin')).toContainText('resolved');
  await page.getByRole('button', { name: 'Back to conversation' }).click();

  await page.getByRole('button', { name: 'Devices', exact: true }).click();
  await expect(page.getByTestId('screen-devices')).toContainText('(this device)');
  await page.screenshot({ path: `${SHOTS}/devices.png` });
});

test('every visible control has an accessible name', async ({ page }) => {
  await signIn(page);
  for (const nav of ['Voice and video','Activity controls', 'Upload file', 'Gimme request (dry run)', 'Capabilities', 'New DM', 'Issue invitation']) {
    await page.getByRole('button', { name: nav, exact: true }).click();
    const unnamed = await page.evaluate(() => Array.from(document.querySelectorAll('button, input, textarea, [role="option"], [role="radio"]'))
      .filter(el => (el as HTMLElement).offsetParent !== null || (el as HTMLElement).getClientRects().length)
      .filter(el => {
        const e = el as HTMLElement;
        const label = e.getAttribute('aria-label') || e.getAttribute('aria-labelledby') || (e.id && document.querySelector(`label[for="${CSS.escape(e.id)}"]`)) || e.closest('label') || e.textContent?.trim();
        return !label && (e as HTMLInputElement).type !== 'hidden' && !(e as HTMLInputElement).type?.startsWith('file');
      }).map(el => el.outerHTML.slice(0, 120)));
    expect(unnamed, `unnamed controls on ${nav}`).toEqual([]);
    const back = page.getByRole('button', { name: 'Back to conversation' });
    if (await back.count()) await back.click();
  }
});

test('@phone drawer navigation, tabs and composer', async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole('button', { name: 'Open navigation' })).toBeVisible();
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: 'Open movie-night', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open movie-night', exact: true })).toBeHidden();
  await expect(page.getByTestId('screen-conversation')).toContainText('ok who is actually free friday');
  await send(page, 'Fixture hello from a phone');
  await page.screenshot({ path: `${SHOTS}/phone-chat.png` });
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: 'Activity controls', exact: true }).click();
  await expect(page.getByTestId('screen-activities')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Chats' })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/phone-activities.png` });
  await page.getByRole('button', { name: 'Chats' }).click();
  await expect(page.getByTestId('screen-composer')).toBeVisible();
});
