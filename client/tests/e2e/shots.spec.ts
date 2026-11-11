import { test, expect, type Browser } from "@playwright/test";
import { accept, invite, password, send, setupToken, signIn } from "./helpers";

// Evidence run: seeds invented people and messages, then captures the app.
// Runs with the shell spec: HOUSECALL_TEST_SHELL=1 npm run e2e
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
      await page.screenshot({ path: `${out}/main-${size}-${scheme}.png`, animations: "disabled" });
      await context.close();
    }

  for (const direction of ["b", "c"]) {
    const { context, page } = await open(browser, 1440, 900, "dark", `/?direction=${direction}`);
    await signIn(page, "owner");
    await expect(page.getByTestId("screen-conversation")).toContainText("good blanket");
    await page.screenshot({ path: `${out}/main-1440-dark-${direction}.png` });
    await context.close();
  }
  await seed.page.goto("/?direction=a");
  await seed.context.close();
});
