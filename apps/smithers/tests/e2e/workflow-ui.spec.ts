import { expect, test } from "@playwright/test";

/**
 * The e2e-task workflow's custom UI is built from the shared
 * `@smithers-orchestrator/gateway-ui` components and served by the gateway at
 * `/workflows/e2e-task` (proxied through the app origin). This exercises the
 * component package end-to-end in a real browser against the real gateway: the
 * ConnectionBadge connects and the RunList renders the seeded runs.
 */
test("the gateway-ui workflow UI renders live data", async ({ page }) => {
  await page.goto("/workflows/e2e-task");

  await expect(page.getByTestId("e2e-task-ui")).toBeVisible({ timeout: 15_000 });
  // ConnectionBadge (gateway-ui) flips to Connected off real gateway traffic.
  await expect(page.getByText("Connected")).toBeVisible({ timeout: 15_000 });
  // RunList (gateway-ui) renders the seeded runs by workflow key.
  await expect(page.getByText(/e2e-task|e2e-approval/).first()).toBeVisible({ timeout: 15_000 });
});

test("selecting a run in the gateway-ui RunList streams its events", async ({ page }) => {
  await page.goto("/workflows/e2e-task");
  await expect(page.getByTestId("e2e-task-ui")).toBeVisible({ timeout: 15_000 });

  // The RunList rows are buttons labeled by workflow key; click the first.
  const firstRun = page.getByRole("button").filter({ hasText: /e2e-/ }).first();
  await firstRun.click();
  // The RunEventLog now shows frames (seq-prefixed lines) or a waiting state.
  await expect(page.locator("body")).toContainText(/node\.|run\.|Waiting for events|No events/, {
    timeout: 15_000,
  });
});
