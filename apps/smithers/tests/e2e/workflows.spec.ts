import { expect, test } from "@playwright/test";
import { expectNoPageErrors, openRenderedSurface, trackPageErrors } from "./surfaceTestUtils";

/**
 * Launching a workflow from the store — the deterministic side of "the agent
 * backgrounds workflows" (no LLM): the store's per-workflow Launch button calls
 * the real gateway launchRun RPC. The concierge reaches the SAME client path via
 * its smithers:action directives.
 */
test("the workflow store lists the registered workflow", async ({ page }) => {
  await page.goto("/store");
  await expect(page.locator(".store")).toBeVisible();
  await expect(page.getByTestId("gateway-wf-e2e-task")).toBeVisible({ timeout: 15_000 });
});

test("launching a workflow from the store creates a real run", async ({ page }) => {
  await page.goto("/store");
  const countRuns = async () => {
    const res = await page.request.post("/v1/rpc/listRuns", { data: {} });
    return (((await res.json()).payload as unknown[]) ?? []).length;
  };
  const before = await countRuns();
  const card = page.getByTestId("gateway-wf-e2e-task");
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.getByRole("button", { name: /launch/i }).click();
  await expect.poll(countRuns, { timeout: 15_000 }).toBeGreaterThan(before);
});

test("renders empty and loading workflow-store states", async ({ page }) => {
  const pageErrors = trackPageErrors(page);
  await openRenderedSurface(page, "store-empty");
  await expect(page.getByTestId("store-empty")).toContainText("No workflows registered");
  await openRenderedSurface(page, "store-loading");
  await expect(page.getByTestId("store-loading")).toContainText("Loading workflows");
  expectNoPageErrors(pageErrors);
});

test("opens the editor and covers source, imports, runs, app, launch, save, and discard flows", async ({ page }) => {
  const pageErrors = trackPageErrors(page);
  await page.goto("/store");
  const implementCard = page.locator(".store-card").filter({ hasText: "Implement" }).first();
  await expect(implementCard).toBeVisible();
  await implementCard.locator('[role="button"]').filter({ hasText: "Edit" }).click();
  await expect(page.getByTestId("workflow-editor-canvas")).toBeVisible();
  await expect(page.getByTestId("wfe-source-tab")).toBeVisible();

  const source = page.getByTestId("wfe-source-editor");
  const originalSource = await source.inputValue();
  await source.fill(`${originalSource}\n// rendered coverage draft`);
  await expect(page.getByTestId("wfe-unsaved-count")).toContainText("1 unsaved");

  await page.getByTestId("wfe-tab-imports").click();
  await expect(page.getByTestId("wfe-import-row")).toHaveCount(2);
  const importEditor = page.getByTestId("wfe-import-editor");
  await importEditor.fill(`${await importEditor.inputValue()}\n// import draft`);
  await expect(page.getByTestId("wfe-unsaved-count")).toContainText("2 unsaved");

  const reviewRow = page.getByTestId("wfe-rail-row").filter({ hasText: "Review" });
  await reviewRow.click();
  await expect(page.getByTestId("wfe-discard-confirm")).toContainText("Unsaved Changes");
  await page.getByTestId("wfe-discard-confirm").getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByTestId("wfe-rail-row").filter({ hasText: "Implement" })).toHaveClass(/is-on/);
  await page.getByTestId("wfe-save-all").click();
  await expect(page.getByTestId("wfe-unsaved-count")).toHaveCount(0);

  await page.getByTestId("wfe-tab-runs").click();
  await expect(page.getByTestId("wfe-runs-row")).toHaveCount(2);
  await page.getByTestId("wfe-tab-launch").click();
  await expect(page.getByTestId("wfe-doctor")).toBeVisible();
  await page.getByTestId("wfe-run-doctor").click();
  await expect(page.getByTestId("wfe-doctor")).toContainText("Workflow source parses");
  await expect(page.getByTestId("wfe-dag-node")).not.toHaveCount(0);
  await expect(page.getByTestId("wfe-launch-inputs")).toBeVisible();
  await page.getByTestId("wfe-run-workflow").click();
  await expect(page.getByTestId("wfe-launch-field").filter({ hasText: "task" })).toContainText("task is required");
  await expect(page.getByTestId("wfe-run-workflow")).toBeDisabled();
  await page.getByTestId("wfe-launch-field").filter({ hasText: "task" }).locator("input").fill("rendered launch");
  await expect(page.getByTestId("wfe-run-workflow")).toBeEnabled();
  await page.getByTestId("wfe-run-workflow").click();
  await expect(page.getByTestId("wfe-launch-inputs")).toContainText("Last run: running");

  await page.getByTestId("wfe-rail-row").filter({ hasText: "Kanban" }).click();
  await page.getByTestId("wfe-tab-app").click();
  await expect(page.getByTestId("wfe-app-tab")).toContainText("Kanban Board");
  await expect(page.getByTestId("wfe-app-tab")).toContainText("Live");
  expectNoPageErrors(pageErrors);
});
