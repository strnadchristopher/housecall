import { mkdir } from "node:fs/promises";
import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { password, setupToken, signIn } from "./helpers";

/**
 * Screenshots of UI part 2: every new onboarding screen, the launch state, confirm-join, Invites, Access requests
 * and the member's Invite people page, at 390x844 (dark and light) and 1280x800 (dark). Synthetic accounts only.
 * Run on purpose: node tests/run-e2e.mjs UISHOTS_PART_TWO (writes docs/ux/mobile-after-part2).
 */
const out = "../docs/ux/mobile-after-part2";
const origin = "http://localhost:1420";
const api = "http://127.0.0.1:3031";
const variants = [
  { tag: "390-dark", viewport: { width: 390, height: 844 }, scheme: "dark" as const },
  { tag: "390-light", viewport: { width: 390, height: 844 }, scheme: "light" as const },
  { tag: "1280-dark", viewport: { width: 1280, height: 800 }, scheme: "dark" as const },
];
type Variant = (typeof variants)[number];

async function context(browser: Browser, v: Variant, storage?: Record<string, unknown>) {
  const phone = v.viewport.width < 500;
  const ctx = await browser.newContext({ viewport: v.viewport, colorScheme: v.scheme, deviceScaleFactor: 2, ...(phone ? { hasTouch: true, isMobile: true } : {}) });
  if (storage) await ctx.addInitScript(values => { for (const [key, value] of Object.entries(values)) localStorage.setItem(key, JSON.stringify(value)); }, storage);
  return ctx;
}
const shot = async (page: Page, name: string, v: Variant) => {
  await page.waitForTimeout(1300);
  await page.screenshot({ path: `${out}/${name}-${v.tag}.png`, animations: "disabled" });
};

