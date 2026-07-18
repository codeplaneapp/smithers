/** @jsxImportSource react */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const state: { events: any[]; rpc: any } = { events: [], rpc: {} };
mock.module("smithers-orchestrator/gateway-react", () => ({
  useGatewayRunEvents: () => ({ events: state.events }),
  useGatewayRpc: () => state.rpc,
}));

GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { RecapPanel } = await import("../src/monitor-ui/monitorRecapPanel.tsx");
let container: HTMLElement;
let root: import("react-dom/client").Root;

beforeEach(() => {
  state.events = [];
  state.rpc = { data: undefined, error: undefined, loading: false, refetch: async () => {} };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
afterAll(async () => { await GlobalRegistrator.unregister(); });

async function render() { await act(async () => root.render(<RecapPanel runId="run_1" status="finished" />)); }

describe("RecapPanel", () => {
  test("renders loading, narrated and facts recaps, plus scrollback", async () => {
    state.rpc = { data: undefined, loading: true, refetch: async () => {} };
    await render();
    expect(container.textContent).toContain("Preparing recap");
    state.rpc = { loading: false, refetch: async () => {}, data: { summary: "Agent answer", source: "agent", agentId: "terra", toSeq: 4, generatedAtMs: Date.now(), history: [{ summary: "Agent answer", toSeq: 4 }, { summary: "Earlier answer", toSeq: 2 }] } };
    await render();
    expect(container.textContent).toContain("Narrated by terra");
    expect(container.textContent).toContain("Earlier answer");
    state.rpc.data.source = "facts";
    await render();
    expect(container.textContent).toContain("Facts recap");
  });

  test("hides itself when the recap RPC fails before any recap arrived", async () => {
    state.rpc = { data: undefined, error: new Error("nope"), loading: false, refetch: async () => {} };
    await render();
    expect(container.querySelector('[data-testid="monitor-recap"]')).toBeNull();
  });

  test("keeps the stale recap and backs off refetches after an RPC failure", async () => {
    const nativeNow = Date.now;
    let now = 0;
    Date.now = () => now;
    let refetches = 0;
    state.rpc = { loading: false, refetch: async () => { refetches += 1; }, error: new Error("boom"), data: { summary: "Stale recap", source: "facts", toSeq: 1, generatedAtMs: 0, history: [] } };
    const renderLive = async () => act(async () => root.render(<RecapPanel runId="run_1" status="running" />));
    try {
      state.events = [{ seq: 5, event: "NodeFinished" }];
      await renderLive();
      // A notable event above the stale toSeq must not bypass the failure backoff.
      expect(refetches).toBe(0);
      expect(container.textContent).toContain("Stale recap");
      state.events = [...state.events, { seq: 6, event: "NodeFinished" }];
      await renderLive();
      expect(refetches).toBe(0);
      now = 15_000;
      state.events = [...state.events, { seq: 7, event: "NodeFinished" }];
      await renderLive();
      expect(refetches).toBe(1);
      state.events = [...state.events, { seq: 8, event: "NodeFinished" }];
      await renderLive();
      expect(refetches).toBe(1);
    } finally {
      Date.now = nativeNow;
    }
  });

  test("polls a live run after the recap interval even without incoming events", async () => {
    let refetches = 0;
    const nativeSetInterval = globalThis.setInterval;
    const nativeClearInterval = globalThis.clearInterval;
    const nativeNow = Date.now;
    let tick: (() => void) | undefined;
    let now = 0;
    globalThis.setInterval = ((callback: () => void) => { tick = callback; return 1 as unknown as ReturnType<typeof setInterval>; }) as typeof setInterval;
    globalThis.clearInterval = (() => {}) as typeof clearInterval;
    Date.now = () => now;
    state.rpc = { loading: false, refetch: async () => { refetches += 1; }, data: { summary: "Waiting", source: "facts", toSeq: 1, generatedAtMs: 0, history: [] } };
    try {
      await act(async () => root.render(<RecapPanel runId="run_1" status="running" />));
      now = 180_000;
      await act(async () => tick?.());
      expect(refetches).toBe(1);
    } finally {
      globalThis.setInterval = nativeSetInterval;
      globalThis.clearInterval = nativeClearInterval;
      Date.now = nativeNow;
    }
  });
});
