import { expect, test, type Page } from "@playwright/test";

/**
 * Runs surface, against the real seeded gateway (6 runs: completed tasks plus
 * waiting-approval runs). Covers the full list state matrix: populated grouped
 * sections, no-match search + status filtering with Clear recovery, and row
 * selection into the gateway inspector — each asserting no uncaught page errors.
 */

/** Collect uncaught page errors so every state assertion also proves no crash. */
function trackPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  return errors;
}

/** Launch a run through the real gateway RPC (the same path globalSetup uses). */
async function launchRun(page: Page, workflow: string): Promise<void> {
  const res = await page.request.post("/v1/rpc/launchRun", { data: { workflow } });
  const frame = (await res.json()) as { ok?: boolean; error?: { message?: string } };
  expect(frame.ok, `launchRun ${workflow}: ${frame.error?.message ?? ""}`).toBe(true);
}

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

test("renders grouped sections for active and completed runs", async ({ page }) => {
  const pageErrors = trackPageErrors(page);

  // Guarantee a live ACTIVE row regardless of how many seeded gates earlier
  // specs consumed: launch a fresh approval run through the real RPC.
  await launchRun(page, "e2e-approval");

  await page.goto("/runs");
  await expect(page.getByTestId("runs-canvas")).toBeVisible();
  await expect(page.getByTestId("runs-toolbar")).toBeVisible();
  await expect(page.getByTestId("runs-stream-badge")).toBeVisible();

  // The roster partitions into the fixed sections: the fresh approval run sits
  // in ACTIVE, the completed seed tasks in COMPLETED.
  const active = page.getByTestId("runs-group").filter({ hasText: "ACTIVE" });
  const completed = page.getByTestId("runs-group").filter({ hasText: "COMPLETED" });
  await expect(active.getByTestId("runs-row").first()).toBeVisible();
  await expect(completed.getByTestId("runs-row").first()).toBeVisible();

  // Status renders as a normalized per-row pill with both a dot and visible label.
  await expect(active.locator(".status-pill").filter({ hasText: "Waiting for approval" }).first()).toBeVisible();
  await expect(completed.locator(".status-pill").filter({ hasText: "Finished" }).first()).toBeVisible();

  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});

test("a no-match search shows the empty state and Clear restores the roster", async ({ page }) => {
  const pageErrors = trackPageErrors(page);
  await page.goto("/runs");
  await expect(page.getByTestId("runs-row").first()).toBeVisible();

  await page.getByTestId("runs-search").fill("no-such-run-zzzz");
  await expect(page.getByTestId("runs-row")).toHaveCount(0);
  await expect(page.getByText("No runs found.")).toBeVisible();

  await page.getByTestId("runs-clear").click();
  await expect(page.getByTestId("runs-row").first()).toBeVisible();
  await expect(page.getByTestId("runs-clear")).toHaveCount(0);
  await expect(page.getByTestId("runs-search")).toHaveValue("");

  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});

test("a status filter with no matching runs shows the empty state", async ({ page }) => {
  const pageErrors = trackPageErrors(page);
  await page.goto("/runs");
  await expect(page.getByTestId("runs-row").first()).toBeVisible();

  // Nothing in the suite cancels a run, so Cancelled is a guaranteed no-match.
  await page.getByRole("button", { name: /^Status:/ }).click();
  await page.getByRole("menuitemradio", { name: "Cancelled" }).click();
  await expect(page.getByTestId("runs-row")).toHaveCount(0);
  await expect(page.getByText("No runs found.")).toBeVisible();

  await page.getByTestId("runs-clear").click();
  await expect(page.getByTestId("runs-row").first()).toBeVisible();

  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});

test("filtering by Finished narrows the roster to the COMPLETED section", async ({ page }) => {
  const pageErrors = trackPageErrors(page);
  await page.goto("/runs");
  await expect(page.getByTestId("runs-row").first()).toBeVisible();

  await page.getByRole("button", { name: /^Status:/ }).click();
  await page.getByRole("menuitemradio", { name: "Finished" }).click();

  await expect(page.getByTestId("runs-group")).toHaveCount(1);
  await expect(page.getByTestId("runs-group")).toContainText("COMPLETED");
  await expect(page.getByTestId("runs-row").first()).toBeVisible();

  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});

test("selecting a run keeps the row highlighted back on the roster", async ({ page }) => {
  const pageErrors = trackPageErrors(page);
  await page.goto("/runs");
  const first = page.getByTestId("runs-row").first();
  await expect(first).toBeVisible();
  const shortId = (await first.locator(".runs-row-id").innerText()).trim();

  await first.click();
  await expect(page).toHaveURL(/\/gw\//);
  await expect(page.getByTestId("gateway-run-inspector")).toBeVisible();

  // Back on the roster the clicked row — and only it — carries the selection.
  await page.goBack();
  await expect(page.getByTestId("runs-canvas")).toBeVisible();
  const selected = page.locator(".runs-row.is-on");
  await expect(selected).toHaveCount(1);
  await expect(selected.locator(".runs-row-id")).toHaveText(shortId);

  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});
