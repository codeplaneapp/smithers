/** @jsxImportSource react */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, mock, test } from "bun:test";

// The facts band folds the run-tree agent count in; keep the hook inert so
// this file exercises the REST readers, not the gateway store.
mock.module("smithers-orchestrator/gateway-react", () => ({
  useGatewayRunTree: () => ({ nodes: [], isLoading: false }),
}));

const nativeFetch = globalThis.fetch;
const previousReactActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { RunFactsBand, AccountUsageCards } = await import("../src/monitor-ui/monitorUsagePanels.tsx");
let root: import("react-dom/client").Root | undefined;
let container: HTMLElement | undefined;
afterEach(async () => { if (root) await act(async () => root?.unmount()); root = undefined; container?.remove(); container = undefined; });
afterAll(async () => {
  globalThis.fetch = nativeFetch;
  if (previousReactActEnvironment === undefined) delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  else (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousReactActEnvironment;
  await GlobalRegistrator.unregister();
});
async function render(element: import("react").ReactElement) { container = document.createElement("div"); document.body.append(container); root = createRoot(container); await act(async () => root?.render(element)); }

test("run facts band consumes the real {ok,data} gateway envelope and renders aligned cells", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes("node-states")) return new Response(JSON.stringify({ ok: true, data: [] }), { status: 200 });
    return new Response(JSON.stringify({ ok: true, data: { totals: { tokens: 1000, costUsd: 1.25 }, groups: [{ engine: "codex", model: "gpt-5.6-luna", tokens: 1000, costUsd: 1.25, priced: true }], buckets: [{ startMs: Date.now() - 20_000, tokens: 100 }] } }), { status: 200 });
  }) as typeof fetch;
  await render(<RunFactsBand runId="r1" runStatus="running" active progressRatio={.5} />);
  // Cost / Tokens are numeric values over small labels — no inline prose chain.
  const cell = (testId: string) => container?.querySelector(`[data-testid="${testId}"]`);
  expect(cell("monitor-run-cost")?.textContent).toContain("$1.25");
  expect(cell("monitor-run-cost")?.textContent).toContain("run cost");
  expect(cell("monitor-run-cost")?.textContent).toContain("~2.0K projected");
  expect(cell("monitor-fact-tokens")?.textContent).toContain("1.0K");
  expect(cell("monitor-fact-tokens")?.textContent).toContain("100/min");
  expect(cell("monitor-fact-eta")?.textContent).toContain("estimating");
  // Per-model rows fold into the "by model" disclosure beneath the band.
  const models = container?.querySelector(".mon-facts-models");
  expect(models?.textContent).toContain("by model");
  expect(container?.querySelector('[data-testid="monitor-run-cost-model"]')?.textContent).toContain("codex · gpt-5.6-luna");
});

test("account cards consume envelope and retain visible cached window labels", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, data: [{ accountLabel: "work", stale: true, windows: [{ label: "five hour", usedPercent: 85, resetsAt: new Date(Date.now() + 3_600_000).toISOString() }] }] }), { status: 200 });
  await render(<AccountUsageCards />);
  expect(container?.textContent).toContain("work · five hour");
  expect(container?.textContent).toContain("85%");
  // Coarse two-unit countdown copy — "resets in 59m"/"resets in 1h", never a
  // raw minute pile like "8887m".
  expect(container?.textContent).toMatch(/resets in (59m|1h)/);
  expect(container?.textContent).toContain("cached");
});

test("account cards explain reports with no windows", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, data: [{ accountLabel: "work", windows: [] }] }), { status: 200 });
  await render(<AccountUsageCards />);
  expect(container?.textContent).toContain("no subscription windows reported");
});

test("account cards do not render a missing percentage as zero usage", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, data: [{ accountLabel: "work", windows: [{ label: "weekly", usedPercent: null }] }] }), { status: 200 });
  await render(<AccountUsageCards />);
  expect(container?.textContent).toContain("—");
  expect(container?.textContent).not.toContain("0%");
});
