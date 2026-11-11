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

export async function signIn(page: Page, name: string) {
  await page.getByLabel("Username", { exact: true }).fill(name);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByTestId("screen-sign-in").getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByTestId("screen-composer")).toBeVisible();
}

/** Owner creates an invite from Server settings and returns the copyable link. */
export async function invite(page: Page): Promise<string> {
  await page.getByRole("button", { name: "Server settings", exact: true }).click();
  const screen = page.getByTestId("screen-invites");
  await screen.getByRole("button", { name: "Create invite link" }).click();
  const link = page.getByTestId("invite-link");
  await expect(link).toHaveValue(/#invite=[a-f0-9]{64}$/);
  const value = await link.inputValue();
  await page.getByTestId("screen-settings").getByRole("button", { name: "Close", exact: true }).click();
  return value;
}

export async function accept(page: Page, link: string, name: string) {
  await page.goto(link);
  await page.getByLabel("Display name", { exact: true }).fill(name);
  await page.getByLabel("Password, 12 or more characters").fill(password);
  await page.getByRole("button", { name: "Join", exact: true }).click();
  await expect(page.getByTestId("screen-composer")).toBeVisible();
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
