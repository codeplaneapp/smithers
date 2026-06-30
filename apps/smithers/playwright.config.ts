import { defineConfig, devices } from "@playwright/test";

/**
 * Real-backend e2e for the local Smithers UI. No mocks: a real seed Gateway
 * (booted + seeded in globalSetup) plus the real Vite app, proxying RPC/WS to
 * the gateway. Browser-only, so it is NOT part of `pnpm -r test` (CI has no
 * browsers); run it with `pnpm -C apps/smithers e2e` after `playwright install`.
 */
const APP_PORT = Number(process.env.SMITHERS_E2E_APP_PORT ?? "5180");
const GATEWAY_PORT = Number(process.env.SMITHERS_E2E_GATEWAY_PORT ?? "7331");
const APP_ORIGIN = `http://127.0.0.1:${APP_PORT}`;
const GATEWAY_ORIGIN = `http://127.0.0.1:${GATEWAY_PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 0 : 1,
  reporter: process.env.CI ? "line" : [["list"]],
  globalSetup: "./tests/e2e/globalSetup.ts",
  globalTeardown: "./tests/e2e/globalTeardown.ts",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: APP_ORIGIN,
    trace: "on-first-retry",
    actionTimeout: 10_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `vite --host 127.0.0.1 --port ${APP_PORT} --strictPort`,
    url: APP_ORIGIN,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: { SMITHERS_GATEWAY_PROXY_TARGET: GATEWAY_ORIGIN },
  },
});
