import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:8790',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 10000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node tests/e2e/mock-upstream.mjs',
      url: 'http://127.0.0.1:8791/health',
      reuseExistingServer: false,
      timeout: 30000,
    },
    {
      command: 'node dist/cli.js --port 8790 --data-dir ./data-e2e',
      url: 'http://localhost:8790/health',
      timeout: 60000,
      reuseExistingServer: false,
    },
  ],
  outputDir: 'test-results/e2e',
});