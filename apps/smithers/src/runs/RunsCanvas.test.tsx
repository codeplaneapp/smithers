/** @jsxImportSource react */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const nativeFetch = globalThis.fetch;
try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}
globalThis.fetch = nativeFetch;

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RunsCanvas } from "./RunsCanvas";
import type { RunSummary } from "./runsList";
import { useRunsListStore } from "./runsListStore";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function renderCanvas(): HTMLElement {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(<RunsCanvas />));
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  useRunsListStore.setState(useRunsListStore.getInitialState(), true);
});

describe("RunsCanvas collection states", () => {
  test("uses Skeleton only for the initial load", () => {
    useRunsListStore.setState({ runs: [], loading: true, error: null });
    const canvas = renderCanvas();

    expect(canvas.querySelector('[data-testid="runs-loading"] [data-slot="skeleton"]')).not.toBeNull();
    expect(canvas.textContent).toContain("Loading runs…");
  });

  test("uses EmptyState for authoritative empty and failure results", () => {
    useRunsListStore.setState({ runs: [], loading: false, error: null });
    let canvas = renderCanvas();

    expect(canvas.querySelector('[data-slot="empty-state"]')?.textContent).toContain("No runs found.");

    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;

    useRunsListStore.setState({ runs: [], loading: false, error: "Gateway request failed." });
    canvas = renderCanvas();

    expect(canvas.querySelector('[data-slot="empty-state"][role="alert"]')?.textContent).toContain(
      "Gateway request failed.",
    );
  });

  test("keeps last-known rows visible when a refresh fails", () => {
    const run: RunSummary = {
      id: "run-1",
      runId: "run-1",
      workflowName: "release",
      workflowKey: "release",
      model: "",
      status: "running",
      lifecycleStatus: "running",
      totalNodes: 0,
      doneNodes: 0,
      failedNodes: 0,
      progress: 0,
      elapsedLabel: "1m",
      ageBucket: "today",
    };
    useRunsListStore.setState({ runs: [run], loading: false, error: "Refresh failed." });
    const canvas = renderCanvas();

    expect(canvas.querySelector('[data-testid="runs-row"]')).not.toBeNull();
    expect(canvas.querySelector('[role="alert"]')).toBeNull();
  });
});
