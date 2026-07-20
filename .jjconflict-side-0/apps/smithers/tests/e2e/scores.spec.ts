import { expect, test } from "@playwright/test";
import {
  expectNoPageErrors,
  openRenderedSurface,
  trackPageErrors,
} from "./surfaceTestUtils";

test("renders the scores empty state", async ({ page }) => {
  const pageErrors = trackPageErrors(page);
  await openRenderedSurface(page, "scores-empty");
  await expect(page.getByTestId("scores-empty")).toContainText("No runs available");
  expectNoPageErrors(pageErrors);
});

test("switches score tabs and updates content when another scored run is selected", async ({ page }) => {
  const pageErrors = trackPageErrors(page);
  await page.goto("/scores");
  const selector = page.getByTestId("scores-run-selector");
  await expect(selector).toBeVisible();
  await expect.poll(async () => selector.locator("option").filter({ hasText: "e2e-task" }).count()).toBe(2);
  const values = await selector.locator("option").filter({ hasText: "e2e-task" }).evaluateAll(
    (options) => options.map((option) => (option as HTMLOptionElement).value),
  );

  await selector.selectOption(values[0]);
  await expect(page.getByTestId("scores-tab-summary")).toContainText("Quality");
  await expect(page.getByTestId("scores-tab-summary")).toContainText("Safety");

  await page.getByTestId("scores-tabs").getByRole("button", { name: "Metrics" }).click();
  const metrics = page.locator('[data-testid="scores-tab-metrics"]').last();
  await expect(metrics).toContainText("Latency");
  await expect(metrics).toContainText("2 nodes");

  await page.getByTestId("scores-tabs").getByRole("button", { name: "Recent" }).click();
  const recent = page.locator('[data-testid="scores-tab-recent"]').last();
  await expect(recent).toContainText(values[0]);
  await selector.selectOption(values[1]);
  await expect(recent).toContainText(values[1]);
  await expect(recent).not.toContainText(values[0]);
  expectNoPageErrors(pageErrors);
});
