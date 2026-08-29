import { defineConfig } from "@playwright/test"

/*
 * Test tier T2 (LOCAL-APP.md): the real Electrobun window over CDP. No web
 * server here; e2e/playwright/native/run.ts builds and launches the app and
 * hands the CDP endpoint to the spec through SMITHERS_NATIVE_CDP.
 */
export default defineConfig({
  testDir: "e2e/playwright/native",
  testMatch: ["**/*.native.spec.ts"],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? "github" : "list",
  timeout: 120_000
})
