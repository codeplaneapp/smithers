/** @jsxImportSource react */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

// The entry is deliberately safe to load on the gateway/server: neither this
// test nor an import of monitorApp gets a synthetic #root before registration.
const appWithoutDom = await import("../src/monitor-ui/monitorApp.tsx");
const entryWithoutDom = await import("../src/monitor-ui/monitor.tsx");
expect(typeof document).toBe("undefined");
expect(typeof appWithoutDom.App).toBe("function");
expect(typeof entryWithoutDom.StatusTag).toBe("function");

// Match the monitor-shell-controls ordering: radix decides whether to use
// layout effects as it loads, so install the DOM before React/UI imports.
const nativeFetch = globalThis.fetch;
const previousReactActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
GlobalRegistrator.register();
globalThis.fetch = nativeFetch;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
type ReactElement = import("react").ReactElement;
type Root = import("react-dom/client").Root;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const css = await import("../src/monitor-ui/monitorCss.ts");
const shared = await import("../src/monitor-ui/monitorShared.tsx");
const runs = await import("../src/monitor-ui/monitorRuns.tsx");
const ops = await import("../src/monitor-ui/monitorOps.tsx");
const scores = await import("../src/monitor-ui/monitorScores.tsx");
const entry = await import("../src/monitor-ui/monitor.tsx");
const modules = await Promise.all([
  import("../src/monitor-ui/monitorMetrics.tsx"),
  import("../src/monitor-ui/monitorExecution.tsx"),
  import("../src/monitor-ui/monitorEventLog.tsx"),
  import("../src/monitor-ui/monitorHealth.tsx"),
  import("../src/monitor-ui/monitorNodeInspector.tsx"),
  import("../src/monitor-ui/monitorRunDetail.tsx"),
]);

let container: HTMLElement | undefined;
let root: Root | undefined;

afterEach(async () => {
  if (root) {
    const renderedRoot = root;
    await act(async () => renderedRoot.unmount());
    root = undefined;
  }
  container?.remove();
  container = undefined;
});

afterAll(async () => {
  try {
    await GlobalRegistrator.unregister();
  } finally {
    globalThis.fetch = nativeFetch;
    if (previousReactActEnvironment === undefined) delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    else (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousReactActEnvironment;
  }
});

async function render(element: ReactElement): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const renderedRoot = root;
  await act(async () => renderedRoot.render(element));
}

describe("monitor UI module seams", () => {
  test("exports each focused family directly and preserves compatibility identities", () => {
    expect(css.monitorCss).toBe(entry.monitorCss);
    expect(shared.StatusTag).toBe(entry.StatusTag);
    expect(ops.StatCard).toBe(entry.StatCard);
    expect(runs.RunsRail).toBe(entry.RunsRail);
    expect(runs.RunsTable).toBe(entry.RunsTable);
    expect(runs.RunProgressCell).toBe(entry.RunProgressCell);
    expect(typeof shared.useJsonApi).toBe("function");
    expect(typeof runs.ApprovalsInbox).toBe("function");
    expect(typeof ops.OpsStrip).toBe("function");
    expect(typeof scores.ScoresPanel).toBe("function");
    expect(typeof modules[0].MetricsPanel).toBe("function");
    expect(typeof modules[1].ExecutionPanel).toBe("function");
    expect(typeof modules[1].TreeNode).toBe("undefined"); // type-only export
    expect(typeof modules[2].EventLog).toBe("function");
    expect(typeof modules[3].HealthStrip).toBe("function");
    expect(typeof modules[4].NodeInspector).toBe("function");
    expect(typeof modules[5].RunDetail).toBe("function");
  });

  test("renders compatibility panels with status, empty/loading, pagination, and score contracts", async () => {
    const run = {
      runId: "run-module-42", workflowKey: "module-test", status: "failed",
      createdAtMs: Date.now() - 2_000, startedAtMs: Date.now() - 1_000,
      finishedAtMs: Date.now() - 100, summary: { finished: 3, failed: 1, pending: 1 },
    };
    const tableRuns = Array.from({ length: 26 }, (_, index) => ({ ...run, runId: `run-module-${index}` }));
    await render(
      <div>
        <shared.StatusTag status="running" />
        <shared.StatusTag status="failed" />
        <ops.StatCard value="7" label="active" tone="waiting" testId="module-stat" />
        <runs.RunProgressCell run={run} />
        <runs.RunsRail runs={[]} loading connStatus="connected" selectedRunId={undefined} onSelect={() => {}} />
        <runs.RunsRail runs={[]} loading={false} connStatus="online" selectedRunId={undefined} onSelect={() => {}} />
        <runs.RunsTable runs={tableRuns} loading={false} page={1} onPageChange={() => {}} onSelect={() => {}} />
        <scores.ScoresPanel scores={{ loaded: true, rows: [{ scorerId: "quality", scorerName: "Quality", nodeId: "build", iteration: 0, attempt: 1, score: 0.9, reason: "great" }] }} />
      </div>,
    );
    expect(document.querySelector('[data-status="running"]')?.className).toContain("tone-running");
    expect(document.querySelector('[data-status="failed"]')?.className).toContain("tone-failed");
    expect(document.querySelector('[data-testid="module-stat"]')?.textContent).toContain("active");
    expect(document.querySelector('[data-testid="monitor-run-progress"]')?.textContent).toContain("4/5");
    expect(document.querySelector('[data-testid="monitor-empty"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="monitor-runs-table"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="monitor-runs-pagination"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="monitor-score-row"]')?.textContent).toContain("Quality");
  });
});
