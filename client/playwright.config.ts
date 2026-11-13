import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch:
    process.env.HOUSECALL_TEST_VOICESHOTS === "1"
      ? "**/voice-shots.spec.ts" // writes design/040/shots/after-voice-*; run on purpose
      : process.env.HOUSECALL_TEST_VOICECHANNELS === "1"
      ? "**/voice-channels.spec.ts"
      : process.env.HOUSECALL_TEST_DM_CALLS === "1"
      ? "**/dm-calls.spec.ts"
      : process.env.HOUSECALL_TEST_SETUP === "1"
      ? "**/setup.spec.ts"
      : process.env.HOUSECALL_TEST_SNAPS === "1"
      ? "**/snaps.spec.ts"
      : process.env.HOUSECALL_TEST_NATIVE_PUSH === "1"
      ? "**/native-push.spec.ts"
      : process.env.HOUSECALL_TEST_UPLOAD_VIDEO === "1"
      ? "**/upload-video.spec.ts"
      : process.env.HOUSECALL_TEST_DANA === "1"
      ? "**/dana.spec.ts" // rewrites docs/ux/phase-2; run on purpose with tests/run-dana.mjs
      : process.env.HOUSECALL_TEST_README === "1"
      ? "**/readme.spec.ts" // rewrites docs/readme; run on purpose
      : process.env.HOUSECALL_TEST_SHOTS === "1"
      ? "**/shots.spec.ts" // rewrites the tracked PNGs in design/shots; never part of an acceptance run
      : process.env.HOUSECALL_TEST_LINDA === "1"
      ? "**/linda.spec.ts" // adversarial UX walk-through; writes docs/ux/$HOUSECALL_UX_OUT, run on purpose
      : process.env.HOUSECALL_TEST_SHELL === "1"
      ? "**/shell.spec.ts"
      : process.env.HOUSECALL_TEST_UISHOTS_PART_TWO === "1"
      ? "**/ui-shots-part2.spec.ts" // writes docs/ux/mobile-after-part2; run on purpose
      : process.env.HOUSECALL_TEST_UISHOTS === "1"
      ? "**/ui-shots.spec.ts" // writes docs/ux/mobile-after-part1; run on purpose
      : process.env.HOUSECALL_TEST_MOBILE === "1"
      ? "**/mobile.spec.ts"
      : process.env.HOUSECALL_TEST_ONBOARDING === "1"
      ? "**/onboarding.spec.ts"
      : process.env.HOUSECALL_TEST_REPORTS === "1"
      ? "**/reports.spec.ts"
      : process.env.HOUSECALL_TEST_PLEX === "1"
      ? "**/plex.spec.ts"
      : process.env.HOUSECALL_TEST_LOAD === "1"
        ? "**/voice-load.spec.ts"
        : process.env.HOUSECALL_TEST_VOICE === "1"
          ? "**/voice.spec.ts"
          : "**/chat.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 120000,
  reporter: [
    ["list"],
    ["json", { outputFile: process.env.HOUSECALL_TEST_RECEIPT ?? "test-results/client-playwright.json" }],
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
      env: { HOUSECALL_API: "http://127.0.0.1:3031" },
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
