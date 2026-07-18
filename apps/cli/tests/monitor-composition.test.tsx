/** @jsxImportSource react */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const now = Date.now();
const run = {
  runId: "run-composition", workflowKey: "operator-workflow", status: "running",
  createdAtMs: now - 60_000, startedAtMs: now - 55_000,
  summary: { finished: 1, failed: 1, pending: 1 },
};
const tree = { root: { id: "task-1", key: "task-1", iteration: 0, status: "failed", title: "Task one", kind: "task" }, nodes: [{ id: "task-1", key: "task-1", iteration: 0, status: "failed", title: "Task one", kind: "task" }] };
const gateway = {
  createGatewayReactRoot: () => {},
  useGatewayRuns: () => ({ data: [run], loading: false, refetch: async () => {} }),
  useGatewayRun: () => ({ data: run, loading: false }),
  useGatewayApprovals: () => ({ data: [{ runId: run.runId, approvalId: "approval-1", status: "pending" }] }),
  useGatewayActions: () => ({ cancelRun: async () => ({}), resumeRun: async () => ({}), launchRun: async () => ({}) }),
  useGatewayWorkflows: () => ({ data: [{ key: run.workflowKey, hasUi: false }], refetch: async () => {} }),
  useGatewayConnectionStatus: () => ({ status: "connected" }),
  useGatewayRunTree: () => ({ ...tree, isLoading: false, loading: false }),
  useGatewayRunEvents: () => ({ events: [{ seq: 1, event: "NodeFinished", nodeId: "task-1" }], loading: false, streaming: false }),
  useGatewayNodeOutput: () => ({ data: {} }),
  useGatewayRpc: (method: string) => ({
    loading: false, refetch: async () => {},
    data: method === "runRecap" ? { summary: "The agent completed useful work.", source: "facts", toSeq: 1, history: [] } : undefined,
  }),
};
mock.module("smithers-orchestrator/gateway-react", () => gateway);

GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { App } = await import("../src/monitor-ui/monitorApp.tsx");
let container: HTMLElement;
let root: import("react-dom/client").Root;

function json(data: unknown) { return new Response(JSON.stringify({ ok: true, data }), { status: 200 }); }
function orderOf(...selectors: string[]) { return selectors.map((selector) => { const node = container.querySelector(selector); expect(node).not.toBeNull(); return [...container.querySelectorAll("*")].indexOf(node!); }); }

beforeEach(() => {
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.includes("/usage")) return json([{ accountLabel: "Codex", windows: [{ label: "weekly", usedPercent: 32, resetsAt: new Date(now + 3_600_000).toISOString() }] }]);
    if (path.includes("token-usage")) return json({ totals: { inputTokens: 100, tokens: 100, costUsd: 0.12 }, groups: [{ model: "claude", engine: "codex", tokens: 100, costUsd: 0.12, priced: true }], buckets: [] });
    if (path.includes("/crons")) return json([]);
    if (path.includes("/scores")) return json([{ scorerName: "quality", scorerId: "quality", nodeId: "task-1", score: 0.9 }]);
    if (path.includes("/decisions")) return json([]);
    if (path.includes("/footprint")) return json({ files: [] });
    return json([]);
  }) as typeof fetch;
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
afterAll(async () => { await GlobalRegistrator.unregister(); });

describe("Monitor single-surface composition", () => {
  test("lands on attention, quiet operations, runs, and crons then keeps every debugger panel on the selected run", async () => {
    await act(async () => root.render(<App />));
    await act(async () => {});
    expect(orderOf("[data-testid=monitor-attention]", "[data-testid=monitor-ops-strip]", "[data-testid=monitor-runs-table]", "[data-testid=monitor-crons]")).toEqual([...orderOf("[data-testid=monitor-attention]", "[data-testid=monitor-ops-strip]", "[data-testid=monitor-runs-table]", "[data-testid=monitor-crons]")].sort((a, b) => a - b));
    expect(container.querySelector("[data-testid=monitor-account-usage]")?.textContent).toContain("Codex · weekly");
    expect(container.querySelector("[data-testid=monitor-account-usage]")?.textContent).toContain("32%");
    expect(container.querySelector("[data-testid=monitor-workspace-cost]")?.textContent).toContain("workspace cost today");
    expect(container.querySelector("[data-testid=monitor-stat-attention]")?.textContent).toContain("needs attention");
    expect(container.querySelector("[data-testid=monitor-stat-engines]")).not.toBeNull();
    for (const id of ["memory", "tickets", "latency", "cron", "accounts"]) expect(container.querySelector(`[data-testid=monitor-stat-${id}]`)).toBeNull();
    expect(container.querySelector("[data-testid=monitor-runs-table]")?.textContent).toContain("ETA");
    expect(container.querySelector("[data-testid=monitor-runs-table]")?.textContent).toContain("Failed");

    await act(async () => (container.querySelector("[data-run-id] button, [data-run-id]") as HTMLElement).click());
    await act(async () => {});
    expect(container.querySelector("[data-testid=monitor-health-strip]")).not.toBeNull();
    expect(container.querySelector(".mon-detail-header-band")).not.toBeNull();
    expect(container.querySelector(".mon-detail-header-band")?.textContent).toContain("run cost");
    expect(container.querySelector(".mon-detail-header-band")?.textContent).toContain("estimating");
    const detailOrder = orderOf("[data-testid=monitor-health-strip]", ".mon-detail-header-band", "[data-testid=monitor-recap]", "[data-testid=monitor-decisions]", "[data-testid=monitor-scores]", "[data-testid=footprint-panel]", ".mon-tree-panel", ".mon-events-panel");
    expect(detailOrder).toEqual([...detailOrder].sort((a, b) => a - b));
    expect(container.textContent).toContain("Frames"); expect(container.textContent).toContain("XML"); expect(container.textContent).toContain("Timeline");
    await act(async () => (container.querySelector("[data-testid=monitor-tree] .mon-tree-main") as HTMLElement).click());
    expect(container.querySelector("[data-testid=monitor-inspector]")).not.toBeNull();
  });
});
