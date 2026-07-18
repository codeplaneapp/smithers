/** @jsxImportSource react */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";

GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { WorkspaceCostCard } = await import("../src/monitor-ui/monitorOps.tsx");
let container: HTMLElement;
let root: import("react-dom/client").Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
afterAll(async () => { await GlobalRegistrator.unregister(); });

const today = new Date(2026, 6, 18, 12).getTime();
const usage = (cost: number) => ({ ok: true, data: { usage: { inputTokens: 1 }, costs: [{ model: "claude", costUsd: cost }], totalUsd: cost } });

describe("WorkspaceCostCard", () => {
  test("refreshes existing today runs every minute instead of only when their ids change", async () => {
    const oldFetch = globalThis.fetch;
    const oldSetInterval = globalThis.setInterval;
    const oldClearInterval = globalThis.clearInterval;
    let timer: (() => void) | undefined;
    let calls = 0;
    globalThis.fetch = (async () => new Response(JSON.stringify(usage(++calls)), { status: 200 })) as typeof fetch;
    globalThis.setInterval = ((fn: () => void) => { timer = fn; return 1 as unknown as ReturnType<typeof setInterval>; }) as typeof setInterval;
    globalThis.clearInterval = (() => {}) as typeof clearInterval;
    try {
      await act(async () => root.render(<WorkspaceCostCard now={today} runs={[{ runId: "run_1", startedAtMs: today }]} />));
      await act(async () => {});
      expect(calls).toBe(1);
      await act(async () => timer?.());
      await act(async () => {});
      expect(calls).toBe(2);
    } finally {
      globalThis.fetch = oldFetch;
      globalThis.setInterval = oldSetInterval;
      globalThis.clearInterval = oldClearInterval;
    }
  });
});
