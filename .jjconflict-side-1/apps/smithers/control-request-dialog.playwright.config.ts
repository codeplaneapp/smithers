import { defineConfig, devices } from "@playwright/test";

const appPort = Number(process.env.SMITHERS_E2E_APP_PORT ?? "5180");
const appOrigin = `http://127.0.0.1:${appPort}`;

/**
 * This interaction test only uses the real rendered control-request surface,
 * so it intentionally avoids the gateway-backed suite's global setup.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "control-request-dialog.spec.ts",
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? "line" : [["list"]],
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: appOrigin,
    trace: "on-first-retry",
    actionTimeout: 10_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `vite --host 127.0.0.1 --port ${appPort} --strictPort`,
    url: appOrigin,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
