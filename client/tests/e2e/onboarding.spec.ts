import { test, expect, type Page } from "@playwright/test";
import { password, setup, signIn } from "./helpers";

/**
 * Onboarding end to end on a phone (390x844): Welcome, Sign up with a pasted code, Log in with a remembered
 * account, reopening the last chat, redeeming a code while signed in, confirming an outside invite link, and
 * Request access through to the owner's approval. One server is shared by the tests in this file, in order.
 * Synthetic accounts only.
 */
const phone = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const api = "http://127.0.0.1:3031";
let headers: Record<string, string> = {};

const title = (page: Page) => page.locator(".hc-center .hc-header h1");

async function ownerWithAuth(page: Page) {
  const response = page.waitForResponse(r => r.url().endsWith("/api/setup") && r.request().method() === "POST");
  await setup(page, "owner");
  const auth = await (await response).json() as { token: string; device_key: string };
  headers = { authorization: `Bearer ${auth.token}`, "x-device-key": auth.device_key };
}

test("onboarding: welcome, code sign-up into general, return to last chat, signed-in redeem, outside link", async ({ browser }) => {
  test.setTimeout(180000);
  const ownerCtx = await browser.newContext(phone);
  const owner = await ownerCtx.newPage();
  await owner.goto("/");
  const welcome = owner.getByTestId("screen-welcome");
  await expect(welcome).toBeVisible();
  // Full screen: no card, the page itself.
  await expect(owner.locator(".hc-onb__screen")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  for (const name of ["Sign up", "Log in", "Set up a new server"]) await expect(welcome.getByRole("button", { name, exact: true })).toBeVisible();
  await ownerWithAuth(owner);
  // First sign-in opens the general chat, not a list.
  await expect(title(owner)).toHaveText("general");

  // Owner makes a multi-use, never-expiring invite through the settings tree.
  await owner.getByRole("button", { name: "Server settings" }).click();
  await owner.getByTestId("screen-settings").getByRole("button", { name: "Invites", exact: true }).click();
  await owner.getByLabel("Can be used").selectOption("unlimited");
  await owner.getByLabel("Expires").selectOption("never");
  await owner.getByRole("button", { name: "Create invite", exact: true }).click();
  const code = await owner.getByTestId("invite-code").inputValue();
  expect(code).toMatch(/^hc1\.[A-Za-z0-9_-]+\.[a-f0-9]{64}$/);
  await expect(owner.getByTestId("invite-link")).toHaveValue(/#invite=[a-f0-9]{64}$/);
  const active = owner.getByTestId("active-invites");
  await expect(active).toContainText("Never expires");
  await expect(active).toContainText("Unlimited");

  // A new person signs up with only the code, and lands in general.
  const bobCtx = await browser.newContext(phone);
  const bob = await bobCtx.newPage();
  await bob.goto("/");
  await bob.getByRole("button", { name: "Sign up", exact: true }).click();
  await expect(bob.getByTestId("screen-sign-up")).toBeVisible();
  await bob.getByLabel("Server address, invite code or link").fill(code);
  await bob.getByRole("button", { name: "Continue" }).click();
  const join = bob.getByTestId("screen-join");
  await expect(join).toBeVisible();
  await expect(join.getByRole("heading", { level: 1 })).toHaveText(/^Join /);
  await expect(join).toContainText("localhost:1420");
  await bob.getByLabel("Username", { exact: true }).fill("bob");
  await bob.getByLabel("Password, 12 or more characters").fill(password);
  await bob.getByRole("button", { name: "Join", exact: true }).click();
  await expect(title(bob)).toHaveText("general");

  // A second channel, opened, then a cold reload: Log in is prefilled and reopens that channel.
  await owner.request.post(`${api}/api/channels`, { headers, data: { name: "random", kind: "channel", member_ids: [] } });
  await owner.reload();
  const signInScreen = owner.getByTestId("screen-sign-in");
  await expect(signInScreen).toBeVisible();
  await expect(signInScreen.getByTestId("sign-in-account")).toHaveText("owner");
  await expect(signInScreen.getByLabel("Username", { exact: true })).toHaveCount(0);
  await owner.getByLabel("Password", { exact: true }).fill(password);
  await signInScreen.getByRole("button", { name: "Log in", exact: true }).click();
  await expect(title(owner)).toHaveText("general");
  await owner.getByRole("button", { name: "Menu" }).click();
  await owner.getByRole("button", { name: "Open random" }).click();
  await expect(title(owner)).toHaveText("random");
  await owner.reload();
  await owner.getByLabel("Password", { exact: true }).fill(password);
  await owner.getByTestId("screen-sign-in").getByRole("button", { name: "Log in", exact: true }).click();
  await expect(title(owner)).toHaveText("random");

  // Signed-in redeem: bob pastes a code for another server on the same host and is let straight in.
  const club = await (await owner.request.post(`${api}/api/servers`, { headers, data: { name: "Book club" } })).json();
  const invite = await (await owner.request.post(`${api}/api/invites`, { headers, data: { expires_in_seconds: 3600, server_id: club.id } })).json();
  await bob.getByRole("button", { name: "Menu" }).click();
  await bob.getByRole("button", { name: /^Servers:/ }).click();
  await bob.getByRole("option", { name: /Add server/ }).click();
  await bob.getByLabel("Invite code or link").fill(invite.code);
  await bob.getByRole("button", { name: "Connect" }).click();
  await expect(bob.getByRole("button", { name: /^Servers: Book club/ })).toBeVisible();

  // An invite link from outside while signed in never joins silently: one confirmation first.
  const garden = await (await owner.request.post(`${api}/api/servers`, { headers, data: { name: "Garden" } })).json();
  const gardenInvite = await (await owner.request.post(`${api}/api/invites`, { headers, data: { expires_in_seconds: 3600, server_id: garden.id } })).json();
  await bob.evaluate(token => { location.hash = `#invite=${token}`; }, gardenInvite.token);
  const confirm = bob.getByTestId("confirm-join");
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText("localhost:1420");
  await expect(bob.getByRole("alertdialog")).toBeVisible();
  // Not now leaves everything as it was; a second link asks again and Join goes in.
  await confirm.getByRole("button", { name: "Not now" }).click();
  await expect(confirm).toHaveCount(0);
  await expect(bob.getByRole("button", { name: /^Servers: Book club/ })).toBeAttached();
  await bob.evaluate(token => { location.hash = `#invite=${token}`; }, gardenInvite.token);
  await bob.getByTestId("confirm-join").getByRole("button", { name: "Join", exact: true }).click();
  await expect(bob.getByRole("button", { name: /^Servers: Garden/ })).toBeAttached();
  expect(bob.url()).not.toContain("invite=");
  await ownerCtx.close();
  await bobCtx.close();
});

test("onboarding: request access, owner approves, requester logs in", async ({ browser }) => {
  test.setTimeout(120000);
  const carolCtx = await browser.newContext(phone);
  const carol = await carolCtx.newPage();
  await carol.goto("/");
  await carol.getByRole("button", { name: "Sign up", exact: true }).click();
  await carol.getByLabel("Server address, invite code or link").fill("http://localhost:1420");
  await carol.getByRole("button", { name: "Continue" }).click();
  const door = carol.getByTestId("screen-server");
  await expect(door).toBeVisible();
  await expect(door.getByRole("heading", { level: 1 })).toHaveText(/^Join /);
  await door.getByRole("button", { name: "Request access", exact: true }).click();
  await expect(carol.getByTestId("screen-request")).toBeVisible();
  await carol.getByLabel("Username", { exact: true }).fill("carol");
  await carol.getByLabel("Password, 12 or more characters").fill(password);
  await carol.getByLabel("Message to the owner").fill("Bob's sister");
  await carol.getByRole("button", { name: "Send request", exact: true }).click();
  const pending = carol.getByTestId("screen-pending");
  await expect(pending).toBeVisible();
  await expect(pending).toContainText("Waiting for approval");
  // The request survives a reload: Welcome offers it.
  await carol.reload();
  await carol.getByTestId("screen-welcome").getByRole("button", { name: "Pending requests" }).click();
  await expect(carol.getByTestId("screen-pending")).toContainText("Waiting for approval");

  // The owner sees the badge, opens Access requests and approves.
  const ownerCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const owner = await ownerCtx.newPage();
  await owner.goto("/");
  await signIn(owner, "owner");
  await owner.getByRole("button", { name: "Server settings" }).click();
  const settings = owner.getByTestId("screen-settings");
  const row = settings.getByRole("button", { name: "Access requests", exact: true });
  await expect(row).toContainText("1");
  await row.click();
  const requests = owner.getByTestId("screen-access");
  await expect(requests).toContainText("carol");
  await expect(requests).toContainText("Bob's sister");
  await expect(requests.getByRole("switch", { name: "Let people request access" })).toBeChecked();
  await requests.getByRole("button", { name: "Approve carol", exact: true }).click();
  await expect(requests).not.toContainText("Bob's sister");
  await expect(row).not.toContainText("1");

  // Carol refreshes, sees Approved, logs in with her name already there, and lands in general.
  await carol.getByTestId("screen-pending").getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(carol.getByTestId("screen-pending")).toContainText("Approved");
  await carol.getByTestId("screen-pending").getByRole("button", { name: "Log in", exact: true }).click();
  const signInScreen = carol.getByTestId("screen-sign-in");
  await expect(signInScreen.getByTestId("sign-in-account")).toHaveText("carol");
  await carol.getByLabel("Password", { exact: true }).fill(password);
  await signInScreen.getByRole("button", { name: "Log in", exact: true }).click();
  await expect(title(carol)).toHaveText("general");
  await ownerCtx.close();
  await carolCtx.close();
});

test("onboarding: a closed server says so; Back walks the way you came", async ({ browser }) => {
  const ownerCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const owner = await ownerCtx.newPage();
  await owner.goto("/");
  await signIn(owner, "owner");
  await owner.getByRole("button", { name: "Server settings" }).click();
  await owner.getByTestId("screen-settings").getByRole("button", { name: "Access requests", exact: true }).click();
  await owner.getByRole("switch", { name: "Let people request access" }).uncheck();
  await expect(owner.getByRole("switch", { name: "Let people request access" })).not.toBeChecked();

  const context = await browser.newContext(phone);
  const page = await context.newPage();
  await page.goto("/");
  await page.getByRole("button", { name: "Sign up", exact: true }).click();
  await page.getByLabel("Server address, invite code or link").fill("localhost:1420");
  await page.getByRole("button", { name: "Continue" }).click();
  const door = page.getByTestId("screen-server");
  await expect(door).toContainText("This server is invite-only. Ask the owner for a code.");
  await expect(door.getByRole("button", { name: "Request access" })).toHaveCount(0);
  // A wrong code is explained in words, not a code.
  await page.getByLabel("Invite code", { exact: true }).fill("not-a-code");
  await door.getByRole("button", { name: "Continue" }).click();
  await expect(door.getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByTestId("screen-sign-up")).toBeVisible();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByTestId("screen-welcome")).toBeVisible();
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  await page.getByRole("button", { name: "New here? Sign up" }).click();
  await expect(page.getByTestId("screen-sign-up")).toBeVisible();

  await owner.getByRole("switch", { name: "Let people request access" }).check();
  await expect(owner.getByRole("switch", { name: "Let people request access" })).toBeChecked();
  await context.close();
  await ownerCtx.close();
});
