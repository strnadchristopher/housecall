import { execFileSync } from "node:child_process";
import { test, expect, type Browser } from "@playwright/test";
import { accept, invite, openMenu, password, send, setupToken, signIn } from "./helpers";

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
        await expect(page.getByTestId("screen-composer")).toBeVisible();
        // A phone opens in the chat; the list is the drawer behind the menu button.
        await openMenu(page);
        await page.waitForTimeout(600);
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

// The server wizard's calls and extras steps at both sizes. This host has a call port, so the setup status is
// rewritten to look like one without, which is the case the calls step has to explain.
test("wizard screenshots", async ({ browser }) => {
  test.setTimeout(120000);
  for (const [width, height, size] of [[1440, 900, "1440"], [390, 844, "390"]] as const) {
    const { context, page } = await open(browser, width, height, "dark");
    await context.grantPermissions(["camera", "microphone"]);
    await page.route("**/api/setup/status", async route => {
      const body = await (await route.fetch()).json();
      body.integrations = body.integrations.map((row: { id: string }) => row.id === "calls" ? { id: "calls", ready: false, missing: ["SFU_PUBLIC_IP", "SFU_PORT"] } : row);
      await route.fulfill({ json: body });
    });
    await page.getByLabel("Username", { exact: true }).fill("owner");
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByTestId("screen-sign-in").getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByRole("button", { name: /^Servers:/ }).click();
    await page.getByRole("option", { name: "Create server" }).click();
    const wizard = page.getByTestId("create-server-wizard");
    await wizard.getByLabel("Server name", { exact: true }).fill(`Harbor House ${size}`);
    await wizard.getByRole("button", { name: "Create server", exact: true }).click();
    await expect(wizard.getByRole("heading", { name: "Channels" })).toBeVisible();
    await wizard.getByRole("button", { name: "Next", exact: true }).click();
    await expect(wizard.getByRole("heading", { name: "Calls" })).toBeVisible();
    await expect(wizard.getByTestId("integration-calls")).toContainText("Needs setup");
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${out}/wizard-calls-${size}.png`, animations: "disabled" });
    // With the device test running, the preview must fit whole.
    await wizard.getByRole("button", { name: "Test microphone and camera" }).click();
    await expect.poll(() => wizard.getByTestId("camera-preview").evaluate((video: HTMLVideoElement) => video.videoWidth)).toBeGreaterThan(0);
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${out}/wizard-calls-testing-${size}.png`, animations: "disabled" });
    await wizard.getByRole("button", { name: "Stop test" }).click();
    await wizard.getByRole("button", { name: "Next", exact: true }).click();
    await expect(wizard.getByRole("heading", { name: "Extras" })).toBeVisible();
    await expect(wizard.getByTestId("integration-dj")).toContainText("Not set up");
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${out}/wizard-extras-${size}.png`, animations: "disabled" });
    await context.close();
  }
});

// A snap, open on a phone: the photo scaled to the screen on an opaque dark layer with the countdown on top.
test("snap viewer screenshot", async ({ browser }) => {
  test.setTimeout(120000);
  const photo = execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x480", "-frames:v", "1", "-f", "image2", "-c:v", "mjpeg", "pipe:1"], { maxBuffer: 1 << 22 });
  const phone = async (name: string) => {
    const { context, page } = await open(browser, 390, 844, "dark");
    await page.getByLabel("Username", { exact: true }).fill(name);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByTestId("screen-sign-in").getByRole("button", { name: "Sign in", exact: true }).click();
    // Opens straight into general.
    await expect(page.getByTestId("screen-composer")).toBeVisible();
    return { context, page };
  };
  const sender = await phone("owner");
  const receiver = await phone("mara");
  await sender.page.getByTestId("snap-capture").setInputFiles({ name: "camera.jpg", mimeType: "image/jpeg", buffer: photo });
  await sender.page.getByRole("button", { name: "Send as snap", exact: true }).click();
  await receiver.page.getByRole("button", { name: /Snap, Tap to view/ }).click();
  await expect(receiver.page.getByTestId("snap-image")).toBeVisible();
  await receiver.page.waitForTimeout(1500);
  await receiver.page.screenshot({ path: `${out}/snap-viewer-390.png`, animations: "disabled" });
  await sender.context.close();
  await receiver.context.close();
});
