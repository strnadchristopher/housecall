import { test, expect } from "@playwright/test";
import { setup } from "./helpers";

// Fictional fixture only. The GIF provider is not reachable from tests, so its
// routes are answered locally and the capability flag is set on /api/me.
const gif = { id: "fixture0001", title: "Fixture wave" };

test("shell: picker, channel, call, composer, tabs, direct messages", async ({ page }) => {
  page.setDefaultTimeout(15000);
  await page.context().grantPermissions(["camera", "microphone"]);
  await page.route("**/api/me", async route => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, capabilities: { ...body.capabilities, giphy: true } } });
  });
  await page.route("**/api/giphy/search*", route => route.fulfill({ json: { results: [gif] } }));
  await page.route("**/api/giphy/media/*", route => route.fulfill({ status: 200, contentType: "video/mp4", body: Buffer.alloc(16) }));
  await setup(page, "owner");

  // Picker: keyboard, focus return, no Add Server on the web build.
  const trigger = page.getByRole("button", { name: /^Servers:/ });
  const list = page.locator(".hc-picker__list");
  await trigger.focus();
  await page.keyboard.press("ArrowDown");
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  const rows = list.getByRole("option");
  await expect(rows.first()).toBeFocused();
  await page.keyboard.press("End");
  await expect(rows.last()).toBeFocused();
  await page.keyboard.press("Home");
  await expect(rows.first()).toBeFocused();
  const first = (await rows.first().locator("strong").innerText()).toLowerCase();
  await page.keyboard.type(first.slice(0, 2));
  await expect(rows.first()).toBeFocused();
  await expect(list.getByRole("option", { name: /Add/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(trigger).toBeFocused();
  // A click during the animation reverses it.
  await trigger.click();
  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(list).toBeHidden();
  // Opening moves only transform and opacity, and nothing animates under reduced motion.
  await expect(list).toHaveCSS("transition-property", /transform, opacity/);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await trigger.click();
  await expect(list).toHaveCSS("transition-duration", "0s");
  await expect(list).toBeVisible();
  await page.keyboard.press("Escape");
  await page.emulateMedia({ reducedMotion: "no-preference" });

  // Open a channel.
  const channel = page.getByRole("button", { name: /^Open / }).first();
  await channel.click();
  await expect(channel).toHaveAttribute("aria-current", "page");

  // Composer: attach, emoji, GIF.
  const composer = page.getByTestId("screen-composer");
  await expect(composer.getByRole("button", { name: /Attach/ })).toBeVisible();
  await composer.locator('input[type="file"]').setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("fixture") });
  // No scanner in this fixture, so the file is held rather than attached.
  await expect(page.getByTestId("upload")).toContainText("notes.txt");
  await page.getByRole("button", { name: "Remove notes.txt" }).click();
  await composer.getByRole("button", { name: /Emoji/ }).click();
  // The emoji grid takes focus on open and Escape closes it, returning focus to its button.
  const emoji = page.getByRole("group", { name: "Emoji" });
  await expect(emoji.getByRole("button").first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(emoji).toHaveCount(0);
  await expect(composer.getByRole("button", { name: /Emoji/ })).toBeFocused();
  await composer.getByRole("button", { name: /Emoji/ }).click();
  await page.getByRole("button", { name: "🎉" }).click();
  await expect(composer.getByLabel("Message", { exact: true })).toHaveValue("🎉");
  await composer.getByRole("button", { name: /Emoji/ }).click();
  await composer.getByRole("button", { name: /GIF/ }).click();
  await page.getByPlaceholder(/search/i).fill("wave");
  await page.getByRole("button", { name: gif.title }).click();
  await expect(page.getByTestId("screen-conversation").locator("video").first()).toBeVisible();
  // Leave the shared server clean for the screenshot run that follows.
  const sent = page.locator("li[data-message-id]").filter({ has: page.locator("video") });
  await sent.hover();
  await sent.getByRole("button", { name: "Unsend", exact: true }).click();
  await page.getByRole("button", { name: "Unsend for everyone", exact: true }).click();
  await expect(page.getByTestId("screen-conversation").locator("video")).toHaveCount(0);

  // Call bar: Join, then count, duration and avatars under the channel name.
  const bar = page.getByTestId("call-bar");
  await bar.getByRole("button", { name: "Join", exact: true }).click();
  await expect(bar).toHaveAttribute("data-phase", "live", { timeout: 30000 });
  await expect(bar.getByTestId("call-duration")).toBeVisible();
  await expect(bar).toContainText("1");
  await expect(page.getByTestId("channel-call").locator("[title]").first()).toBeVisible();
  await expect(page.getByTestId("call-dock")).toBeVisible();

  // Right column tabs.
  // No Chord is configured in this fixture, so there is no Chords tab to land on an empty pane.
  await expect(page.getByRole("tab", { name: "Chords" })).toHaveCount(0);
  await expect(page.getByTestId("people").locator("li")).toHaveCount(1);

  // The mail icon opens the direct-message view.
  await page.getByRole("button", { name: "Direct messages", exact: true }).click();
  await expect(page.getByTestId("screen-direct-messages")).toBeVisible();
  await bar.getByRole("button", { name: "Leave", exact: true }).click();
});
