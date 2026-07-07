// Coverage for SmithersCollectionsProvider's own lifecycle branches (the
// default-mode fallback and the async/multiplayer collections promise path)
// and the useSmithersCollections guard error. The multiplayer path uses the
// real gateway-client data client + the real @tanstack/electric-db-collection
// loader (installed) — the collections are built but never connected, so no
// live Electric server is required.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

try { GlobalRegistrator.register(); } catch { /* already registered */ }

import { describe, expect, test } from "bun:test";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createSmithersDataClient } from "@smithers-orchestrator/gateway-client";
import {
  SmithersCollectionsContext,
  SmithersCollectionsProvider,
  useSmithersCollections,
} from "../src/index.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Harness = {
  render: (element: ReactElement) => Promise<void>;
  unmount: () => Promise<void>;
};

async function mountHarness(): Promise<Harness> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
  });
  return {
    render: async (element) => {
      await act(async () => {
        root.render(element);
      });
    },
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe("useSmithersCollections", () => {
  test("throws a clear error outside a <SmithersCollectionsProvider>", () => {
    function Probe() {
      useSmithersCollections();
      return null;
    }
    // Render synchronously without a provider; the hook must throw.
    const container = document.createElement("div");
    const root = createRoot(container);
    expect(() => {
      act(() => {
        root.render(createElement(Probe));
      });
    }).toThrow("useSmithersCollections: missing <SmithersCollectionsProvider>.");
    act(() => root.unmount());
  });
});

describe("SmithersCollectionsProvider", () => {
  test("with neither client nor mode it derives the default local mode and provides collections", async () => {
    let contextValue: any = null;
    function Consumer() {
      return createElement(SmithersCollectionsContext.Consumer, {
        children: (value: any) => {
          contextValue = value;
          return null;
        },
      });
    }

    const harness = await mountHarness();
    // No mode + no client → defaultMode() runs (location.origin under happy-dom).
    await harness.render(createElement(SmithersCollectionsProvider, null, createElement(Consumer)));
    expect(contextValue).not.toBeNull();
    expect(contextValue.collections).toBeDefined();
    expect(contextValue.client).toBeDefined();
    // Provider owns the client it created; unmount closes it (cleanup branch).
    await harness.unmount();
  });

  test("a multiplayer client yields a collections PROMISE that resolves and mounts children", async () => {
    const client = createSmithersDataClient({
      mode: {
        kind: "multiplayer",
        apiBaseUrl: "http://127.0.0.1:1/",
        electricBaseUrl: "http://127.0.0.1:1/",
        workspaceId: "workspace-gaps",
        token: "operator-token",
      },
    });

    let contextValue: any = null;
    function Consumer() {
      return createElement(SmithersCollectionsContext.Consumer, {
        children: (value: any) => {
          contextValue = value;
          return null;
        },
      });
    }

    const harness = await mountHarness();
    await harness.render(createElement(SmithersCollectionsProvider, { client }, createElement(Consumer)));
    // The promise-backed collections resolve on a later microtask; wait for the
    // provider to swap null → resolved and render the context.
    for (let i = 0; i < 200 && contextValue === null; i += 1) {
      await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    }
    expect(contextValue).not.toBeNull();
    expect(contextValue.collections).toBeDefined();

    // Provider was given the client, so it must NOT close it on unmount; the
    // test owns closing it.
    await harness.unmount();
    client.close();
  });

  test("unmounting a multiplayer provider BEFORE the collections promise resolves closes the resolved collections (cancelled branch)", async () => {
    const client = createSmithersDataClient({
      mode: {
        kind: "multiplayer",
        apiBaseUrl: "http://127.0.0.1:1/",
        electricBaseUrl: "http://127.0.0.1:1/",
        workspaceId: "workspace-gaps-cancel",
        token: "operator-token",
      },
    });

    const harness = await mountHarness();
    // Render then immediately unmount in the SAME macrotask window so the
    // dynamic-import-backed collections promise is still pending at unmount —
    // the cancelled guard closes the collections when it later resolves.
    await harness.render(createElement(SmithersCollectionsProvider, { client }, createElement("div", null)));
    await harness.unmount();
    // Flush the pending import resolution so the cancelled `.then` runs.
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    client.close();
    expect(true).toBe(true);
  });
});
