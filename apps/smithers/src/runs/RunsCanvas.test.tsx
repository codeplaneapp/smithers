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
import { bindRunActions, useRunsListStore } from "./runsListStore";

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

function run(runId: string, lifecycleStatus: string): RunSummary {
  const status =
    lifecycleStatus === "failed"
      ? "failed"
      : lifecycleStatus === "cancelled"
        ? "cancelled"
        : lifecycleStatus === "finished"
          ? "finished"
          : lifecycleStatus === "running"
            ? "running"
            : "waiting";
  return {
    id: runId,
    runId,
    workflowName: "release",
    workflowKey: "release",
    model: "",
    status,
    lifecycleStatus,
    totalNodes: 0,
    doneNodes: 0,
    failedNodes: 0,
    progress: 0,
    elapsedLabel: "1m",
    ageBucket: "today",
  };
}

function click(target: Element | null) {
  if (!target) throw new Error("Missing click target");
  act(() => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
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
  test("gates pause, resume, cancel, and retry controls by live lifecycle state", () => {
    bindRunActions({
      pause: async () => undefined,
      resume: async () => undefined,
      cancel: async () => undefined,
      retry: async () => ({ runId: "retry-run" }),
      health: async () => "healthy",
      refetch: () => undefined,
    });
    useRunsListStore.setState({
      runs: [
        run("run-running", "running"),
        run("run-paused", "paused"),
        run("run-failed", "failed"),
        run("run-finished", "finished"),
        run("run-cancelled", "cancelled"),
      ],
      loading: false,
      error: null,
      connectionStatus: "online",
    });
    const canvas = renderCanvas();
    const row = (id: string) => canvas.querySelector<HTMLElement>(`[data-run-id='${id}']`)!;

    expect(row("run-running").querySelector("[data-testid='runs-pause']")).not.toBeNull();
    expect(row("run-running").querySelector("[data-testid='runs-cancel']")).not.toBeNull();
    expect(row("run-running").querySelector("[data-testid='runs-resume']")).toBeNull();
    expect(row("run-paused").querySelector("[data-testid='runs-resume']")).not.toBeNull();
    expect(row("run-paused").querySelector("[data-testid='runs-cancel']")).not.toBeNull();
    expect(row("run-failed").querySelector("[data-testid='runs-retry']")).not.toBeNull();
    expect(row("run-failed").querySelector("[data-testid='runs-cancel']")).toBeNull();
    expect(row("run-finished").querySelector("[data-testid='runs-pause']")).toBeNull();
    expect(row("run-finished").querySelector("[data-testid='runs-resume']")).toBeNull();
    expect(row("run-finished").querySelector("[data-testid='runs-cancel']")).toBeNull();
    expect(row("run-cancelled").querySelector("[data-testid='runs-resume']")).toBeNull();
    expect(canvas.querySelectorAll("[data-testid='runs-health']")).toHaveLength(5);
  });

  test("uses real lifecycle seams, confirms destructive actions, and blocks duplicates", async () => {
    const calls: string[] = [];
    let releasePause!: () => void;
    bindRunActions({
      pause: (runId) =>
        new Promise<void>((resolve) => {
          calls.push(`pause:${runId}`);
          releasePause = resolve;
        }),
      resume: async (runId) => {
        calls.push(`resume:${runId}`);
      },
      cancel: async (runId) => {
        calls.push(`cancel:${runId}`);
      },
      retry: async (runId) => {
        calls.push(`retry:${runId}`);
        return { runId: "run-retry" };
      },
      health: async (runId) => {
        calls.push(`health:${runId}`);
        return "healthy";
      },
      refetch: () => undefined,
    });
    useRunsListStore.setState({
      runs: [run("run-running", "running"), run("run-paused", "paused"), run("run-failed", "failed")],
      loading: false,
      error: null,
      connectionStatus: "online",
    });
    const canvas = renderCanvas();
    const row = (id: string) => canvas.querySelector<HTMLElement>(`[data-run-id='${id}']`)!;

    const pause = row("run-running").querySelector<HTMLButtonElement>("[data-testid='runs-pause']")!;
    click(pause);
    click(pause);
    await flush();
    expect(calls).toEqual(["pause:run-running"]);
    expect(pause.disabled).toBe(true);
    expect(row("run-paused").querySelector<HTMLButtonElement>("[data-testid='runs-resume']")!.disabled).toBe(true);
    releasePause();
    await flush();
    expect(row("run-running").querySelector("[role='status']")?.textContent).toContain(
      "Pause requested for run-running",
    );

    click(row("run-paused").querySelector("[data-testid='runs-resume']"));
    await flush();
    expect(calls).toContain("resume:run-paused");

    const retry = row("run-failed").querySelector<HTMLButtonElement>("[data-testid='runs-retry']")!;
    click(retry);
    await flush();
    expect(row("run-failed").querySelector("[role='alertdialog']")).not.toBeNull();
    expect(document.activeElement).toBe(row("run-failed").querySelector("[data-testid='runs-confirm-retry']"));
    click(row("run-failed").querySelector("[data-testid='runs-confirm-retry']"));
    await flush();
    expect(calls).toContain("retry:run-failed");

    const cancel = row("run-running").querySelector<HTMLButtonElement>("[data-testid='runs-cancel']")!;
    click(cancel);
    await flush();
    expect(calls).not.toContain("cancel:run-running");
    const dialog = row("run-running").querySelector<HTMLElement>("[role='alertdialog']")!;
    await act(async () => {
      dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(row("run-running").querySelector("[role='alertdialog']")).toBeNull();
    expect(document.activeElement).toBe(cancel);

    click(cancel);
    await flush();
    click(row("run-running").querySelector("[data-testid='runs-confirm-cancel']"));
    await flush();
    expect(calls).toContain("cancel:run-running");
  });

  test("announces lifecycle and health failures and allows recovery", async () => {
    let pauseAttempts = 0;
    let healthAttempts = 0;
    bindRunActions({
      pause: async () => {
        pauseAttempts += 1;
        if (pauseAttempts === 1) throw new Error("engine unavailable");
      },
      resume: async () => undefined,
      cancel: async () => undefined,
      retry: async () => ({ runId: "retry-run" }),
      health: async () => {
        healthAttempts += 1;
        if (healthAttempts === 1) throw new Error("probe timed out");
        return "running";
      },
      refetch: () => undefined,
    });
    useRunsListStore.setState({
      runs: [run("run-running", "running")],
      loading: false,
      error: null,
      connectionStatus: "online",
    });
    const canvas = renderCanvas();
    const pause = () => canvas.querySelector("[data-testid='runs-pause']");
    const health = () => canvas.querySelector("[data-testid='runs-health']");

    click(pause());
    await flush();
    expect(canvas.querySelector("[role='alert']")?.textContent).toContain(
      "Pause failed for run-running: engine unavailable. Try again.",
    );
    expect((pause() as HTMLButtonElement).disabled).toBe(false);
    click(pause());
    await flush();
    expect(pauseAttempts).toBe(2);

    click(health());
    await flush();
    expect(canvas.querySelector("[role='alert']")?.textContent).toContain(
      "Health check failed for run-running: probe timed out. Try again.",
    );
    click(health());
    await flush();
    expect(healthAttempts).toBe(2);
    expect(canvas.querySelector("[role='status']")?.textContent).toContain("Health check for run-running: running.");
  });
});
