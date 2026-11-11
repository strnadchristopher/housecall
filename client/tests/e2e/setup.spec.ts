import { execFileSync } from "node:child_process";
import { test, expect } from "@playwright/test";
import { accept, invite, setup } from "./helpers";

// Fictional fixtures only. The test host has no call port, Giphy key, Plex or DJ, so those cards report "needs setup".
const CARDS = ["calls", "media", "scanner", "transcode", "dj", "gimme", "plex", "giphy", "vm"];

test("setup: server wizard, Settings integrations, non-owner", async ({ browser }) => {
  const owner = await (await browser.newContext({ permissions: ["camera", "microphone"] })).newPage();
  const member = await (await browser.newContext()).newPage();
  owner.setDefaultTimeout(15000);
  member.setDefaultTimeout(15000);
  await setup(owner, "owner");

  // Step 1: name and icon. The icon is a GIF so it is uploaded as picked.
  const gif = execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=64x64:rate=2", "-t", "1", "-f", "gif", "pipe:1"], { maxBuffer: 1 << 22 });
  await owner.getByRole("button", { name: /^Servers:/ }).click();
  await owner.getByRole("option", { name: "Create server" }).click();
  const wizard = owner.getByTestId("create-server-wizard");
  await expect(wizard.getByRole("heading", { name: "Name and icon" })).toBeVisible();
  await expect(wizard).toContainText("Step 1 of 5");
  await wizard.getByLabel("Server name", { exact: true }).fill("Harbor House");
  await wizard.locator("input[type=file]").setInputFiles({ name: "harbor.gif", mimeType: "image/gif", buffer: gif });
  const icon = owner.waitForResponse(response => /\/api\/servers\/[^/]+\/icon$/.test(response.url()) && response.request().method() === "PUT");
  await wizard.getByRole("button", { name: "Create server", exact: true }).click();
  expect((await icon).status()).toBe(200);

  // Escape after step 1 asks first; the server is kept either way.
  await expect(wizard.getByRole("heading", { name: "Channels" })).toBeVisible();
  await owner.keyboard.press("Escape");
  await expect(wizard.getByRole("alertdialog")).toContainText("The server is kept");
  await wizard.getByRole("button", { name: "Keep going" }).click();
  await expect(wizard.getByRole("alertdialog")).toHaveCount(0);

  // Step 2: channels.
  await wizard.getByLabel("Voice lounge").check();
  await wizard.getByRole("button", { name: "Next", exact: true }).click();

  // Step 3: calls. The device test leads (fake camera and microphone). No call port on the test host, so the
  // host setup is "Needs setup" but stays closed until asked for.
  await expect(wizard.getByRole("heading", { name: "Calls" })).toBeVisible();
  const calls = wizard.getByTestId("integration-calls");
  await expect(calls).toContainText("Needs setup");
  await expect(calls.getByText("SFU_PUBLIC_IP")).toHaveCount(0);
  await expect(wizard.getByTestId("integration-setup")).toContainText("Same for every server on this host.");
  const test = wizard.getByRole("button", { name: "Test microphone and camera" });
  const head = await calls.boundingBox();
  expect((await test.boundingBox())!.y).toBeLessThan(head!.y);
  await test.click();
  await expect(wizard.getByTestId("mic-meter")).toBeVisible();
  await expect.poll(() => wizard.getByTestId("camera-preview").evaluate((video: HTMLVideoElement) => video.videoWidth)).toBeGreaterThan(0);
  // The preview fits inside the scrolling step, never cut at the bottom.
  const stage = (await wizard.locator(".hc-wizard__stage").boundingBox())!;
  const preview = (await wizard.getByTestId("camera-preview").boundingBox())!;
  expect(preview.y + preview.height).toBeLessThanOrEqual(stage.y + stage.height + 1);
  await wizard.getByRole("button", { name: "Stop test" }).click();
  await expect(wizard.getByTestId("mic-meter")).toHaveCount(0);
  await calls.getByRole("button", { name: /Calls/ }).click();
  await expect(calls).toContainText("SFU_PUBLIC_IP");
  await wizard.getByRole("button", { name: "Next", exact: true }).click();

  // Step 4: extras, each skippable. Optional ones that are not configured read "Not set up", never "Needs setup".
  await expect(wizard.getByRole("heading", { name: "Extras" })).toBeVisible();
  for (const id of ["dj", "gimme", "plex", "giphy", "vm", "transcode"]) await expect(wizard.getByTestId(`integration-${id}`)).toBeVisible();
  await expect(wizard.getByTestId("integration-dj")).toContainText("Not set up");
  await expect(wizard.getByTestId("wizard-step-4")).not.toContainText("Needs setup");
  await wizard.getByRole("button", { name: "Next", exact: true }).click();

  // Step 5: invite. The link is made when the step opens.
  await expect(wizard.getByRole("heading", { name: "Invite" })).toBeVisible();
  await expect(wizard.getByTestId("wizard-invite-link")).toHaveValue(/#invite=[a-f0-9]{64}$/);
  await wizard.getByRole("button", { name: "Done", exact: true }).click();
  await expect(wizard).toHaveCount(0);

  // The new server is current, shows its icon, and has the extra channel.
  const trigger = owner.getByRole("button", { name: /^Servers: Harbor House/ });
  await expect(trigger).toBeVisible();
  await expect(trigger.locator(".hc-avatar img")).toBeVisible();
  await expect(owner.getByRole("button", { name: /Voice lounge/ }).first()).toBeVisible();
  await trigger.click();
  await expect(owner.getByRole("option", { name: /Harbor House/ }).locator(".hc-avatar img")).toBeVisible();
  await owner.keyboard.press("Escape");

  // Settings: every card, and Check again asks the server again.
  await owner.getByRole("button", { name: "Server settings", exact: true }).click();
  await owner.getByTestId("screen-settings").getByRole("button", { name: "Integrations", exact: true }).click();
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
  await member.getByTestId("screen-settings").getByRole("button", { name: "Integrations", exact: true }).click();
  await expect(member.getByTestId("setup-ask-owner")).toHaveText("Ask the server owner to set this up.");
  expect(asked).toBe(0);
});
