import { expect, test } from "@playwright/test";

/**
 * Approvals surface, against the real seeded gateway (4 pending gates from the
 * e2e-approval runs). Approve and Deny submit real decisions over RPC — no
 * mocks — and the pending queue shrinks as the gateway resolves each gate.
 */
test("lists the pending approval gates", async ({ page }) => {
  await page.goto("/approvals");
  await expect(page.getByTestId("approvals-canvas")).toBeVisible();
  await expect(page.getByTestId("approvals-pending-row").first()).toBeVisible();
});

test("approving a gate removes it from the pending queue", async ({ page }) => {
  await page.goto("/approvals");
  const rows = page.getByTestId("approvals-pending-row");
  await expect(rows.first()).toBeVisible();
  const before = await rows.count();

  await rows.first().click();
  await page.getByTestId("approvals-approve").click();

  await expect(rows).toHaveCount(before - 1, { timeout: 15_000 });
});

test("denying a gate (with confirm) removes it from the pending queue", async ({ page }) => {
  await page.goto("/approvals");
  const rows = page.getByTestId("approvals-pending-row");
  await expect(rows.first()).toBeVisible();
  const before = await rows.count();

  await rows.first().click();
  await page.getByTestId("approvals-deny").click();
  await page.getByTestId("approvals-deny-commit").click();

  await expect(rows).toHaveCount(before - 1, { timeout: 15_000 });
});
