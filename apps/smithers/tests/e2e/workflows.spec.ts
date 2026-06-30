import { expect, test } from "@playwright/test";

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
