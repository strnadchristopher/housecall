import { execFileSync } from "node:child_process";
import { test, expect } from "@playwright/test";
import { accept, invite, setup } from "./helpers";

// Fictional fixtures only. The test host has no call port, Giphy key, Plex or DJ, so those cards report "needs setup".
const CARDS = ["calls", "media", "scanner", "transcode", "dj", "gimme", "plex", "giphy", "vm"];

test("setup: create server dialog, Settings integrations, non-owner", async ({ browser }) => {
  const owner = await (await browser.newContext()).newPage();
  const member = await (await browser.newContext()).newPage();
  owner.setDefaultTimeout(15000);
  member.setDefaultTimeout(15000);
  await setup(owner, "owner");

  // One-field dialog: name and an optional icon. The icon is a GIF so it is uploaded as picked.
  const gif = execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=64x64:rate=2", "-t", "1", "-f", "gif", "pipe:1"], { maxBuffer: 1 << 22 });
  await owner.getByRole("button", { name: /^Servers:/ }).click();
  await owner.getByRole("option", { name: "Create server" }).click();
  const dialog = owner.getByTestId("create-server");
  await expect(dialog.getByRole("button", { name: "Create", exact: true })).toBeDisabled();
  await dialog.getByLabel("Server name", { exact: true }).fill("Harbor House");
  await dialog.locator("input[type=file]").setInputFiles({ name: "harbor.gif", mimeType: "image/gif", buffer: gif });
  const icon = owner.waitForResponse(response => /\/api\/servers\/[^/]+\/icon$/.test(response.url()) && response.request().method() === "PUT");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  expect((await icon).status()).toBe(200);

  // Success: the new server is current and the dialog offers an invite link.
  await expect(dialog).toContainText("Harbor House is ready");
  await dialog.getByRole("button", { name: "Invite people" }).click();
  await expect(dialog.getByTestId("create-server-invite-link")).toHaveValue(/#invite=[a-f0-9]{64}$/);
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(dialog).toHaveCount(0);

  // The new server is current, shows its icon, and has the extra channel.
  const trigger = owner.getByRole("button", { name: /^Servers: Harbor House/ });
  await expect(trigger).toBeVisible();
  await expect(trigger.locator(".hc-avatar img")).toBeVisible();
  await trigger.click();
  await expect(owner.getByRole("option", { name: /Harbor House/ }).locator(".hc-avatar img")).toBeVisible();
  await owner.keyboard.press("Escape");

  // Settings: every card, and Check again asks the server again.
  await owner.getByRole("button", { name: "Server settings", exact: true }).click();
  await owner.getByTestId("screen-settings").getByRole("button", { name: "Apps", exact: true }).click();
  const panel = owner.getByTestId("integration-setup");
  for (const id of CARDS) await expect(panel.getByTestId(`integration-${id}`)).toBeVisible();
  await expect(panel.getByTestId("integration-giphy")).toContainText("Not set up");
  await expect(panel.getByTestId("integration-calls")).toContainText("Needs setup");
  await panel.getByTestId("integration-giphy").getByRole("button", { name: /Giphy|GIFs/ }).click();
  await expect(panel.getByTestId("integration-giphy")).toContainText("GIPHY_API_KEY");
  const again = owner.waitForResponse(response => response.url().endsWith("/api/setup/status") && response.status() === 200);
  await panel.getByTestId("integration-giphy").getByRole("button", { name: "Check again" }).click();
  const body = JSON.stringify(await (await again).json());
  expect(body).not.toMatch(/test-setup-token|1111111111/);

  // A member is told to ask the owner and no status request is made for them.
  await owner.getByTestId("screen-settings").getByRole("button", { name: "Close", exact: true }).click();
  await owner.getByRole("button", { name: /^Servers:/ }).click();
  await owner.getByRole("option", { name: /^Harbor House/ }).click();
  const link = await invite(owner);
  let asked = 0;
  member.on("request", request => { if (request.url().endsWith("/api/setup/status")) asked++; });
  await accept(member, link, "alice");
  await member.getByRole("button", { name: "Server settings", exact: true }).click();
  await member.getByTestId("screen-settings").getByRole("button", { name: "Apps", exact: true }).click();
  await expect(member.getByTestId("setup-ask-owner")).toHaveText("Ask the server owner to set this up.");
  expect(asked).toBe(0);
});
