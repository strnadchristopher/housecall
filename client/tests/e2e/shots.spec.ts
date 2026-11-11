import { test, expect, type Browser } from "@playwright/test";
import { accept, invite, password, send, setupToken, signIn } from "./helpers";

// Evidence run: seeds invented people and messages, then captures the app.
// Rewrites the tracked PNGs in design/shots, so it has its own flag and never
// runs with the acceptance specs: HOUSECALL_TEST_SHOTS=1 npm run e2e
const out = "../design/shots";

async function open(browser: Browser, width: number, height: number, scheme: "dark" | "light", url = "/") {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, hasTouch: width < 600, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  await page.goto(url);
  return { context, page };
}

test("screenshots", async ({ browser }) => {
  test.setTimeout(240000);
  const seed = await open(browser, 1440, 900, "dark");
  // The shell spec shares this server and may already have set it up.
  const made = await seed.page.request.post("/api/setup", { data: { setup_token: setupToken, username: "owner", password, device_name: "fixture" } });
  if (made.status() === 409) await signIn(seed.page, "owner");
  else {
    expect(made.ok()).toBeTruthy();
    await seed.page.reload();
    await signIn(seed.page, "owner");
  }
  const link = await invite(seed.page);
  const friend = await open(browser, 1440, 900, "dark", link);
  await accept(friend.page, link, "mara");
  const lines: [typeof seed.page, string][] = [
    [seed.page, "Welcome in. The kettle is on."],
    [friend.page, "Thanks! Is the film still on for Friday?"],
    [seed.page, "Yes, 8 pm. Bring the good blanket."],
    [friend.page, "Done. @owner can you pin the plan?"],
  ];
  for (const [page, text] of lines) await send(page, text);
  await friend.context.close();

  // Invite screen as seen by the invitee (phone, both schemes).
  for (const scheme of ["dark", "light"] as const) {
    const invitee = await open(browser, 390, 844, scheme, link);
    await expect(invitee.page.getByLabel("Display name", { exact: true })).toBeVisible();
    await invitee.page.screenshot({ path: `${out}/invite-390-${scheme}.png` });
    await invitee.context.close();
  }

  for (const [width, height, size] of [[1440, 900, "1440"], [390, 844, "390"]] as const)
    for (const scheme of ["dark", "light"] as const) {
      const { context, page } = await open(browser, width, height, scheme);
      await expect(page.getByTestId("screen-sign-in")).toBeVisible();
      await page.screenshot({ path: `${out}/sign-in-${size}-${scheme}.png` });
      if (width < 600) {
        await page.getByLabel("Username", { exact: true }).fill("owner");
        await page.getByLabel("Password", { exact: true }).fill(password);
        await page.getByTestId("screen-sign-in").getByRole("button", { name: "Sign in", exact: true }).click();
        await expect(page.getByRole("button", { name: /^Open / }).first()).toBeVisible();
        await page.waitForTimeout(600);
        // A phone lands on the list first.
        await page.screenshot({ path: `${out}/list-${size}-${scheme}.png`, animations: "disabled" });
        await page.getByRole("button", { name: /^Open / }).first().click();
      } else await signIn(page, "owner");
      await expect(page.getByTestId("screen-conversation")).toContainText("good blanket");
      await page.waitForTimeout(600);
      // Park the pointer off the message list so no hover band or toolbar is in the shot.
      await page.mouse.move(2, 2);
      await page.screenshot({ path: `${out}/main-${size}-${scheme}.png`, animations: "disabled" });
      if (width >= 600 && scheme === "dark") {
        // Hover state, on purpose: the toolbar sits at the top right of the message, the day label stays clear.
        const first = page.locator(".hc-msg").first();
        await first.hover();
        await page.waitForTimeout(300);
        await page.screenshot({ path: `${out}/main-1440-dark-hover.png`, animations: "disabled" });
        await page.mouse.move(2, 2);
        // Settings and direct messages.
        await page.getByRole("button", { name: "Settings", exact: true }).click();
        await expect(page.getByTestId("screen-settings")).toBeVisible();
        await page.waitForTimeout(400);
        await page.screenshot({ path: `${out}/settings-1440-dark.png`, animations: "disabled" });
        await page.getByRole("button", { name: "Settings", exact: true }).click();
        await page.getByRole("button", { name: "Direct messages", exact: true }).click();
        await expect(page.getByTestId("screen-direct-messages")).toBeVisible();
        await page.waitForTimeout(400);
        await page.screenshot({ path: `${out}/dm-1440-dark.png`, animations: "disabled" });
        // Offline.
        await context.setOffline(true);
        await page.evaluate(() => window.dispatchEvent(new Event("offline")));
        await page.waitForTimeout(600);
        await page.screenshot({ path: `${out}/offline-1440-dark.png`, animations: "disabled" });
        await context.setOffline(false);
      }
      await context.close();
    }

  // The 1100 px breakpoint and phone landscape (844x390).
  for (const [width, height, name] of [[1100, 800, "1100"], [844, 390, "844x390"]] as const) {
    const { context, page } = await open(browser, width, height, "dark");
    await signIn(page, "owner");
    await expect(page.getByTestId("screen-conversation")).toContainText("good blanket");
    await page.waitForTimeout(600);
    await page.mouse.move(2, 2);
    await page.screenshot({ path: `${out}/main-${name}-dark.png`, animations: "disabled" });
    await context.close();
  }

  for (const direction of ["b", "c"]) {
    const { context, page } = await open(browser, 1440, 900, "dark", `/?direction=${direction}`);
    await signIn(page, "owner");
    await expect(page.getByTestId("screen-conversation")).toContainText("good blanket");
    await page.mouse.move(2, 2);
    await page.screenshot({ path: `${out}/main-1440-dark-${direction}.png` });
    await context.close();
  }
  // Direction C was the one with tinted surfaces; its light scheme is shot too.
  {
    const { context, page } = await open(browser, 1440, 900, "light", "/?direction=c");
    await signIn(page, "owner");
    await expect(page.getByTestId("screen-conversation")).toContainText("good blanket");
    await page.mouse.move(2, 2);
    await page.screenshot({ path: `${out}/main-1440-light-c.png` });
    await context.close();
  }
  await seed.page.goto("/?direction=a");
  await seed.context.close();
});
