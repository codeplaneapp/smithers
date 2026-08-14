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
  test("transitions from connecting to offline-without-cache to authoritative empty", () => {
    useRunsListStore.setState({
      runs: [],
      loading: true,
      error: null,
      connectionStatus: "connecting",
    });
    const canvas = renderCanvas();

    expect(canvas.querySelector('[data-testid="runs-loading"] [data-slot="skeleton"]')).not.toBeNull();
    expect(canvas.querySelector(".runs-loading-message")).not.toBeNull();
    expect(canvas.textContent).toContain("Connecting to the gateway…");
    expect(canvas.querySelector('[data-testid="runs-stream-badge"]')?.textContent).toBe("Connecting");
    expect(canvas.querySelector('[data-testid="runs-stream-badge"]')?.getAttribute("data-slot")).toBe("badge");
    expect(canvas.textContent).not.toContain("No runs yet.");

    act(() => {
      useRunsListStore.setState({
        loading: false,
        error: "Gateway request failed.",
        connectionStatus: "offline",
      });
    });
    expect(canvas.querySelector('[data-testid="runs-landing-state"]')?.getAttribute("data-state")).toBe(
      "offline-without-cache",
    );
    expect(canvas.textContent).toContain("No last-known run data is available.");
    expect(canvas.querySelector('[data-testid="runs-stream-badge"]')?.textContent).toBe("Offline");
    expect(canvas.textContent).not.toContain("No runs yet.");

    act(() => {
      useRunsListStore.setState({
        loading: false,
        error: null,
        connectionStatus: "online",
      });
    });
    expect(canvas.querySelector('[data-testid="runs-landing-state"]')?.getAttribute("data-state")).toBe("empty");
    expect(canvas.textContent).toContain("No runs yet.");
  });

  test("uses a dedicated unauthorized state", () => {
    useRunsListStore.setState({
      runs: [],
      loading: false,
      error: "Unauthorized",
      connectionStatus: "unauthorized",
    });
    const canvas = renderCanvas();

    expect(canvas.querySelector('[data-testid="runs-landing-state"]')?.getAttribute("data-state")).toBe("unauthorized");
    expect(canvas.textContent).toContain("Authorization required");
    expect(canvas.textContent).toContain("credentials");
    expect(canvas.querySelector('[data-testid="runs-stream-badge"]')?.textContent).toBe("Unauthorized");
    expect(canvas.textContent).not.toContain("No runs yet.");
  });

  test("hides cached rows and workflow names after authorization fails", () => {
    const cachedRun: RunSummary = {
      id: "secret-run",
      runId: "secret-run",
      workflowName: "private-release",
      workflowKey: "private-release",
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
    useRunsListStore.setState({
      runs: [cachedRun],
      loading: false,
      error: "Unauthorized",
      connectionStatus: "unauthorized",
    });
    const canvas = renderCanvas();

    expect(canvas.querySelector('[data-testid="runs-landing-state"]')?.getAttribute("data-state")).toBe("unauthorized");
    expect(canvas.querySelector('[data-testid="runs-row"]')).toBeNull();
    expect(canvas.querySelector('[data-testid="runs-last-known"]')).toBeNull();
    expect(canvas.textContent).not.toContain("secret-run");
    expect(canvas.textContent).not.toContain("private-release");
    expect(canvas.querySelector('[data-testid="runs-stream-badge"]')?.textContent).toBe("Unauthorized");
  });

  test("labels cached rows as last-known across disconnect and recovery", () => {
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
    useRunsListStore.setState({
      runs: [run],
      loading: false,
      error: null,
      connectionStatus: "online",
    });
    const canvas = renderCanvas();

    expect(canvas.querySelector('[data-testid="runs-row"]')).not.toBeNull();
    expect(canvas.querySelector('[data-testid="runs-last-known"]')).toBeNull();
    expect(canvas.querySelector('[data-testid="runs-stream-badge"]')?.textContent).toBe("Live");
    expect(canvas.querySelector('[data-testid="runs-stream-badge"]')?.getAttribute("data-live")).toBe("true");

    act(() => {
      useRunsListStore.setState({
        error: "Refresh failed.",
        connectionStatus: "offline",
      });
    });
    expect(canvas.querySelector('[data-testid="runs-row"]')).not.toBeNull();
    expect(canvas.querySelector('[data-testid="runs-last-known"]')?.textContent).toContain(
      "Every run shown below is last-known data",
    );
    expect(canvas.querySelector('[data-testid="runs-last-known"]')?.getAttribute("data-slot")).toBe("alert");
    expect(canvas.querySelector('[data-testid="runs-stream-badge"]')?.textContent).toBe("Last-known");
    expect(canvas.querySelector('[data-testid="runs-stream-badge"]')?.hasAttribute("data-live")).toBe(false);

    act(() => {
      useRunsListStore.setState({
        error: null,
        connectionStatus: "online",
      });
    });
    expect(canvas.querySelector('[data-testid="runs-last-known"]')).toBeNull();
    expect(canvas.querySelector('[data-testid="runs-stream-badge"]')?.textContent).toBe("Live");
  });

  test("distinguishes filtered zero results from an empty workspace", () => {
    useRunsListStore.setState({
      runs: [],
      loading: false,
      error: null,
      connectionStatus: "online",
      search: "missing",
    });
    const canvas = renderCanvas();

    expect(canvas.querySelector('[data-testid="runs-landing-state"]')?.getAttribute("data-state")).toBe("filtered");
    expect(canvas.textContent).toContain("No runs match your filters.");
  });
});
