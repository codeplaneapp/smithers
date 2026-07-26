import { GlobalRegistrator } from "@happy-dom/global-registrator";

try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}

import { afterEach, describe, expect, test } from "bun:test";
import React, { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SmithersGatewayContext } from "../src/SmithersGatewayContext.ts";
import { useGatewayRunTokenUsage } from "../src/useGatewayRunTokenUsage.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Array<{ root: Root; container: HTMLDivElement }> = [];

afterEach(async () => {
  for (const { root, container } of roots.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
});

async function waitFor(check: () => boolean, timeoutMs = 2_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return;
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  }
  throw new Error("Timed out waiting for hook state");
}

describe("useGatewayRunTokenUsage", () => {
  test("loads the complete response and polls only when refreshMs is set", async () => {
    let calls = 0;
    const client = {
      rpc: async (method: string, params: unknown) => {
        expect(method).toBe("listRunTokenUsage");
        expect(params).toEqual({ runId: "run one" });
        calls += 1;
        return { runId: "run one", events: [] };
      },
    };
    let state: ReturnType<typeof useGatewayRunTokenUsage> | undefined;
    function Probe() {
      state = useGatewayRunTokenUsage("run one", { refreshMs: 20 });
      return null;
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push({ root, container });
    await act(async () => {
      root.render(createElement(SmithersGatewayContext.Provider, { value: client as never }, createElement(Probe)));
    });

    await waitFor(() => state?.loading === false && calls >= 1);
    expect(state?.data).toEqual({ runId: "run one", events: [] });
    await waitFor(() => calls >= 2);
    expect(state?.error).toBeUndefined();
  });

  test("fires one final refetch when polling stops (live → settled)", async () => {
    let calls = 0;
    const client = {
      rpc: async () => {
        calls += 1;
        return { runId: "run one", events: [] };
      },
    };
    let state: ReturnType<typeof useGatewayRunTokenUsage> | undefined;
    function Probe({ refreshMs }: { refreshMs?: number }) {
      state = useGatewayRunTokenUsage("run one", { refreshMs });
      return null;
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push({ root, container });
    await act(async () => {
      root.render(
        createElement(
          SmithersGatewayContext.Provider,
          { value: client as never },
          createElement(Probe, { refreshMs: 20 }),
        ),
      );
    });

    await waitFor(() => state?.loading === false && calls >= 1);
    const callsWhilePolling = calls;

    await act(async () => {
      root.render(
        createElement(
          SmithersGatewayContext.Provider,
          { value: client as never },
          createElement(Probe, { refreshMs: undefined }),
        ),
      );
    });

    await waitFor(() => calls > callsWhilePolling);
    const callsAfterSettle = calls;
    await act(async () => new Promise((resolve) => setTimeout(resolve, 60)));
    expect(calls).toBe(callsAfterSettle);
  });
});
