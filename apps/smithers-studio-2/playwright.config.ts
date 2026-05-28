import { defineConfig, devices } from '@playwright/test';

const testPort = process.env.SMITHERS_STUDIO_TEST_PORT || '5500';
const gatewayPort = process.env.SMITHERS_STUDIO_GATEWAY_TEST_PORT || '7400';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL: `http://127.0.0.1:${testPort}`,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: `vite --host 127.0.0.1 --port ${testPort}`,
    port: parseInt(testPort),
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    env: {
      SMITHERS_STUDIO_GATEWAY_URL: `http://127.0.0.1:${gatewayPort}`,
    },
  },
});