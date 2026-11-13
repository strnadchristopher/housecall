import { test, expect, type Page } from "@playwright/test";
import { join } from "node:path";
import { fillSignIn, logInButton } from "./helpers";

// Writes design/040/shots/after-media-*.png. Run on purpose: HOUSECALL_TEST_MEDIASHOTS=1 npm run e2e
const out = join(process.cwd(), "../design/040/shots"); // cwd is client/
const password = "synthetic shots password 123";

test("media shots: camera, review, share preset picker", async ({ browser, request }) => {
  test.setTimeout(240000);
  const setup = await request.post("/api/setup", {
    data: { username: "ms_owner", password, setup_token: "test-setup-token-at-least-32-characters", device_name: "shots" },
  });
  expect(setup.ok()).toBeTruthy();
  for (const [width, height] of [[390, 844], [1280, 800]] as const) {
    const context = await browser.newContext({ permissions: ["camera", "microphone"], viewport: { width, height }, hasTouch: width < 600 });
    const page: Page = await context.newPage();
    page.setDefaultTimeout(20000);
    await page.goto("/");
    await fillSignIn(page, "ms_owner", password);
    await logInButton(page).click();
    const list = page.getByRole("button", { name: "Open general", exact: true });
    const composer = page.getByTestId("screen-composer");
    await expect(list.or(composer).first()).toBeVisible();
    if (!(await composer.isVisible()) && (await list.isVisible())) await list.click();
    await expect(composer).toBeVisible();

    await composer.getByRole("button", { name: "Take a snap", exact: true }).click();
    const camera = page.getByRole("dialog", { name: "Camera" });
    await expect.poll(() => camera.getByTestId("snap-camera-video").evaluate((v: HTMLVideoElement) => v.videoWidth)).toBeGreaterThan(0);
    await page.screenshot({ path: join(out, `after-media-camera-${width}.png`) });
    await camera.getByRole("button", { name: "Take photo", exact: true }).click();
    await expect(camera.getByTestId("snap-camera-still")).toBeVisible();
    await page.screenshot({ path: join(out, `after-media-review-${width}.png`) });
    await page.keyboard.press("Escape");
    await expect(camera).toBeHidden();

    await page.getByTestId("voice-channel").getByRole("button", { name: "Open Lounge", exact: true }).click();
    const join_ = page.getByRole("button", { name: "Join voice", exact: true });
    if (await join_.isVisible().catch(() => false)) await join_.click();
    await expect(page.getByTestId("call-bar")).toHaveAttribute("data-phase", "live", { timeout: 30000 });
    await page.getByTestId("call-bar").getByRole("button", { name: "Share quality", exact: true }).click();
    await expect(page.getByTestId("share-quality")).toBeVisible();
    await page.screenshot({ path: join(out, `after-media-share-presets-${width}.png`) });
    await context.close();
  }
});
