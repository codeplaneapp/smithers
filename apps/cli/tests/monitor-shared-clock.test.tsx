/** @jsxImportSource react */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";

GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useNowMs } = await import("../src/monitor-ui/monitorShared.tsx");
let container: HTMLElement;
let root: import("react-dom/client").Root;

function NowProbe() {
  return <span data-testid="now">{useNowMs()}</span>;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
afterAll(async () => { await GlobalRegistrator.unregister(); });

describe("shared monitor clock", () => {
  // The module-level clock snapshot freezes when its last subscriber leaves
  // (long test processes and idle monitor views both hit this). A component
  // mounting after that gap must see the current instant, not the frozen one,
  // or time-window math like the burn-rate bucket filter silently drops data.
  test("first subscriber after an idle gap reads a fresh now, not the frozen snapshot", async () => {
    const realNow = Date.now;
    const staleGapMs = 90_000;
    Date.now = () => realNow() + staleGapMs;
    try {
      await act(async () => root.render(<NowProbe />));
      const rendered = Number(container.querySelector("[data-testid=now]")?.textContent);
      expect(rendered).toBeGreaterThanOrEqual(realNow() + staleGapMs - 1_000);
    } finally {
      Date.now = realNow;
    }
  });
});
