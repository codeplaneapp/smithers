import { expect, test } from "@playwright/test";
import { expectNoPageErrors, trackPageErrors } from "./surfaceTestUtils";

/**
 * The suite starts with four real approval runs from globalSetup. Decisions go
 * through the live submitApproval RPC and are then inspected through the
 * canvas' optimistic history, which is the product's documented history model.
 */
test.describe.serial("approval matrix", () => {
  test("stacks the inbox and keeps the decision flow reachable at a narrow viewport", async ({ page }) => {
    const pageErrors = trackPageErrors(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/approvals");

    const canvas = page.getByTestId("approvals-canvas");
    const rows = page.getByTestId("approvals-pending-row");
    await expect(rows.first()).toBeVisible();
    const before = await rows.count();

    const layout = await canvas.evaluate((element) => {
      const list = element.querySelector<HTMLElement>(".appr-list")?.getBoundingClientRect();
      const detail = element.querySelector<HTMLElement>(".appr-detail")?.getBoundingClientRect();
      return {
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        listBottom: list?.bottom,
        detailTop: detail?.top,
      };
    });
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);
    expect(layout.listBottom).toBeLessThanOrEqual((layout.detailTop ?? 0) + 1);

    await rows.first().click();
    const detail = page.getByTestId("approvals-detail");
    await expect(detail).toBeVisible();
    await expect(page.getByTestId("approvals-note")).toBeVisible();
    await expect(page.getByTestId("approvals-approve")).toBeVisible();
    await expect(page.getByTestId("approvals-deny")).toBeVisible();

    await page.getByTestId("approvals-deny").click();
    const confirmation = page.getByTestId("approvals-deny-confirm");
    await expect(confirmation).toContainText("will fail the waiting gate");
    await page.getByTestId("approvals-deny-commit").scrollIntoViewIfNeeded();
    await expect(page.getByTestId("approvals-deny-commit")).toBeVisible();
    await expect(confirmation.getByRole("button", { name: "Cancel" })).toBeVisible();
    await confirmation.getByRole("button", { name: "Cancel" }).click();

    await page.getByTestId("approvals-note").fill("Approved from narrow coverage");
    await page.getByTestId("approvals-approve").click();
    await expect(page.getByText("Approval granted", { exact: true })).toBeVisible();
    await expect(rows).toHaveCount(before - 1, { timeout: 15_000 });
    expectNoPageErrors(pageErrors);
  });

  test("shows detail and payload, approves with a note, and renders history", async ({ page }) => {
    const pageErrors = trackPageErrors(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/approvals");
    const rows = page.getByTestId("approvals-pending-row");
    await expect(rows.first()).toBeVisible();
    const before = await rows.count();

    const desktopLayout = await page.getByTestId("approvals-canvas").evaluate((element) => {
      const list = element.querySelector<HTMLElement>(".appr-list")?.getBoundingClientRect();
      const detail = element.querySelector<HTMLElement>(".appr-detail")?.getBoundingClientRect();
      return {
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        listRight: list?.right,
        detailLeft: detail?.left,
      };
    });
    expect(desktopLayout.scrollWidth).toBeLessThanOrEqual(desktopLayout.clientWidth);
    expect(desktopLayout.listRight).toBeLessThanOrEqual((desktopLayout.detailLeft ?? 0) + 1);

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
