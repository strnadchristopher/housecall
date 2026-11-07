import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch:
    process.env.CHRISCORD_TEST_PLEX === "1"
      ? "**/plex.spec.ts"
      : process.env.CHRISCORD_TEST_LOAD === "1"
        ? "**/voice-load.spec.ts"
        : process.env.CHRISCORD_TEST_VOICE === "1"
          ? "**/voice.spec.ts"
          : "**/chat.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 120000,
  reporter: [
    ["list"],
    ["json", { outputFile: "../evidence/client-playwright.json" }],
  ],
  use: {
    baseURL: "http://localhost:1420",
    trace: "off",
    screenshot: "off",
  },
  webServer: [
    {
      command: "node tests/start-server.mjs",
      url: "http://127.0.0.1:3031/api/health",
      reuseExistingServer: false,
    },
    {
      command: "npm run dev",
      url: "http://127.0.0.1:1420",
      reuseExistingServer: false,
      env: { CHRISCORD_API: "http://127.0.0.1:3031" },
    },
  ],
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        launchOptions: {
          args: [
            "--use-fake-device-for-media-stream",
            "--use-fake-ui-for-media-stream",
            "--autoplay-policy=no-user-gesture-required",
          ],
        },
      },
    },
  ],
});
