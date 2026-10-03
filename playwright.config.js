import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  // Web Bluetooth, Web Serial and WebUSB only exist in Chromium.
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  use: { baseURL: 'http://localhost:4199' },
  webServer: {
    command: 'npm run build && npm run preview -- --port 4199 --strictPort',
    url: 'http://localhost:4199/',
    reuseExistingServer: false, // a leftover preview server would serve a stale build
    timeout: 120_000,
  },
  reporter: process.env.CI ? 'github' : 'list',
});
