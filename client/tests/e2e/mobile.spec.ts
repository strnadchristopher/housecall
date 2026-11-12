import { test, expect, type Page } from "@playwright/test";
import { password, setupToken } from "./helpers";

const phone = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const notch = ":root { --hc-safe-top: 47px; --hc-safe-bottom: 34px; }";

/** Setup on a phone, then into the chat (until the phone opens straight into it). */
async function setupOnPhone(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Set up a new server" }).click();
  await page.getByLabel("Setup token").fill(setupToken);
  await page.getByLabel("Username", { exact: true }).fill("owner");
  await page.getByLabel("Password, 12 or more characters").fill(password);
  await page.getByRole("button", { name: "Set up server", exact: true }).click();
  await expect(page.getByTestId("screen-conversation")).toBeAttached();
  const general = page.getByRole("button", { name: "Open general", exact: true });
  if (await general.isVisible()) await general.click();
  await expect(page.getByTestId("screen-composer")).toBeVisible();
}

test("phone: content runs behind the status bar, controls stay clear of it", async ({ browser }) => {
  const context = await browser.newContext(phone);
  const page = await context.newPage();
  await setupOnPhone(page);
  await page.addStyleTag({ content: notch });
  const root = page.locator(".hc-root");
  await expect(root).toHaveCSS("padding-top", "0px");
  const header = page.locator(".hc-center .hc-header").first();
  const box = await header.boundingBox();
  expect(box?.y).toBe(0);                                 // header colour reaches the top edge
  await expect(header).toHaveCSS("padding-top", "51px");  // 47 inset + 4 (space-1)
  await expect(page.locator(".hc-center")).toHaveCSS("padding-bottom", "34px");
  await context.close();
});
