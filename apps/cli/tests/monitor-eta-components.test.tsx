/** @jsxImportSource react */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

const nativeFetch = globalThis.fetch;
const previousAct = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
GlobalRegistrator.register();
globalThis.fetch = nativeFetch;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { RunEtaCell, RunEtaLineView } = await import("../src/monitor-ui/monitorEta.tsx");
type Root = import("react-dom/client").Root;
let root: Root | undefined;
let container: HTMLElement | undefined;

afterEach(async () => { if (root) await act(async () => root?.unmount()); root = undefined; container?.remove(); container = undefined; });
afterAll(async () => { await GlobalRegistrator.unregister(); globalThis.fetch = nativeFetch; if (previousAct === undefined) delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT; else (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousAct; });
async function render(element: import("react").ReactElement) {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(element));
}
async function settle() { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }
const estimate = { kind: "estimate" as const, remainingMs: 120_000, etaAtMs: 1, avgTaskDurationMs: 1, sampleSize: 1, remainingTasks: 1, inFlightTasks: 0 };
const extent = { totalKnown: 30, settled: 12, running: 3, pending: 15, agentTasks: 5, elapsedMs: 1_320_000, atLeast: false };

describe("monitor ETA surfaces", () => {
  test("renders landing ETA cells from node-state pace and marks iterations as lower bounds", async () => {
    const current = Date.now();
    globalThis.fetch = (async () => new Response(JSON.stringify([
      { nodeId: "done", iteration: 0, state: "finished", startedAtMs: current - 60_000, finishedAtMs: current },
      { nodeId: "next", iteration: 0, state: "queued" },
    ]))) as typeof fetch;
    await render(<RunEtaCell run={{ runId: "r", status: "running", startedAtMs: current, summary: { finished: 99 } }} />);
    await settle();
    expect(container?.textContent).toBe("~1m 00s left");
    globalThis.fetch = (async () => new Response(JSON.stringify([
      { nodeId: "done", iteration: 1, state: "finished", startedAtMs: current - 60_000, finishedAtMs: current },
      { nodeId: "next", iteration: 0, state: "queued" },
    ]))) as typeof fetch;
    await render(<RunEtaCell run={{ runId: "iterating", status: "running" }} />);
    await settle();
    expect(container?.textContent).toBe("at least ~1m 00s left");
    globalThis.fetch = (async () => new Response(JSON.stringify([]))) as typeof fetch;
    await render(<RunEtaCell run={{ runId: "summary-less", status: "running" }} />);
    await settle();
    expect(container?.textContent).toBe("—");
    let terminalFetches = 0;
    globalThis.fetch = (async () => { terminalFetches++; return new Response("[]"); }) as typeof fetch;
    await render(<RunEtaCell run={{ runId: "r", status: "finished", startedAtMs: 1, summary: { finished: 1, pending: 1 } }} />);
    expect(container?.textContent).toBe("—");
    expect(terminalFetches).toBe(0);
  });
  test("renders estimate wording and extent variants", async () => {
    await render(<RunEtaLineView estimate={estimate} extent={extent} />);
    expect(container?.textContent).toBe("~2m 00s left · 12/30 tasks · 5 agent tasks · 22m 00s elapsed");
    await render(<RunEtaLineView estimate={{ ...estimate, kind: "at-least" }} extent={{ ...extent, atLeast: true, agentTasks: undefined }} />);
    expect(container?.textContent).toBe("at least ~2m 00s left · 12 settled · at least 30 known tasks · 22m 00s elapsed");
    await render(<RunEtaLineView estimate={{ kind: "unknown", sampleSize: 0, remainingTasks: 1, inFlightTasks: 0 }} extent={extent} />);
    expect(container?.textContent).toContain("estimating…");
    await render(<RunEtaLineView estimate={estimate} extent={extent} showEstimate={false} />);
    expect(container?.textContent).not.toContain("left");
    expect(container?.textContent).toContain("12/30 tasks");
  });
});