test("ui shots: part 2", async ({ browser, request }) => {
  test.setTimeout(600000);
  await mkdir(out, { recursive: true });
  const auth = await (await request.post(`${api}/api/setup`, { data: { setup_token: setupToken, username: "owner", password, device_name: "fixture" } })).json();
  const headers = { authorization: `Bearer ${auth.token}`, "x-device-key": auth.device_key };
  await request.patch(`${api}/api/servers/home`, { headers, data: { name: "Maple Street" } });
  await request.patch(`${api}/api/me`, { headers, data: { display_name: "Alex" } });
  const invite = await (await request.post(`${api}/api/invites`, { headers, data: { expires_in_seconds: null, max_uses: null } })).json();
  const member = await (await request.post(`${api}/api/invites/accept`, { data: { token: invite.token, username: "linda", password, device_name: "fixture" } })).json();
  expect(member.token).toBeTruthy();
  const rosa = await (await request.post(`${api}/api/access-requests`, { data: { username: "rosa", password, device_name: "fixture", message: "Linda's sister. We met at the reunion!" } })).json();
  const tom = await (await request.post(`${api}/api/access-requests`, { data: { username: "tom", password, device_name: "fixture" } })).json();
  await request.post(`${api}/api/access-requests/${tom.id}/approve`, { headers, data: {} });
  const now = Date.now();
  const pending = [
    { origin, id: rosa.id, username: "rosa", serverName: "Maple Street", createdAt: now },
    { origin, id: tom.id, username: "tom", serverName: "Maple Street", createdAt: now - 1000 },
  ];
  // One server for the confirm-join shots, created once; every variant answers Not now.
  const club = await (await request.post(`${api}/api/servers`, { headers, data: { name: "Book club" } })).json();
  const clubInvite = await (await request.post(`${api}/api/invites`, { headers, data: { expires_in_seconds: 3600, max_uses: null, server_id: club.id } })).json();
  const remembered = (names: string[]) => names.map((username, index) => ({ origin, username, usedAt: now - index }));

  for (const v of variants) {
    // Welcome, sign up, the server's door, request access.
    let ctx = await context(browser, v);
    let page = await ctx.newPage();
    await page.goto("/");
    await expect(page.getByTestId("screen-welcome")).toBeVisible();
    await shot(page, "welcome", v);
    await page.getByRole("button", { name: "Sign up", exact: true }).click();
    await shot(page, "sign-up", v);
    await page.getByLabel("Server address, invite code or link").fill("hc1.not-a-real-code");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await shot(page, "sign-up-error", v);
    await page.getByLabel("Server address, invite code or link").fill("localhost:1420");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByTestId("screen-server")).toBeVisible();
    await shot(page, "server", v);
    await page.getByRole("button", { name: "Request access", exact: true }).click();
    await page.getByLabel("Username", { exact: true }).fill("rosa");
    await page.getByLabel("Password, 12 or more characters").fill(password);
    await page.getByLabel("Message to the owner").fill("Linda's sister");
    await shot(page, "request", v);
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await page.getByRole("button", { name: "Set up a new server" }).click();
    await shot(page, "setup", v);
    await ctx.close();

    // Join from an invite link.
    ctx = await context(browser, v);
    page = await ctx.newPage();
    await page.goto(invite.link);
    await expect(page.getByTestId("screen-join")).toContainText("Maple Street");
    await shot(page, "join", v);
    await ctx.close();

    // Pending requests (one waiting, one approved), and Welcome offering them.
    ctx = await context(browser, v, { "hc-pending-v1": pending });
    page = await ctx.newPage();
    await page.goto("/");
    await shot(page, "welcome-pending", v);
    await page.getByRole("button", { name: "Pending requests" }).click();
    await expect(page.getByTestId("screen-pending")).toContainText("Approved");
    await shot(page, "pending", v);
    await ctx.close();

    // Log in: one remembered account (picked), and two (a list).
    ctx = await context(browser, v, { "hc-remembered-v1": remembered(["linda"]) });
    page = await ctx.newPage();
    await page.goto("/");
    await expect(page.getByTestId("sign-in-account")).toHaveText("linda");
    await shot(page, "sign-in", v);
    await ctx.close();
    ctx = await context(browser, v, { "hc-remembered-v1": remembered(["linda", "owner"]) });
    page = await ctx.newPage();
    await page.goto("/");
    await shot(page, "sign-in-accounts", v);
    await ctx.close();

    // A native cold start reopening a stored session: the quiet launch state.
    ctx = await context(browser, v);
    await ctx.addInitScript(() => {
      Object.assign(window, { __TAURI_INTERNALS__: { invoke: (command: string) => command === "plugin:secure-session|list" ? new Promise(() => {}) : Promise.reject(new Error("Unexpected command")) } });
    });
    page = await ctx.newPage();
    await page.goto("/");
    await expect(page.getByTestId("screen-launch")).toBeVisible();
    await shot(page, "launch", v);
    await ctx.close();

    // Owner: confirm-join from an outside link, Invites, Access requests.
    ctx = await context(browser, v);
    page = await ctx.newPage();
    await page.goto("/");
    await signIn(page, "owner");
    await page.evaluate(token => { location.hash = `#invite=${token}`; }, clubInvite.token);
    await expect(page.getByTestId("confirm-join")).toBeVisible();
    await shot(page, "confirm-join", v);
    await page.getByRole("button", { name: "Not now" }).click();
    await openSettings(page, "Invites");
    await page.getByLabel("Can be used").selectOption("5");
    await page.getByLabel("Expires").selectOption("2592000");
    await page.getByRole("button", { name: "Create invite", exact: true }).click();
    await expect(page.getByTestId("invite-code")).toHaveValue(/^hc1\./);
    await shot(page, "invites", v);
    await page.getByTestId("active-invites").getByRole("button", { name: "Revoke" }).first().click();
    await shot(page, "invites-revoke", v);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await openSettings(page, "Access requests");
    await expect(page.getByTestId("screen-access")).toContainText("rosa");
    await shot(page, "access", v);
    await backToRoot(page);
    await shot(page, "settings-root", v);
    await ctx.close();

    // A member: Invite people says who to ask.
    ctx = await context(browser, v);
    page = await ctx.newPage();
    await page.goto("/");
    await signIn(page, "linda");
    await openSettings(page, "Invite people");
    await shot(page, "invite-people", v);
    await ctx.close();
  }
});

async function openSettings(page: Page, row: string) {
  const settings = page.getByTestId("screen-settings");
  if (!(await settings.isVisible())) await page.getByRole("button", { name: "Server settings" }).click();
  const back = settings.getByRole("button", { name: "Settings", exact: true });
  if (await back.isVisible()) await back.click();
  await settings.getByRole("button", { name: row, exact: true }).click();
}
async function backToRoot(page: Page) {
  const back = page.getByTestId("screen-settings").getByRole("button", { name: "Settings", exact: true });
  if (await back.isVisible()) await back.click();
}
export type { BrowserContext };
