import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e', testMatch: '**/hosted.spec.ts', workers: 1, fullyParallel: false, timeout: 90000,
  reporter: [['list'], ['json', { outputFile: 'test-results/hosted.json' }]],
  use: { baseURL: 'https://127.0.0.1:43185', ignoreHTTPSErrors: true, trace: 'off', screenshot: 'off', video: 'off', launchOptions: { args: ['--host-resolver-rules=MAP alpha.fixture.org 127.0.0.1, MAP beta.fixture.org 127.0.0.1', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } },
  webServer: { command: 'node tests/hosted-fixture.mjs', url: 'https://127.0.0.1:43185/', ignoreHTTPSErrors: true, reuseExistingServer: false, timeout: 30000 },
  projects: [{ name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1440, height: 1000 } } }, { name: '390px', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } }],
});
