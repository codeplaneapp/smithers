import { expect, test } from "@playwright/test";
import { expectNoPageErrors, trackPageErrors } from "./surfaceTestUtils";

/**
 * The suite starts with four real approval runs from globalSetup. Decisions go
 * through the live submitApproval RPC and are then inspected through the
 * canvas' optimistic history, which is the product's documented history model.
 */
test.describe.serial("approval matrix", () => {
  test("shows detail and payload, approves with a note, and renders history", async ({ page }) => {
    const pageErrors = trackPageErrors(page);
    await page.goto("/approvals");
    const rows = page.getByTestId("approvals-pending-row");
    await expect(rows.first()).toBeVisible();
    const before = await rows.count();
    await rows.first().click();

    const detail = page.getByTestId("approvals-detail");
    await expect(detail).toContainText("Approve the deploy");
    await expect(page.getByTestId("approvals-workflow")).toHaveText("e2e-approval");
    await expect(page.getByTestId("approvals-run-id")).not.toBeEmpty();
    await expect(page.getByTestId("approvals-node-id")).toHaveText("gate");
    await expect(page.getByTestId("approvals-iteration")).toHaveText("0");
    await expect(page.getByTestId("approvals-requested-at")).toHaveText(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    await expect(detail).toContainText("PENDING");
    await expect(page.getByTestId("approvals-payload")).toContainText("Approving this gate lets the gated task run.");
    const wait = page.getByTestId("approvals-wait-time").first();
    await expect(wait).toHaveAttribute("data-wait-state", "fresh");
    const initialWait = await wait.textContent();
    await expect.poll(async () => wait.textContent(), { timeout: 3_000 }).not.toBe(initialWait);
    await page.getByTestId("approvals-note").fill("Approved by rendered coverage");
    await page.getByTestId("approvals-approve").click();
    await expect(rows).toHaveCount(before - 1, { timeout: 15_000 });

    await page.getByTestId("approvals-tabs").getByRole("button", { name: "History" }).click();
    await expect(page.getByTestId("approvals-history-row")).toHaveCount(1);
    await expect(page.getByTestId("approvals-detail")).toContainText("APPROVED");
    await expect(page.getByTestId("approvals-detail")).toContainText("Approved by rendered coverage");
    await expect(page.getByTestId("approvals-detail")).toContainText("Resolved By");
    await expect(page.getByTestId("approvals-payload")).toContainText("gated task run");
    expectNoPageErrors(pageErrors);
  });

  test("cancels then confirms denial and preserves the denied history detail", async ({ page }) => {
    const pageErrors = trackPageErrors(page);
    await page.goto("/approvals");
    const rows = page.getByTestId("approvals-pending-row");
    await expect(rows.first()).toBeVisible();
    const before = await rows.count();
    await rows.first().click();
    await page.getByTestId("approvals-note").fill("Denied by rendered coverage");
    await page.getByTestId("approvals-deny").click();
    await expect(page.getByTestId("approvals-deny-confirm")).toContainText("will fail the waiting gate");
    await page.getByTestId("approvals-deny-confirm").getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByTestId("approvals-deny-confirm")).toHaveCount(0);
    await page.getByTestId("approvals-deny").click();
    await page.getByTestId("approvals-deny-commit").click();
    await expect(rows).toHaveCount(before - 1, { timeout: 15_000 });

    await page.getByTestId("approvals-tabs").getByRole("button", { name: "History" }).click();
    await expect(page.getByTestId("approvals-history-row")).toHaveCount(1);
    await expect(page.getByTestId("approvals-detail")).toContainText("DENIED");
    await expect(page.getByTestId("approvals-detail")).toContainText("Denied by rendered coverage");
    expectNoPageErrors(pageErrors);
  });

  test("resolves the remaining real gates and renders pending and history empty states", async ({ page }) => {
    const pageErrors = trackPageErrors(page);
    await page.goto("/approvals");
    const rows = page.getByTestId("approvals-pending-row");
    const remaining = await rows.count();
    while ((await rows.count()) > 0) {
      const before = await rows.count();
      await rows.first().click();
      await page.getByTestId("approvals-approve").click();
      await expect(rows).toHaveCount(before - 1, { timeout: 15_000 });
    }
    await expect(page.getByTestId("approvals-empty")).toContainText("No pending approvals");
    await expect(page.getByText("Nothing to review.")).toBeVisible();

    await page.getByTestId("approvals-tabs").getByRole("button", { name: "History" }).click();
    await expect(page.getByTestId("approvals-history-row")).toHaveCount(remaining);

    // A reload documents the current real contract: the gateway only returns
    // pending gates, so client-side decision history starts empty.
    await page.reload();
    await page.getByTestId("approvals-tabs").getByRole("button", { name: "History" }).click();
    await expect(page.getByTestId("approvals-empty")).toContainText("No recent decisions");
    await expect(page.getByText("Nothing to review.")).toBeVisible();
    expectNoPageErrors(pageErrors);
  });
});
