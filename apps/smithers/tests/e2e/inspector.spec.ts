import { expect, test, type Page } from "@playwright/test";

/**
 * The gateway run inspector, reached from the runs list and by deep link.
 * Covers the tab matrix (Workflow UI / Inspector / Timeline), tree node
 * selection with real node output, and the waiting-approval state — each
 * asserting no uncaught page errors.
 */

/** Collect uncaught page errors so every state assertion also proves no crash. */
function trackPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  return errors;
}

type RpcFrame<T> = { ok?: boolean; payload?: T; error?: { message?: string } };

/** Call a real gateway RPC through the app origin (the vite proxy). */
async function rpc<T>(page: Page, method: string, data: Record<string, unknown> = {}): Promise<T> {
  const res = await page.request.post(`/v1/rpc/${method}`, { data });
  const frame = (await res.json()) as RpcFrame<T>;
  expect(frame.ok, `${method}: ${frame.error?.message ?? ""}`).toBe(true);
  return frame.payload as T;
}

type RunRow = { runId: string; workflowKey?: string; workflowName?: string; status?: string };

/** The lifecycle vocabulary the gateway may report for a successful run. */
const FINISHED = new Set(["succeeded", "finished", "completed", "ok"]);

/** A seeded e2e-task run that has completed (the instant no-agent task). */
async function findFinishedTaskRun(page: Page): Promise<RunRow> {
  let found: RunRow | undefined;
  await expect
    .poll(
      async () => {
        const runs = await rpc<RunRow[]>(page, "listRuns");
        found = runs.find(
          (run) => (run.workflowKey ?? run.workflowName) === "e2e-task" && FINISHED.has(run.status ?? ""),
        );
        return found !== undefined;
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  return found as RunRow;
}

/**
 * Launch a FRESH approval run via the real RPC and wait for its pending gate,
 * so the waiting-state spec never depends on how many seeded gates earlier
 * specs consumed.
 */
async function launchWaitingApprovalRun(page: Page): Promise<string> {
  const launched = await rpc<RunRow>(page, "launchRun", { workflow: "e2e-approval" });
  const runId = launched.runId;
  expect(runId).toBeTruthy();
  await expect
    .poll(
      async () => {
        const approvals = await rpc<Array<{ runId?: string }>>(page, "listApprovals");
        return approvals.some((approval) => approval.runId === runId);
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  return runId;
}

test("opening a run from the list shows the inspector", async ({ page }) => {
  await page.goto("/runs");
  await page.getByTestId("runs-row").first().click();
  await expect(page).toHaveURL(/\/gw\//);
  await expect(page.getByTestId("gateway-run-inspector")).toBeVisible();
});

test("deep-linking a run renders the inspector", async ({ page }) => {
  const res = await page.request.post("/v1/rpc/listRuns", { data: {} });
  const runs = (await res.json()).payload as Array<{ runId: string; workflowName?: string }>;
  const run = runs[0];
  await page.goto(`/gw/${run.workflowName ?? "e2e-task"}/${run.runId}`);
  await expect(page.getByTestId("gateway-run-inspector")).toBeVisible();
});

test("inspector tabs switch between workflow UI, tree, and timeline", async ({ page }) => {
  const pageErrors = trackPageErrors(page);
  const run = await findFinishedTaskRun(page);

  await page.goto(`/gw/e2e-task/${run.runId}`);
  await expect(page.getByTestId("gateway-run-inspector")).toBeVisible();

  // e2e-task is registered WITH a custom UI, so all three tabs render and the
  // default view is the workflow UI frame.
  await expect(page.getByTestId("gateway-view-flow")).toBeVisible();
  await expect(page.getByTestId("gateway-view-inspector")).toBeVisible();
  await expect(page.getByTestId("gateway-view-timeline")).toBeVisible();
  await expect(page.getByTestId("gateway-workflow-ui")).toBeVisible();

  // Inspector tab: the run tree replaces the workflow UI frame.
  await page.getByTestId("gateway-view-inspector").click();
  await expect(page.getByTestId("tree-row-compute")).toBeVisible();
  await expect(page.getByTestId("gateway-workflow-ui")).toHaveCount(0);

  // Timeline tab: navigates to the timeline subroute (the honest not-wired
  // empty state for gateway runs — not a crash, not "Run not found").
  await page.getByTestId("gateway-view-timeline").click();
  await expect(page).toHaveURL(/\/timeline$/);
  await expect(page.getByTestId("timeline-not-wired")).toBeVisible();

  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});

test("selecting a tree node loads its real output", async ({ page }) => {
  const pageErrors = trackPageErrors(page);
  const run = await findFinishedTaskRun(page);

  await page.goto(`/gw/e2e-task/${run.runId}`);
  await expect(page.getByTestId("gateway-run-inspector")).toBeVisible();
  await page.getByTestId("gateway-view-inspector").click();

  // Until a node is explicitly selected, the detail pane offers to load output.
  await expect(page.getByTestId("gateway-node-detail")).toBeVisible();
  await expect(page.getByTestId("gateway-node-detail")).toContainText("Select this node to load its output.");

  // Selecting the compute task highlights the row and loads its REAL output
  // over the getNodeOutput RPC — the literal { value: 42 } the seed task returns.
  await page.getByTestId("tree-row-compute").click();
  await expect(page.getByTestId("tree-row-compute")).toHaveClass(/is-selected/);
  await expect(page.getByTestId("gateway-node-detail")).toContainText("compute");
  await expect(page.getByTestId("gateway-node-output")).toBeVisible();
  await expect(page.getByTestId("gateway-node-output")).toContainText('"value": 42');

  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});

test("a waiting approval run shows the gate banner and pending node detail", async ({ page }) => {
  const pageErrors = trackPageErrors(page);
  const runId = await launchWaitingApprovalRun(page);

  await page.goto(`/gw/e2e-approval/${runId}`);
  await expect(page.getByTestId("gateway-run-inspector")).toBeVisible();

  // e2e-approval ships no custom UI: the inspector tree is the default view
  // and no Workflow UI tab renders.
  await expect(page.getByTestId("gateway-view-inspector")).toBeVisible();
  await expect(page.getByTestId("gateway-view-flow")).toHaveCount(0);

  // The real pending gate surfaces as the approval banner.
  await expect(page.getByTestId("gateway-approval-banner")).toBeVisible();
  await expect(page.getByTestId("gateway-approval-banner")).toContainText("Approve the deploy");
  await expect(page.getByTestId("gateway-approve-button")).toBeEnabled();

  // The blocked gate node renders as waiting in the tree; selecting it shows
  // the honest pending-output detail.
  const gate = page.getByTestId("tree-row-gate");
  await expect(gate).toBeVisible();
  await expect(gate).toContainText("waiting");
  await gate.click();
  await expect(gate).toHaveClass(/is-selected/);
  await expect(page.getByTestId("gateway-node-detail")).toContainText("No output for this node.");

  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});
