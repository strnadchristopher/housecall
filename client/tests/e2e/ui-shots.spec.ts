import { mkdir } from "node:fs/promises";
import { test, expect, type Browser, type Page } from "@playwright/test";
import { accept, invite, openMenu, send, setup, signIn } from "./helpers";

/**
 * Screenshots of the mobile UI work (part 1): chat, drawer, settings root and a section, Appearance in
 * Lavender and Mint, at 390x844 and 1280x800, dark and light. Synthetic accounts and messages only.
 * Run on purpose: node tests/run-e2e.mjs UISHOTS (writes docs/ux/mobile-after-part1).
 */
const out = "../docs/ux/mobile-after-part1";
const sizes = [["390", { width: 390, height: 844 }], ["1280", { width: 1280, height: 800 }]] as const;
const schemes = ["dark", "light"] as const;

async function open(browser: Browser, size: { width: number; height: number }, scheme: "dark" | "light") {
  const phone = size.width < 500;
  const context = await browser.newContext({ viewport: size, colorScheme: scheme, deviceScaleFactor: 2, ...(phone ? { hasTouch: true, isMobile: true } : {}) });
  const page = await context.newPage();
  await page.goto("/");
  await signIn(page, "owner");
  return { context, page, phone };
}
const shot = (page: Page, name: string) => page.waitForTimeout(450).then(() => page.screenshot({ path: `${out}/${name}.png`, animations: "disabled" }));

test("ui shots: part 1", async ({ browser }) => {
  test.setTimeout(300000);
  await mkdir(out, { recursive: true });

  // Fixture: an owner, a family member, a second channel and a short conversation.
  const ownerCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const owner = await ownerCtx.newPage();
  await setup(owner, "owner");
  const link = await invite(owner);
  const auntCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const aunt = await auntCtx.newPage();
  await accept(aunt, link, "linda");
  await owner.getByRole("button", { name: "Settings", exact: true }).click();
  await owner.getByTestId("screen-settings").getByRole("button", { name: "Channels", exact: true }).click();
  await owner.getByLabel("Channel name", { exact: true }).fill("recipes");
  await owner.getByRole("button", { name: "Create channel", exact: true }).click();
  await owner.getByRole("button", { name: "Open general", exact: true }).click();
  await send(owner, "Dinner at ours on Sunday, 6 pm. Bring nothing but yourselves.");
  await send(aunt, "Hi everyone, it's Linda! I'll bring the lemon cake anyway.");
  await send(owner, "@linda you're the best");
  await auntCtx.close(); await ownerCtx.close();

  for (const [label, size] of sizes) {
    for (const scheme of schemes) {
      const { context, page, phone } = await open(browser, size, scheme);
      const name = (what: string) => `${what}-${label}-${scheme}`;
      await shot(page, name("chat"));
      if (phone) {
        await openMenu(page);
        await shot(page, name("drawer"));
        await page.keyboard.press("Escape");
      }
      await page.getByRole("button", { name: "Server settings", exact: true }).click();
      const settings = page.getByTestId("screen-settings");
      if (phone) await shot(page, name("settings-root"));
      await settings.getByRole("button", { name: "Invites", exact: true }).click();
      await page.getByTestId("screen-invites").getByRole("button", { name: /^Create invite/ }).click();
      await expect(page.getByTestId("invite-link")).toBeVisible();
      await shot(page, name("settings-invites"));
      if (phone) await settings.getByRole("button", { name: "Settings", exact: true }).click();
      await settings.getByRole("button", { name: "Appearance", exact: true }).click();
      await page.getByRole("radio", { name: "Lavender" }).click();
      await shot(page, name("appearance-lavender"));
      await page.getByRole("radio", { name: "Mint" }).click();
      await shot(page, name("appearance-mint"));
      // Mint carried through the app: back in the chat.
      await page.keyboard.press("Escape");
      await expect(settings).toHaveCount(0);
      await shot(page, name("chat-mint"));
      await page.evaluate(() => localStorage.removeItem("hc-accent"));
      await context.close();
    }
  }
});
