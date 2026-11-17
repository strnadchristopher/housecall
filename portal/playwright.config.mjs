import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './test', testMatch: 'browser.spec.mjs', workers: 1, fullyParallel: false,
  timeout: 60000, retries: 0,
  reporter: 'list',
  use: { baseURL: 'https://127.0.0.1:43181', ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, trace: 'off', screenshot: 'off', video: 'off' },
  webServer: { command: 'node test/browser-fixture.mjs', url: 'https://127.0.0.1:43181/app/', ignoreHTTPSErrors: true, reuseExistingServer: false, timeout: 20000 },
});
