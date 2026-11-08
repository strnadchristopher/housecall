import { test, expect } from "@playwright/test";

// The native command is instrumented here; Kotlin/Keystore/FCM/device tests are separate gates.
test("native push opt-in and cleanup failures cross the real app session boundary", async ({ page, request }) => {
  const password = "native adapter fixture password";
  expect((await request.post("/api/setup", { data: {
    setup_token: "test-setup-token-at-least-32-characters", username: "native_fixture",
    password, device_name: "adapter fixture",
  } })).ok()).toBeTruthy();
  await page.addInitScript(() => {
    const fixture = { enabled: false, configured: false, clearFails: false, actions: [] as string[] };
    Object.assign(window, { nativePushFixture: fixture, __TAURI_INTERNALS__: {
      invoke: async (command: string, args: { action: string }) => {
        if (command === "native_auth") {
          if (args.action === "status") return { platform: "unsupported", supported: false,
            configured: false, origin: "", rpId: "", appOrigin: "", associationVerified: false };
          return {};
        }
        if (command !== "native_push") throw new Error("Unexpected command");
        fixture.actions.push(args.action); // Never retain credentials or command payloads.
        if (args.action === "status") return { supported: true, configured: fixture.configured,
          enabled: fixture.enabled, permissionGranted: true };
        if (args.action === "clear") {
          if (fixture.clearFails) throw "Fixture native cleanup failed"; // Real Tauri Result<_, String> rejection.
          fixture.enabled = false;
        }
        if (args.action === "enable") fixture.enabled = true;
        return {};
      },
    } });
  });
  const consoleErrors: string[] = [];
  page.on("pageerror", error => consoleErrors.push(error.name));
  await page.goto("/");
  await page.getByLabel("Username", { exact: true }).fill("native_fixture");
  await page.getByLabel("Password (at least 12 characters)").fill(password);
  await page.getByTestId("screen-login").locator("button[type=submit]").click();
  await expect(page.getByTestId("screen-composer")).toBeVisible();
  await page.getByRole("button", { name: "Notifications", exact: true }).click();
  expect(await page.evaluate(() => (window as any).nativePushFixture.actions.includes("enable"))).toBe(false);
  await page.getByRole("button", { name: "Enable background notifications", exact: true }).click();
  await expect(page.getByTestId("screen-notifications")).toContainText("Background notifications are unavailable in this app build");
  await page.evaluate(() => { (window as any).nativePushFixture.configured = true; });
  await page.getByRole("button", { name: "Enable background notifications", exact: true }).click();
  await expect(page.getByRole("button", { name: "Disable background notifications", exact: true })).toBeVisible();
  await page.screenshot({ path: "../evidence/recovery-native-push-adapter-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "../evidence/recovery-native-push-adapter-mobile.png" });
  await page.getByRole("button", { name: "Disable background notifications", exact: true }).click();
  await expect(page.getByRole("button", { name: "Disable background notifications", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Enable background notifications", exact: true }).click();
  await page.evaluate(() => { (window as any).nativePushFixture.clearFails = true; });
  let sessionDeletes = 0;
  page.on("request", req => { if (req.method() === "DELETE" && new URL(req.url()).pathname.startsWith("/api/devices/")) sessionDeletes++; });
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByTestId("screen-notifications")).toContainText("Fixture native cleanup failed");
  expect(sessionDeletes).toBe(0);
  await page.screenshot({ path: "../evidence/recovery-native-push-cleanup-error.png" });
  await page.evaluate(() => { (window as any).nativePushFixture.clearFails = false; });
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByTestId("screen-login")).toBeVisible();
  expect(sessionDeletes).toBe(1);
  expect(await page.evaluate(() => (window as any).nativePushFixture.enabled)).toBe(false);
  expect(consoleErrors).toEqual([]);
});
