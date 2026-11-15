import { test, expect, type Page } from "@playwright/test";
import { setup, signIn } from "./helpers";

/** The server is shared across this file: the first test sets it up, the rest sign in as that owner. */
async function signInOwner(page: Page) {
  await page.goto("/");
  await signIn(page, "owner");
}

const phone = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const notch = ":root { --hc-safe-top: 47px; --hc-safe-bottom: 34px; }";

test("phone: content runs behind the status bar, controls stay clear of it", async ({ browser }) => {
  const context = await browser.newContext(phone);
  const page = await context.newPage();
  await setup(page, "owner");
  await page.addStyleTag({ content: notch });
  const root = page.locator(".hc-root");
  await expect(root).toHaveCSS("padding-top", "0px");
  const header = page.locator(".hc-center .hc-header").first();
  const box = await header.boundingBox();
  const notice = page.locator(".hc-security-notice");
  await expect(notice).toBeVisible();
  const noticeBox = (await notice.boundingBox())!;
  expect(noticeBox.y).toBe(0); // the first painted surface reaches the top edge
  await expect(notice).toHaveCSS("padding-top", "55px"); // safe inset consumed once
  expect(box?.y).toBeCloseTo(noticeBox.y + noticeBox.height, 0);
  await expect(header).toHaveCSS("padding-top", "4px");
  const menuBox = (await header.getByRole("button", { name: "Menu", exact: true }).boundingBox())!;
  expect(menuBox.y).toBeGreaterThanOrEqual(noticeBox.y + noticeBox.height);
  await expect(page.locator(".hc-center")).toHaveCSS("padding-bottom", "34px");
  // The drawer clears the status bar too.
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await expect(page.locator(".hc-left")).toHaveCSS("padding-top", "8px"); // notice already consumes the top inset
  await context.close();
});

test("phone: opens in the chat; hamburger drawer; rows look tappable", async ({ browser }) => {
  const context = await browser.newContext(phone);
  const page = await context.newPage();
  await signInOwner(page);
  await expect(page.locator(".hc-center .hc-header h1")).toHaveText("general");
  await expect(page.locator(".hc-left")).toBeHidden();
  const menu = page.getByRole("button", { name: "Menu", exact: true });
  await expect(menu).toBeVisible();
  await expect(page.locator(".hc-center .hc-header").getByRole("button", { name: "Back" })).toHaveCount(0);
  await menu.click();
  await expect(page.locator(".hc-left")).toBeVisible();
  const row = page.getByRole("button", { name: "Open general" });
  await expect(row).toBeFocused();                       // focus moves into the drawer, onto where you are
  const bg = await row.evaluate(el => getComputedStyle(el.parentElement!).backgroundColor);   // the current row is a wash of ink
  expect(bg).not.toBe("rgba(0, 0, 0, 0)");
  expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(48);   // the stretched button is the whole row
  // Tap the dimmed conversation showing beside the drawer.
  await page.getByRole("button", { name: "Close menu" }).click({ position: { x: 370, y: 420 } });
  await expect(page.locator(".hc-left")).toBeHidden();
  await expect(menu).toBeFocused();                      // and back to the button that opened it
  await menu.click();
  await page.keyboard.press("Escape");
  await expect(page.locator(".hc-left")).toBeHidden();
  await menu.click();
  await row.click();
  await expect(page.locator(".hc-left")).toBeHidden();
  await expect(page.getByTestId("screen-composer")).toBeVisible();
  // Settings, closed from its root, goes back to the chat, not to the drawer.
  await page.getByRole("button", { name: "Server settings" }).click();
  await page.getByTestId("screen-settings").getByRole("button", { name: "Back" }).click();
  await expect(page.getByTestId("screen-composer")).toBeVisible();
  await expect(page.locator(".hc-left")).toBeHidden();
  await context.close();
});

test("phone: drag the drawer to close it", async ({ browser }) => {
  const context = await browser.newContext({ ...phone, hasTouch: false, isMobile: false });
  const page = await context.newPage();
  await signInOwner(page);
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  const drawer = page.locator(".hc-left");
  await expect(drawer).toBeVisible();
  // A short drag snaps back open.
  await page.mouse.move(200, 400);
  await page.mouse.down();
  await page.mouse.move(170, 402, { steps: 4 });
  await page.waitForTimeout(400); // held, not flicked
  await page.mouse.up();
  await expect(page.locator(".hc-shell")).toHaveAttribute("data-screen", "list");
  // A long one closes it.
  await page.mouse.move(250, 400);
  await page.mouse.down();
  await page.mouse.move(60, 405, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator(".hc-shell")).toHaveAttribute("data-screen", "main");
  await expect(drawer).toBeHidden();
  await context.close();
});

test("phone: settings drill down like iOS; accent changes the app", async ({ browser }) => {
  const context = await browser.newContext(phone);
  const page = await context.newPage();
  await signInOwner(page);
  await page.getByRole("button", { name: "Server settings" }).click();
  const settings = page.getByTestId("screen-settings");
  await expect(settings).toHaveAttribute("data-depth", "root");
  for (const name of ["Profile", "Appearance", "Notifications", "Invites", "About"])
    await expect(settings.getByRole("button", { name, exact: true })).toBeVisible();
  // Every row is a full-width tappable surface with a chevron.
  const invites = settings.getByRole("button", { name: "Invites", exact: true });
  expect((await invites.boundingBox())!.height).toBeGreaterThanOrEqual(48);
  await expect(invites.locator(".hc-navrow__chev")).toBeVisible();
  await invites.click();
  await expect(settings).toHaveAttribute("data-depth", "detail");
  await expect(settings.locator(".hc-header h1")).toHaveText("Invites");
  await expect(page.getByTestId("screen-invites")).toBeVisible();
  await settings.getByRole("button", { name: "Settings" }).click();      // back to the root
  await expect(settings).toHaveAttribute("data-depth", "root");
  await settings.getByRole("button", { name: "Appearance", exact: true }).click();
  const before = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--hc-accent").trim());
  await page.getByRole("radio", { name: "Mint" }).click();
  await expect(page.getByRole("radio", { name: "Mint" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("radio", { name: "Lavender" })).toHaveAttribute("aria-checked", "false");
  const after = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--hc-accent").trim());
  expect(after).not.toBe(before);
  // Arrow keys move the choice, like any radio group.
  await page.getByRole("radio", { name: "Mint" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("radio", { name: "Rose" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("radio", { name: "Rose" })).toBeFocused();
  await page.getByRole("radio", { name: "Mint" }).click();
  await page.reload();
  expect(await page.evaluate(() => document.documentElement.dataset.accent)).toBe("mint");
  await context.close();
});

test("wide: settings keep the two-column list and pane", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await signInOwner(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByTestId("screen-settings");
  await expect(settings).toHaveAttribute("data-depth", "detail");
  await expect(settings.getByRole("button", { name: "Profile", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("screen-account")).toBeVisible();
  await settings.getByRole("button", { name: "Appearance", exact: true }).click();
  await expect(page.getByTestId("screen-appearance")).toBeVisible();
  await expect(settings.getByRole("button", { name: "Appearance", exact: true })).toHaveAttribute("aria-current", "page");
  await settings.getByRole("button", { name: "Close", exact: true }).click();
  await expect(settings).toHaveCount(0);
  await context.close();
});
