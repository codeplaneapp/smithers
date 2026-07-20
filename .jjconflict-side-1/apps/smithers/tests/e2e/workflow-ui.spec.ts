import { expect, test, type Page } from "@playwright/test";

/**
 * Rendered-state coverage for the workflow UI surfaces the seed gateway serves
 * at `/workflows/<key>` (proxied through the app origin). No mocks: every spec
 * drives a real bundled UI in a real browser against the real gateway.
 *
 * The state matrix covered here:
 * - populated run state (e2e-task has seeded, completed runs);
 * - empty run state (implement is registered with a UI but never launched);
 * - live connection status (ConnectionBadge driven by real gateway traffic);
 * - run selection + event rendering (RunList → RunEventLog frames);
 * - disabled/enabled launch controls (implement's idle launch buttons);
 * - uncaught runtime-error detection for EVERY workflow UI registered with
 *   `hasUi` on the gateway (each bundle must mount cleanly).
 */

type WorkflowSummary = { key: string; hasUi?: boolean };

async function workflowsWithUi(page: Page): Promise<string[]> {
  const res = await page.request.post("/v1/rpc/listWorkflows", { data: {} });
  const frame = (await res.json()) as { ok?: boolean; payload?: WorkflowSummary[] };
  expect(frame.ok).toBe(true);
  return (frame.payload ?? []).filter((w) => w.hasUi).map((w) => w.key);
}

test("the gateway-ui workflow UI renders live data", async ({ page }) => {
  await page.goto("/workflows/e2e-task");

  await expect(page.getByTestId("e2e-task-ui")).toBeVisible({ timeout: 15_000 });
  // ConnectionBadge (gateway-ui) flips to Connected off real gateway traffic;
  // its data-status attribute exposes the live transport state. It is the
  // root's only direct-child span (RunList StatusPills carry run statuses).
  await expect(page.getByText("Connected")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("e2e-task-ui").locator("> span[data-status]")).toHaveAttribute(
    "data-status",
    "online",
  );
  // RunList (gateway-ui) renders the seeded runs by workflow key — the
  // populated state: at least one selectable run row with a StatusPill (the
  // seeded e2e-approval runs are deterministically waiting on their gate).
  await expect(page.getByText(/e2e-task|e2e-approval/).first()).toBeVisible({ timeout: 15_000 });
  expect(
    await page.getByRole("button").filter({ hasText: /e2e-/ }).count(),
  ).toBeGreaterThan(0);
  await expect(
    page.locator('[data-status="waiting-approval"], [data-status="finished"]').first(),
  ).toBeVisible();
  // RunEventLog renders its no-selection empty state until a run is picked.
  await expect(page.getByText("Select a run to stream its events.")).toBeVisible();
});

test("selecting a run in the gateway-ui RunList streams its events", async ({ page }) => {
  await page.goto("/workflows/e2e-task");
  await expect(page.getByTestId("e2e-task-ui")).toBeVisible({ timeout: 15_000 });

  // The RunList rows are buttons labeled by workflow key; click the first.
  const firstRun = page.getByRole("button").filter({ hasText: /e2e-/ }).first();
  await firstRun.click();
  // The no-selection empty state is replaced by the stream…
  await expect(page.getByText("Select a run to stream its events.")).toBeHidden({
    timeout: 15_000,
  });
  // …and real frames render: the seeded runs executed, so the log shows
  // seq-prefixed engine event lines (every run commits at least frame 1 and a
  // status change), not just a waiting placeholder.
  await expect(page.getByTestId("e2e-task-ui")).toContainText(
    /FrameCommitted|RunStatusChanged/,
    { timeout: 15_000 },
  );
  await expect(page.getByTestId("e2e-task-ui")).toContainText("0001");
});

test("a workflow UI with zero runs renders its empty state with idle launch controls", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));

  // The seed suite never launches `implement`, so its UI deterministically
  // renders the empty run state — on CI and locally alike (the gateway DB is
  // reset per invocation).
  await page.goto("/workflows/implement");
  await expect(page.getByTestId("implement-ui")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("implement-empty")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("implement-empty")).toContainText("No run yet.");

  // Launch controls are enabled while idle (they only disable while a launch
  // RPC is in flight), so the empty state is actionable.
  await expect(page.getByTestId("implement-launch")).toBeEnabled();
  await expect(page.getByTestId("implement-launch-empty")).toBeEnabled();

  // The bundle mounted with no uncaught runtime errors in the empty state.
  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});

test("every registered workflow UI mounts without uncaught runtime errors", async ({ page }) => {
  // Visiting every registered UI (some bundles are heavy) needs more than the
  // per-test default.
  test.setTimeout(240_000);

  const keys = await workflowsWithUi(page);
  // Sanity: the matrix is not vacuous — the seed gateway registers at least
  // the e2e-task UI and the create-workflow pack UI.
  expect(keys).toEqual(expect.arrayContaining(["e2e-task", "create-workflow"]));

  for (const key of keys) {
    const pageErrors: string[] = [];
    const onPageError = (err: Error) => pageErrors.push(`${key}: ${String(err)}`);
    page.on("pageerror", onPageError);

    await page.goto(`/workflows/${key}`);
    // Every workflow UI mounts a `<key>-ui` root; runs or no runs, the bundle
    // must render it without throwing.
    await expect(page.getByTestId(`${key}-ui`), `${key} UI root mounts`).toBeVisible({
      timeout: 30_000,
    });
    expect(pageErrors, pageErrors.join("\n")).toEqual([]);

    page.off("pageerror", onPageError);
  }
});
