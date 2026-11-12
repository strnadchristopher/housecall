import { expect, type Page } from "@playwright/test";

/** Fictional fixture people only. */
export const password = "correct horse battery staple";
export const setupToken = process.env.HOUSECALL_SETUP_TOKEN ?? "test-setup-token-at-least-32-characters";

export async function setup(page: Page, name: string) {
  await page.goto("/");
  await page.getByRole("button", { name: "Set up a new server" }).click();
  await page.getByLabel("Setup token").fill(setupToken);
  await page.getByLabel("Username", { exact: true }).fill(name);
  await page.getByLabel("Password, 12 or more characters").fill(password);
  await page.getByRole("button", { name: "Set up server", exact: true }).click();
  await expect(page.getByTestId("screen-composer")).toBeVisible();
}

/**
 * From any signed-out screen, get to a Log in form for `name` with only the password left to type:
 * Welcome → Log in, then the remembered account (picked, listed, or "Use another account").
 */
export async function openSignIn(page: Page, name: string) {
  const screen = page.getByTestId("screen-sign-in");
  const welcome = page.getByTestId("screen-welcome");
  await expect(screen.or(welcome)).toBeVisible();
  if (await welcome.isVisible()) await welcome.getByRole("button", { name: "Log in", exact: true }).click();
  await expect(screen).toBeVisible();
  const picked = screen.getByTestId("sign-in-account");
  if (await picked.isVisible() && (await picked.innerText()) !== name) await screen.getByRole("button", { name: "Not you?" }).click();
  if (!(await picked.isVisible())) {
    const row = screen.getByRole("button", { name, exact: true });
    const other = screen.getByRole("button", { name: "Use another account", exact: true });
    if (await row.isVisible()) await row.click();
    else if (await other.isVisible()) await other.click();
  }
  const username = screen.getByLabel("Username", { exact: true });
  if (await username.isVisible()) await username.fill(name);
}

/** Fills the Log in form for `name` (see openSignIn); the caller presses Log in. */
export async function fillSignIn(page: Page, name: string, secret = password) {
  await openSignIn(page, name);
  await page.getByTestId("screen-sign-in").getByLabel("Password", { exact: true }).fill(secret);
}

export function logInButton(page: Page) {
  return page.getByTestId("screen-sign-in").getByRole("button", { name: "Log in", exact: true });
}

export async function signIn(page: Page, name: string, secret = password) {
  await fillSignIn(page, name, secret);
  await logInButton(page).click();
  await expect(page.getByTestId("screen-composer")).toBeVisible();
}

/** Owner creates an invite from Server settings (Invites) and returns the copyable link. */
export async function invite(page: Page): Promise<string> {
  await page.getByRole("button", { name: "Server settings", exact: true }).click();
  const settings = page.getByTestId("screen-settings");
  // Phones open the settings root; wide screens open a section beside the list.
  if (!(await settings.getByTestId("screen-invites").isVisible())) await settings.getByRole("button", { name: "Invites", exact: true }).click();
  const screen = page.getByTestId("screen-invites");
  await screen.getByRole("button", { name: "Create invite", exact: true }).click();
  const link = page.getByTestId("invite-link");
  await expect(link).toHaveValue(/#invite=[a-f0-9]{64}$/);
  const value = await link.inputValue();
  const close = settings.getByRole("button", { name: "Close", exact: true });
  if (await close.isVisible()) await close.click();
  else {
    await settings.getByRole("button", { name: "Settings", exact: true }).click();
    await settings.getByRole("button", { name: "Back", exact: true }).click();
  }
  return value;
}

export async function accept(page: Page, link: string, name: string) {
  await page.goto(link);
  await page.getByLabel("Username", { exact: true }).fill(name);
  await page.getByLabel("Password, 12 or more characters").fill(password);
  await page.getByRole("button", { name: "Join", exact: true }).click();
  await expect(page.getByTestId("screen-composer")).toBeVisible();
}

/** On a phone the conversation list lives in the drawer: open it. Does nothing on wide screens. */
export async function openMenu(page: Page) {
  const menu = page.getByRole("button", { name: "Menu", exact: true });
  if (await menu.isVisible().catch(() => false)) {
    await menu.click();
    await expect(page.locator(".hc-shell")).toHaveAttribute("data-screen", "list");
  }
}

export async function send(page: Page, body: string) {
  await page.getByTestId("screen-composer").getByLabel("Message", { exact: true }).fill(body);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("screen-conversation").getByText(body, { exact: false }).first()).toBeVisible();
}

/** The message row whose own body (not a quoted reply) contains the text. */
export function row(page: Page, text: string) {
  return page.getByTestId("screen-conversation").locator("li[data-message-id]").filter({ has: page.locator(".hc-md", { hasText: text }) });
}

export async function act(page: Page, text: string, action: string) {
  const target = row(page, text);
  await target.hover();
  await target.getByRole("button", { name: action, exact: true }).click();
}
