import { expect, test } from "@playwright/test";

/**
 * Runs surface, against the real seeded gateway (6 runs: completed tasks plus
 * waiting-approval runs).
 */
test("lists the seeded runs", async ({ page }) => {
  await page.goto("/runs");
  await expect(page.getByTestId("runs-canvas")).toBeVisible();
  await expect(page.getByTestId("runs-row").first()).toBeVisible();
  expect(await page.getByTestId("runs-row").count()).toBeGreaterThanOrEqual(5);
});

test("opening a run shows the gateway inspector", async ({ page }) => {
  await page.goto("/runs");
  await page.getByTestId("runs-row").first().click();
  await expect(page).toHaveURL(/\/gw\//);
  await expect(page.getByTestId("gateway-run-inspector")).toBeVisible();
});

test("searching filters the runs list without crashing", async ({ page }) => {
  await page.goto("/runs");
  await expect(page.getByTestId("runs-row").first()).toBeVisible();
  await page.getByTestId("runs-search").fill("e2e-approval");
  await expect(page.getByTestId("runs-clear")).toBeVisible();
  // The surface still renders rows (the approval runs match).
  await expect(page.getByTestId("runs-row").first()).toBeVisible();
});
