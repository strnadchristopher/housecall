import { defineConfig, devices } from '@playwright/test';

/**
 * UI-lane browser tests: the real App.tsx with the designed UI against the
 * in-memory fixture API. Separate ports (fixture 3131, app 1521) and its own
 * browser contexts. A pass here means the presentation keeps the contract;
 * it is not evidence for the Rust server, media, or native devices.
 */
export default defineConfig({
  testDir: '.',
  testMatch: 'ui.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  reporter: [['list'], ['json', { outputFile: '../../../../evidence/ui/app-e2e.json' }]],
  use: { baseURL: 'http://127.0.0.1:1521', trace: 'off', screenshot: 'off' },
  webServer: [
    { command: 'node src/ui/workbench/fixture-api.mjs', url: 'http://127.0.0.1:3131/api/health', reuseExistingServer: false, cwd: '../../..' },
    { command: 'npx vite --config src/ui/workbench/app.vite.config.ts', url: 'http://127.0.0.1:1521', reuseExistingServer: false, cwd: '../../..' },
  ],
  projects: [
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } }, grepInvert: /@phone/ },
    { name: 'phone', use: { ...devices['Pixel 7'], browserName: 'chromium' }, grep: /@phone/ },
  ],
});
