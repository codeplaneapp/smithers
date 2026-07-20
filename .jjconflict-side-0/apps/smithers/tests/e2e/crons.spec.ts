import { expect, test } from "@playwright/test";
import { expectNoPageErrors, trackPageErrors } from "./surfaceTestUtils";

async function cronState(page: import("@playwright/test").Page): Promise<Array<{ enabled: boolean }>> {
  const response = await page.request.post("/v1/rpc/cronList", { data: {} });
  const frame = (await response.json()) as { payload?: Array<{ enabled: boolean }> };
  return (frame.payload ?? []).map((row) => ({ enabled: row.enabled }));
}

test("creates, validates, toggles, and deletes a real cron trigger", async ({ page }) => {
  const pageErrors = trackPageErrors(page);
  await page.goto("/crons");
  await expect(page.getByTestId("crons-empty")).toBeVisible();

  await page.getByTestId("crons-new-toggle").click();
  await expect(page.getByTestId("crons-validation")).toContainText(
    "Cron pattern and workflow key are required.",
  );
  await expect(page.getByTestId("crons-create-submit")).toBeDisabled();
  await page.getByTestId("crons-create-pattern").fill("99 * * * *");
  await page.getByTestId("crons-create-path").fill("e2e-task");
  await expect(page.getByTestId("crons-validation")).toContainText(
    "Not a valid 5-field cron pattern.",
  );

  await page.getByTestId("crons-create-pattern").fill("*/15 * * * *");
  await expect(page.getByTestId("crons-create-submit")).toBeEnabled();
  await page.getByTestId("crons-create-submit").click();
  const row = page.getByTestId("crons-row").filter({ hasText: "e2e-task" });
  await expect(row).toContainText("ENABLED");
  await expect(page.locator(".rev-detail")).toContainText("Every 15 minutes");
  await expect.poll(async () => cronState(page)).toEqual([{ enabled: true }]);

  await page.getByTestId("crons-toggle").click();
  await expect(row).toContainText("DISABLED");
  await expect(page.getByTestId("crons-toggle")).toContainText("Enable");
  await expect.poll(async () => cronState(page)).toEqual([{ enabled: false }]);
  await page.getByTestId("crons-toggle").click();
  await expect(row).toContainText("ENABLED");
  await expect.poll(async () => cronState(page)).toEqual([{ enabled: true }]);

  await page.getByTestId("crons-delete").click();
  await expect(page.getByTestId("crons-confirm")).toContainText("cannot be undone");
  await page.getByTestId("crons-confirm-delete").click();
  await expect(page.getByTestId("crons-empty")).toBeVisible();
  await expect(page.locator(".rev-detail")).toContainText("Select a trigger.");
  await expect.poll(async () => cronState(page)).toEqual([]);
  expectNoPageErrors(pageErrors);
});
