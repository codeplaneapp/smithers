import { expect, test } from "@playwright/test";

/** The gateway run inspector, reached from the runs list and by deep link. */
test("opening a run from the list shows the inspector", async ({ page }) => {
  await page.goto("/runs");
  await page.getByTestId("runs-row").first().click();
  await expect(page).toHaveURL(/\/gw\//);
  await expect(page.getByTestId("gateway-run-inspector")).toBeVisible();
});

test("deep-linking a run renders the inspector", async ({ page }) => {
  const res = await page.request.post("http://127.0.0.1:5180/v1/rpc/listRuns", { data: {} });
  const runs = (await res.json()).payload as Array<{ runId: string; workflowName?: string }>;
  const run = runs[0];
  await page.goto(`/gw/${run.workflowName ?? "e2e-task"}/${run.runId}`);
  await expect(page.getByTestId("gateway-run-inspector")).toBeVisible();
});
