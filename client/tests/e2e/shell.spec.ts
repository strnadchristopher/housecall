import { execFileSync } from "node:child_process";
import { test, expect } from "@playwright/test";
import { setup, signIn } from "./helpers";

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
  // The toolbar only takes clicks while the row is hovered, and the GIF loading can scroll the list out from under
  // the pointer, so hover again on each try.
  await expect(async () => {
    await sent.hover();
    await sent.getByRole("button", { name: "Unsend", exact: true }).click({ timeout: 2000 });
  }).toPass({ timeout: 15000 });
  await page.getByRole("button", { name: "Unsend for everyone", exact: true }).click();
  await expect(page.getByTestId("screen-conversation").locator("video")).toHaveCount(0);

  // Call bar: Join, then count, duration and avatars under the channel name.
  const bar = page.getByTestId("call-bar");
  await bar.getByRole("button", { name: "Join", exact: true }).click();
  await expect(bar).toHaveAttribute("data-phase", "live", { timeout: 30000 });
  await expect(bar.getByTestId("call-duration")).toBeVisible();
  await expect(bar).toContainText("1");
  await expect(page.getByTestId("channel-call").locator("[title]").first()).toBeVisible();
  // The stage owns the center, so its call bar carries the controls and the sidebar dock steps aside.
  await expect(page.getByTestId("call-dock")).toHaveCount(0);
  await expect(bar.getByRole("button", { name: "Mute", exact: true })).toBeVisible();

  // Right column tabs.
  // No Chord is configured in this fixture, so there is no Chords tab to land on an empty pane.
  await expect(page.getByRole("tab", { name: "Chords" })).toHaveCount(0);
  // In a call the right column opens on Chat; People is one tab away.
  await expect(page.getByRole("tab", { name: "Chat", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "People", exact: true }).click();
  await expect(page.getByTestId("people").locator("li")).toHaveCount(1);

  // The mail icon opens the direct-message view.
  await page.getByRole("button", { name: "Direct messages", exact: true }).click();
  await expect(page.getByTestId("screen-direct-messages")).toBeVisible();

  // Call elsewhere, on a phone: another conversation says where the call is and keeps mute and leave
  // in reach (the dock lives in the hidden list there). Joining here asks before leaving the call.
  await page.getByRole("button", { name: "Server settings", exact: true }).click();
  await page.getByTestId("screen-settings").getByRole("button", { name: "Channels", exact: true }).click();
  await page.getByLabel("Channel name", { exact: true }).fill("garden");
  await page.getByRole("button", { name: "Create channel", exact: true }).click();
  await expect(page.getByTestId("screen-settings")).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  // A phone keeps the conversation on screen; the menu opens the drawer, where the dock is in view.
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await expect(page.getByTestId("call-dock")).toBeVisible();
  await page.getByRole("button", { name: "Open garden", exact: true }).click();
  await expect(bar).toHaveAttribute("data-elsewhere", "");
  await expect(bar).toContainText("In call in");
  await expect(bar.getByRole("button", { name: "Mute", exact: true })).toBeVisible();
  await bar.getByRole("button", { name: "Join", exact: true }).click();
  await expect(bar.getByRole("button", { name: "Switch call", exact: true })).toBeVisible();
  await bar.getByRole("button", { name: "Cancel", exact: true }).click();
  await bar.getByRole("button", { name: "Leave", exact: true }).click();
  await expect(bar.getByRole("button", { name: "Join", exact: true })).toBeVisible();
});

test("profile: display name and avatar show in the user bar and on new messages; owner edits the server", async ({ page }) => {
  page.setDefaultTimeout(15000);
  // The server is shared across this file: the first test already ran setup, so sign in as that owner.
  await page.goto("/");
  await signIn(page, "owner");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  const drop = async (screen: string, save: string) => {
    const dataTransfer = await page.evaluateHandle((bytes: number[]) => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(bytes)], "pic.png", { type: "image/png" }));
      return dt;
    }, [...png]);
    await page.getByTestId("dropzone").dispatchEvent("drop", { dataTransfer });
    await expect(page.locator(".hc-drop__preview")).toBeVisible();
    await page.getByTestId(screen).getByRole("button", { name: save, exact: true }).click();
  };
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const account = page.getByTestId("screen-account");
  await account.getByLabel("Display name", { exact: true }).fill("Ada Fixture");
  await account.getByRole("button", { name: "Save name", exact: true }).click();
  const bar = page.locator(".hc-userbar");
  await expect(bar).toContainText("Ada Fixture");
  await expect(account).toContainText("owner");
  await drop("screen-account", "Save picture");
  await expect(bar.locator(".hc-avatar img")).toBeVisible();

  // A GIF avatar is uploaded as picked (not redrawn into a still), served with its own type, and loads in the bar.
  const gif = execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=64x64:rate=2", "-t", "1", "-f", "gif", "pipe:1"], { maxBuffer: 1 << 22 });
  expect(gif.subarray(0, 4).toString()).toBe("GIF8");
  await account.locator("input[type=file]").setInputFiles({ name: "wave.gif", mimeType: "image/gif", buffer: gif });
  const served = page.waitForResponse(response => /\/api\/users\/[^/]+\/avatar/.test(response.url()) && response.headers()["content-type"] === "image/gif");
  await account.getByRole("button", { name: "Save picture", exact: true }).click();
  expect(Buffer.compare(await (await served).body(), gif)).toBe(0);
  await expect.poll(() => bar.locator(".hc-avatar img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);

  await page.getByTestId("screen-settings").getByRole("button", { name: "Server profile", exact: true }).click();
  const server = page.getByTestId("screen-server");
  await server.getByLabel("Server name", { exact: true }).fill("Fixture House");
  await server.getByRole("button", { name: "Save name", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Servers: Fixture House/ })).toBeVisible();
  await drop("screen-server", "Save icon");
  await expect(page.getByRole("button", { name: /^Servers:/ }).locator(".hc-avatar img")).toBeVisible();

  await page.getByTestId("screen-settings").getByRole("button", { name: "Close", exact: true }).click();
  await page.getByTestId("screen-composer").getByLabel("Message", { exact: true }).fill("hello from the fixture");
  await page.keyboard.press("Enter");
  const message = page.locator(".hc-msg", { hasText: "hello from the fixture" });
  await expect(message.locator(".hc-msg__head strong")).toHaveText("Ada Fixture");
  await expect(message.locator(".hc-avatar img")).toBeVisible();
});

test("motion: settings and pickers slide out and are gone at once under reduced motion", async ({ page }) => {
  page.setDefaultTimeout(15000);
  await page.goto("/");
  await signIn(page, "owner");
  const settings = page.getByTestId("screen-settings");
  const emoji = page.getByRole("group", { name: "Emoji", exact: true });

  // Normal motion: the exit plays, then the panel is gone, and clicks underneath work meanwhile.
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(settings).toBeVisible();
  await settings.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByTestId("screen-composer").getByRole("button", { name: "Emoji", exact: true }).click();
  await expect(emoji).toBeVisible();
  await expect(settings).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(emoji).toHaveCount(0);

  // Reduced motion: no exit timers, the panel is gone as soon as it is closed.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(settings).toBeVisible();
  await settings.getByRole("button", { name: "Close", exact: true }).click();
  await expect(settings).toHaveCount(0, { timeout: 250 });
  await page.getByTestId("screen-composer").getByRole("button", { name: "Emoji", exact: true }).click();
  await expect(emoji).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(emoji).toHaveCount(0, { timeout: 250 });
});
