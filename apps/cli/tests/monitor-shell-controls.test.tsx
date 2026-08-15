/** @jsxImportSource react */
/**
 * Monitor shell controls on the shared smthrs/ui primitives
 * (issue #1033): focus, disabled, active, and keyboard states of the topbar
 * filters, rail rows, pagination, chips, and run lifecycle actions.
 *
 * Real react-dom under happy-dom (the packages/ui radix-interaction
 * convention) driving the monitor's own shell components — no mocking of the
 * unit under test. The DOM must exist before radix-ui loads (it decides
 * whether layout effects run at module-load time), so registration happens
 * first and everything DOM-dependent is imported dynamically after it. The
 * package test script runs this file in its own Bun process so earlier React
 * imports cannot poison that ordering and happy-dom cannot leak into CLI tests.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// happy-dom replaces fetch with a node:http one; keep bun's native fetch so
// unrelated network-using tests in the same process stay on the real stack.
const nativeFetch = globalThis.fetch;
const previousReactActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
GlobalRegistrator.register({ url: "http://localhost/monitor" });
globalThis.fetch = nativeFetch;

const { act, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
type ReactElement = import("react").ReactElement;
type Root = import("react-dom/client").Root;
const { SMITHERS_UI_STYLE_ATTR, smithersUiCss } = await import("smthrs/ui");
const { workflowUiThemeCss } = await import("smthrs/gateway-ui");
const { Chip, MonitorToolbar, RunLifecycleActions, RunLifecycleControls, RunRailRow, RunsPagination } =
  await import("../src/monitor-ui/monitorShell.tsx");
const {
  CronStatusTag,
  createMonitorKeydownHandler,
  EventLog,
  ExecutionTree,
  monitorCss,
  NodeOutputState,
  NodeTranscriptState,
  RunProgressCell,
  RunSelectionState,
  RunsRail,
  RunsTable,
  StatCard,
  StatusTag,
} = await import("../src/monitor-ui/monitor.tsx");
const monitorSource = readFileSync(new URL("../src/monitor-ui/monitor.tsx", import.meta.url), "utf8");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | undefined;
let root: Root | undefined;

afterAll(async () => {
  try {
    await GlobalRegistrator.unregister();
  } finally {
    globalThis.fetch = nativeFetch;
    if (previousReactActEnvironment === undefined) {
      delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    } else {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousReactActEnvironment;
    }
  }
});

afterEach(async () => {
  if (root) {
    const r = root;
    await act(async () => r.unmount());
    root = undefined;
  }
  container?.remove();
  container = undefined;
});

async function render(element: ReactElement): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const r = root;
  await act(async () => r.render(element));
}

async function rerender(element: ReactElement): Promise<void> {
  if (!root) throw new Error("render() must be called before rerender()");
  const r = root;
  await act(async () => r.render(element));
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    (el as HTMLElement).click();
  });
}

async function keydown(el: Element, key: string): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

function byTestId(testId: string): HTMLElement {
  const el = document.querySelector(`[data-testid="${testId}"]`);
  if (!el) throw new Error(`missing [data-testid="${testId}"]`);
  return el as HTMLElement;
}

function toolbarHarness(overrides: Partial<Parameters<typeof MonitorToolbar>[0]> = {}) {
  const calls = {
    filterText: [] as string[],
    status: [] as string[],
    workflow: [] as string[],
    metrics: 0,
    refresh: 0,
  };
  const element = (
    <MonitorToolbar
      filterText=""
      onFilterText={(text) => calls.filterText.push(text)}
      statusFilter="all"
      onStatusFilter={(status) => calls.status.push(status)}
      statuses={["running", "failed"]}
      workflowFilter="all"
      onWorkflowFilter={(workflow) => calls.workflow.push(workflow)}
      workflows={["hello", "docs-driven-development"]}
      visibleCount={2}
      totalCount={5}
      showMetrics={false}
      onToggleMetrics={() => calls.metrics++}
      onRefresh={() => calls.refresh++}
      {...overrides}
    />
  );
  return { element, calls };
}

function executionTree(overrides: Record<string, unknown> = {}): ReactElement {
  return (
    <ExecutionTree
      runId="run-tree-states"
      treeQuery={{
        root: null,
        nodes: [],
        status: "queued",
        isLoading: false,
        error: undefined,
        ...overrides,
      }}
      selectedNodeKey={undefined}
      onSelectNode={() => {}}
    />
  );
}

type EventLogState = Parameters<typeof EventLog>[0]["eventsState"];

function eventLogState(overrides: Partial<EventLogState> = {}): EventLogState {
  return {
    events: [],
    lastHeartbeat: undefined,
    error: undefined,
    streaming: true,
    loading: false,
    refetch: async () => {},
    connectionStatus: "online",
    ...overrides,
  };
}

function buttonNamed(name: string): HTMLButtonElement {
  const button = [...document.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === name);
  if (!button) throw new Error(`missing button named ${name}`);
  return button;
}

function nodeOutputState(overrides: Partial<Parameters<typeof NodeOutputState>[0]> = {}): ReactElement {
  return <NodeOutputState row={null} loading={false} failure={null} live={false} onRetry={() => {}} {...overrides} />;
}

function nodeTranscriptState(overrides: Partial<Parameters<typeof NodeTranscriptState>[0]> = {}): ReactElement {
  return <NodeTranscriptState lines={[]} loading={false} live={false} onRetry={() => {}} {...overrides} />;
}

describe("node inspector output states", () => {
  test("renders structured output and keeps it visible when a refresh fails", async () => {
    await render(nodeOutputState({ row: { summary: "done" } }));
    expect(byTestId("monitor-output-fields").textContent).toContain("done");

    await rerender(nodeOutputState({ row: { summary: "done" }, error: new Error("gateway timed out") }));
    expect(byTestId("monitor-output-fields").textContent).toContain("done");
    expect(byTestId("monitor-output-error").textContent).toContain("gateway timed out");
  });

  test("distinguishes loading from every missing-output outcome", async () => {
    await render(nodeOutputState({ loading: true }));
    expect(byTestId("monitor-output-loading").getAttribute("role")).toBe("status");

    await rerender(nodeOutputState({ failure: { message: "agent failed" } }));
    expect(byTestId("monitor-output-failed").textContent).toContain("Failure details are shown above");

    await rerender(nodeOutputState({ live: true }));
    expect(byTestId("monitor-output-live").textContent).toContain("running");

    await rerender(nodeOutputState());
    expect(byTestId("monitor-output-empty").textContent).toContain("completed without recording structured output");
  });

  test("makes output query failures actionable", async () => {
    let retries = 0;
    await render(
      nodeOutputState({
        error: new Error("output unavailable"),
        onRetry: () => retries++,
      }),
    );
    expect(byTestId("monitor-output-error").getAttribute("role")).toBe("alert");
    expect(byTestId("monitor-output-error").textContent).toContain("output unavailable");
    await click(byTestId("monitor-output-retry"));
    expect(retries).toBe(1);
  });
});

describe("node inspector transcript states", () => {
  test("distinguishes loading and empty live or completed transcripts", async () => {
    await render(nodeTranscriptState({ loading: true }));
    expect(byTestId("monitor-transcript-loading").getAttribute("role")).toBe("status");

    await rerender(nodeTranscriptState({ live: true }));
    expect(byTestId("monitor-transcript-empty").textContent).toContain("No transcript events from this node yet");

    await rerender(nodeTranscriptState());
    expect(byTestId("monitor-transcript-empty").textContent).toContain("finished without recording transcript events");
  });

  test("makes transcript fetch failures actionable", async () => {
    let retries = 0;
    await render(
      nodeTranscriptState({
        error: new Error("events unavailable"),
        onRetry: () => retries++,
      }),
    );
    expect(byTestId("monitor-transcript-error").getAttribute("role")).toBe("alert");
    expect(byTestId("monitor-transcript-error").textContent).toContain("events unavailable");
    await click(byTestId("monitor-transcript-retry"));
    expect(retries).toBe(1);
  });

  test("keeps recorded transcript lines visible when a later poll fails", async () => {
    await render(
      nodeTranscriptState({
        lines: [{ seq: 1, text: "agent output", kind: "text" }],
        error: new Error("poll failed"),
      }),
    );
    expect(byTestId("monitor-live-output").textContent).toContain("agent output");
    expect(byTestId("monitor-transcript-error").textContent).toContain("poll failed");
  });
});

describe("shared control styling contract", () => {
  test("mounting shell controls injects the sui sheet with focus/disabled recipes exactly once", async () => {
    const { element } = toolbarHarness();
    await render(element);
    const sheets = document.querySelectorAll(`style[${SMITHERS_UI_STYLE_ATTR}]`);
    expect(sheets.length).toBe(1);
    // The states under test are real style rules shipped by the shared sheet,
    // not monitor-local duplicates.
    for (const rule of [
      ".sui-button:focus-visible",
      ".sui-input:focus-visible",
      ".sui-select-trigger:focus-visible",
      ".sui-row-button:focus-visible",
      ".sui-button:disabled",
      ".sui-row-button[data-active='true']",
    ]) {
      expect(smithersUiCss).toContain(rule);
    }
  });
});

describe("monitor global keyboard selection", () => {
  test("Escape uses post-mount selection callbacks and preserves the run URL", async () => {
    window.history.replaceState(null, "", "/monitor?runId=run-42&nodeId=node-7");
    expect(window.location.search).toBe("?runId=run-42&nodeId=node-7");
    const selection = { runId: "run-42", nodeId: "node-7" };
    const selectNode = (node: { id: string } | undefined) => {
      keyState.current.selectedNodeKey = node?.id;
      selection.nodeId = node?.id ?? "";
      const params = new URLSearchParams(location.search);
      if (node) params.set("nodeId", node.id);
      else params.delete("nodeId");
      window.history.replaceState(null, "", `/monitor?${params}`);
    };
    const selectRun = (runId: string | undefined) => {
      keyState.current.selectedRunId = runId;
      selection.runId = runId ?? "";
      const params = new URLSearchParams(location.search);
      if (runId) params.set("runId", runId);
      else params.delete("runId");
      window.history.replaceState(null, "", `/monitor${params.toString() ? `?${params}` : ""}`);
    };
    const keyState = {
      current: {
        selectedRunId: undefined,
        selectedNodeKey: undefined,
        sortedTableRuns: [],
        railOrderRuns: [],
        cursorRunId: undefined,
        selectNode: () => {},
        selectRun: () => {},
      },
    } as any;
    const onKeyDown = createMonitorKeydownHandler(
      keyState,
      () => {},
      () => {},
    );
    window.addEventListener("keydown", onKeyDown);
    try {
      keyState.current = {
        ...keyState.current,
        selectedRunId: "run-42",
        selectedNodeKey: "node-7",
        selectNode,
        selectRun,
      };
      await keydown(document.body, "Escape");
      expect(location.search).toBe("?runId=run-42");
      expect(selection).toEqual({ runId: "run-42", nodeId: "" });

      await keydown(document.body, "Escape");
      expect(location.search).toBe("");
      expect(selection).toEqual({ runId: "", nodeId: "" });
    } finally {
      window.removeEventListener("keydown", onKeyDown);
    }
  });

  test("leaves Escape handling to an open shared dialog", async () => {
    let clearedNodes = 0;
    const keyState = {
      current: {
        selectedRunId: "run-42",
        selectedNodeKey: "node-7",
        sortedTableRuns: [],
        railOrderRuns: [],
        cursorRunId: undefined,
        selectNode: () => clearedNodes++,
        selectRun: () => {},
      },
    } as any;
    const onKeyDown = createMonitorKeydownHandler(
      keyState,
      () => {},
      () => {},
    );
    const dialog = document.createElement("div");
    dialog.dataset.slot = "dialog-content";
    const close = document.createElement("button");
    dialog.appendChild(close);
    document.body.appendChild(dialog);
    window.addEventListener("keydown", onKeyDown);
    try {
      await keydown(document.body, "Escape");
      expect(clearedNodes).toBe(0);
      close.addEventListener("keydown", () => dialog.remove(), { once: true });
      await keydown(close, "Escape");
      expect(clearedNodes).toBe(0);
      dialog.remove();
      await keydown(document.body, "Escape");
      expect(clearedNodes).toBe(1);
    } finally {
      dialog.remove();
      window.removeEventListener("keydown", onKeyDown);
    }
  });
});

describe("migrated monitor surfaces", () => {
  const run = {
    runId: "run-surface-42",
    workflowKey: "rendered-coverage",
    status: "failed",
    createdAtMs: Date.now() - 1_000,
    startedAtMs: Date.now() - 900,
    finishedAtMs: Date.now() - 100,
    summary: { finished: 3, failed: 1, pending: 1 },
  };

  test("preserves status tones, data-status, stat-card testids, and failed progress", async () => {
    await render(
      <div>
        <StatusTag status="running" />
        <StatusTag status="waiting_approval" />
        <StatusTag status="finished" />
        <StatusTag status="failed" />
        <StatCard value="7" label="active runs" sub="1 needs attention" tone="waiting" testId="monitor-stat-test" />
        <RunProgressCell run={run} />
      </div>,
    );
    expect(document.querySelector('[data-status="running"]')?.className).toContain("sui-badge-default");
    expect(document.querySelector('[data-status="waiting-approval"]')?.className).toContain("sui-badge-warning");
    expect(document.querySelector('[data-status="finished"]')?.className).toContain("sui-badge-success");
    expect(document.querySelector('[data-status="failed"]')?.className).toContain("sui-badge-destructive");
    expect(byTestId("monitor-stat-test").getAttribute("data-slot")).toBe("card");
    expect(byTestId("monitor-stat-test").querySelector('[data-slot="card-content"]')).not.toBeNull();
    for (const status of document.querySelectorAll("[data-status]")) {
      expect(status.getAttribute("data-slot")).toBe("badge");
      expect(status.className).toContain("sui-badge");
    }
    expect(byTestId("monitor-stat-test").className).toContain("tone-waiting");
    expect(byTestId("monitor-stat-test").textContent).toContain("active runs");
    expect(byTestId("monitor-run-progress").textContent).toContain("4/5");
    expect(byTestId("monitor-run-progress").textContent).toContain("1 failed");
    const progress = byTestId("monitor-run-progress").querySelector('[data-slot="progress"]');
    expect(progress).not.toBeNull();
    expect(progress?.getAttribute("role")).toBe("progressbar");
    expect(progress?.getAttribute("aria-label")).toBe("4 of 5 nodes complete");
    expect(progress?.getAttribute("aria-valuenow")).toBe("4");
    expect(progress?.getAttribute("aria-valuemax")).toBe("5");
    expect(progress?.className).toContain("mon-table-progress");
  });

  test("uses shared status pills for enabled and disabled crons", async () => {
    await render(
      <div>
        <CronStatusTag enabled />
        <CronStatusTag enabled={false} />
      </div>,
    );
    const enabled = document.querySelector('[data-status="enabled"]');
    const disabled = document.querySelector('[data-status="disabled"]');
    expect(enabled?.getAttribute("data-slot")).toBe("badge");
    expect(enabled?.className).toContain("sui-badge-success");
    expect(enabled?.textContent).toContain("enabled");
    expect(disabled?.getAttribute("data-slot")).toBe("badge");
    expect(disabled?.className).toContain("sui-badge-muted");
    expect(disabled?.textContent).toContain("disabled");
  });

  test("preserves complete and missing-summary progress semantics", async () => {
    await render(<RunProgressCell run={{ ...run, status: "finished", summary: { finished: 2, skipped: 1 } }} />);
    const complete = byTestId("monitor-run-progress");
    const progress = complete.querySelector('[data-slot="progress"]');
    expect(complete.textContent).toContain("3/3");
    expect(complete.textContent).not.toContain("failed");
    expect(progress?.getAttribute("aria-valuenow")).toBe("3");
    expect(progress?.getAttribute("aria-valuemax")).toBe("3");

    await rerender(<RunProgressCell run={{ ...run, summary: undefined }} />);
    expect(document.body.textContent).toContain("—");
    expect(document.querySelector('[data-testid="monitor-run-progress"]')).toBeNull();
    expect(document.querySelector('[data-slot="progress"]')).toBeNull();
  });

  test("renders populated, loading, empty, offline, and unauthorized run-rail states", async () => {
    await render(
      <RunsRail runs={[run]} loading={false} connStatus="online" selectedRunId={run.runId} onSelect={() => {}} />,
    );
    expect(byTestId("monitor-runs")).toBeDefined();
    expect(byTestId("monitor-run-row").getAttribute("data-active")).toBe("true");
    expect(byTestId("monitor-run-row").textContent).toContain("rendered-coverage");

    await rerender(
      <RunsRail runs={[]} loading connStatus="connecting" selectedRunId={undefined} onSelect={() => {}} />,
    );
    expect(byTestId("monitor-runs").textContent).toContain("Loading runs");
    await rerender(
      <RunsRail runs={[]} loading={false} connStatus="online" selectedRunId={undefined} onSelect={() => {}} />,
    );
    expect(byTestId("monitor-empty").textContent).toContain("No runs yet");
    await rerender(
      <RunsRail runs={[]} loading={false} connStatus="offline" selectedRunId={undefined} onSelect={() => {}} />,
    );
    expect(byTestId("monitor-runs-offline").textContent?.toLowerCase()).toContain("gateway");
    expect(byTestId("monitor-runs-offline").getAttribute("data-slot")).toBe("alert");
    await rerender(
      <RunsRail runs={[]} loading={false} connStatus="unauthorized" selectedRunId={undefined} onSelect={() => {}} />,
    );
    expect(byTestId("monitor-runs-unauthorized").textContent?.toLowerCase()).toContain("credentials");
    expect(byTestId("monitor-runs-unauthorized").getAttribute("data-slot")).toBe("alert");
    await rerender(
      <RunsRail
        runs={[{ ...run, status: "running" }]}
        loading={false}
        connStatus="offline"
        selectedRunId={undefined}
        onSelect={() => {}}
      />,
    );
    expect(byTestId("monitor-runs-offline").textContent).toContain("last-known data");
    expect(byTestId("monitor-run-row").textContent).toContain("last-known");
    expect(byTestId("monitor-run-row").querySelector(".mon-status-pulse")).toBeNull();
  });

  test("renders loading, error, no-runs, and filtered-out table states", async () => {
    let resets = 0;
    let retries = 0;
    await render(<RunsTable runs={[]} loading page={1} onPageChange={() => {}} onSelect={() => {}} />);
    expect(byTestId("monitor-empty-detail").textContent).toContain("Loading runs");
    expect(byTestId("monitor-empty-detail").getAttribute("data-state")).toBe("loading");
    await rerender(
      <RunsTable
        runs={[]}
        loading={false}
        queryError={new Error("query failed")}
        onRetry={() => retries++}
        page={1}
        onPageChange={() => {}}
        onSelect={() => {}}
      />,
    );
    expect(byTestId("monitor-empty-detail").textContent).toContain("Couldn't load runs");
    expect(byTestId("monitor-empty-detail").textContent).toContain("query failed");
    expect(byTestId("monitor-empty-detail").getAttribute("data-state")).toBe("error");
    await click(byTestId("monitor-empty-detail-retry"));
    expect(retries).toBe(1);
    await rerender(<RunsTable runs={[]} loading={false} page={1} onPageChange={() => {}} onSelect={() => {}} />);
    expect(byTestId("monitor-empty-detail").textContent).toContain("No runs yet");
    expect(byTestId("monitor-empty-detail").textContent).toContain("smithers up");
    await rerender(
      <RunsTable
        runs={[]}
        loading={false}
        totalCount={1}
        onResetFilters={() => resets++}
        page={1}
        onPageChange={() => {}}
        onSelect={() => {}}
      />,
    );
    expect(byTestId("monitor-empty-detail").textContent).toContain("No runs match your filters");
    expect(byTestId("monitor-empty-detail").getAttribute("data-state")).toBe("filtered");
    await click(byTestId("monitor-empty-detail-reset"));
    expect(resets).toBe(1);
  });

  test("renders a populated shared table panel", async () => {
    await render(<RunsTable runs={[run]} loading={false} page={1} onPageChange={() => {}} onSelect={() => {}} />);
    expect(byTestId("monitor-runs-table")).toBeDefined();
    expect(document.querySelector(".mon-runs-table-panel")?.getAttribute("data-slot")).toBe("card");
    expect(document.querySelector(".mon-runs-table-panel [data-slot='card-header']")).not.toBeNull();
    expect(document.querySelector(".mon-runs-table-panel [data-slot='card-content']")).not.toBeNull();
    expect(byTestId("monitor-run-progress").textContent).toContain("1 failed");
  });

  test("transitions honestly through every connection and cache landing state", async () => {
    const table = (overrides: Partial<Parameters<typeof RunsTable>[0]> = {}): ReactElement => (
      <RunsTable
        runs={[]}
        loading={false}
        connStatus="connecting"
        page={1}
        onPageChange={() => {}}
        onSelect={() => {}}
        {...overrides}
      />
    );
    const cachedRun = { ...run, status: "running", finishedAtMs: undefined };

    await render(table());
    expect(byTestId("monitor-empty-detail").getAttribute("data-state")).toBe("connecting");
    expect(byTestId("monitor-empty-detail").textContent).toContain("Connecting to the Smithers gateway");
    expect(byTestId("monitor-empty-detail").textContent).not.toContain("No runs yet");

    await rerender(table({ connStatus: "offline", queryError: new Error("connection refused") }));
    expect(byTestId("monitor-empty-detail").getAttribute("data-state")).toBe("offline-without-cache");
    expect(byTestId("monitor-empty-detail").getAttribute("data-slot")).toBe("alert");
    expect(byTestId("monitor-empty-detail").textContent).toContain("No last-known runs are available");
    expect(byTestId("monitor-empty-detail").textContent).not.toContain("No runs yet");

    await rerender(table({ connStatus: "online" }));
    expect(byTestId("monitor-empty-detail").getAttribute("data-state")).toBe("empty");
    expect(byTestId("monitor-empty-detail").textContent).toContain("No runs yet");

    await rerender(table({ connStatus: "offline", runs: [cachedRun], totalCount: 1, hasCachedData: true }));
    expect(byTestId("monitor-runs-last-known").textContent).toContain("Every run shown below is last-known data");
    expect(byTestId("monitor-runs-last-known").getAttribute("data-slot")).toBe("alert");
    expect(document.querySelector(".mon-runs-table-panel")?.getAttribute("data-state")).toBe("offline-with-cache");
    expect(document.querySelector(".mon-runs-table-row")?.textContent).toContain("running · last-known");
    expect(document.querySelector(".mon-runs-table-row .mon-status-pulse")).toBeNull();
    expect([...document.querySelectorAll(".mon-runs-table-row td")].at(-1)?.textContent).toBe("last-known");

    await rerender(table({ connStatus: "unauthorized", runs: [cachedRun], totalCount: 1, hasCachedData: true }));
    expect(byTestId("monitor-empty-detail").getAttribute("data-state")).toBe("unauthorized");
    expect(byTestId("monitor-empty-detail").getAttribute("data-slot")).toBe("alert");
    expect(byTestId("monitor-empty-detail").textContent).toContain("fresh gateway credentials");
    expect(document.querySelector(".mon-runs-table-row")).toBeNull();
  });

  test("keeps last-known rows visible while refetching and after a failed refresh", async () => {
    let retries = 0;
    await render(<RunsTable runs={[run]} loading page={1} onPageChange={() => {}} onSelect={() => {}} />);
    expect(byTestId("monitor-runs-table")).toBeDefined();
    expect(document.querySelector('[data-testid="monitor-empty-detail"][data-state="loading"]')).toBeNull();

    await rerender(
      <RunsTable
        runs={[run]}
        loading={false}
        queryError={new Error("refresh failed")}
        onRetry={() => retries++}
        page={1}
        onPageChange={() => {}}
        onSelect={() => {}}
      />,
    );
    expect(document.querySelector(".mon-runs-table-row")?.textContent).toContain("rendered-coverage");
    expect(byTestId("monitor-runs-table-query-error").textContent).toContain("refresh failed");
    expect(byTestId("monitor-runs-table-query-error").getAttribute("data-slot")).toBe("alert");
    await click(byTestId("monitor-runs-table-query-error-retry"));
    expect(retries).toBe(1);
  });

  test("keyboard: run rows activate with Enter and Space", async () => {
    const selected: string[] = [];
    await render(
      <RunsTable
        runs={[run]}
        loading={false}
        page={1}
        onPageChange={() => {}}
        onSelect={(runId) => selected.push(runId)}
        cursorRunId={run.runId}
      />,
    );

    const scrollport = document.querySelector<HTMLElement>(".mon-runs-scroll")!;
    expect(scrollport.tabIndex).toBe(0);
    expect(scrollport.getAttribute("role")).toBe("region");
    expect(scrollport.getAttribute("aria-label")).toBe("Runs table");

    const row = document.querySelector<HTMLElement>(".mon-runs-table-row")!;
    expect(row.tabIndex).toBe(0);
    expect(row.getAttribute("role")).toBe("button");
    expect(row.getAttribute("aria-current")).toBe("true");
    expect(row.getAttribute("aria-label")).toBe(`rendered-coverage, run ${run.runId}, failed`);
    await act(async () => row.focus());
    expect(document.activeElement).toBe(row);

    await keydown(row, "Enter");
    await keydown(row, " ");
    expect(selected).toEqual([run.runId, run.runId]);
  });

  test("sorts attention-first by default and click-sorts by start time", async () => {
    const rows = [
      { runId: "run-old-finish", workflowKey: "alpha", status: "finished", createdAtMs: 1, startedAtMs: 1 },
      { runId: "run-live", workflowKey: "beta", status: "running", createdAtMs: 2, startedAtMs: 2 },
      { runId: "run-blocked", workflowKey: "gamma", status: "waiting-approval", createdAtMs: 3, startedAtMs: 3 },
    ];
    await render(<RunsTable runs={rows} loading={false} page={1} onPageChange={() => {}} onSelect={() => {}} />);

    const orderedIds = () =>
      [...document.querySelectorAll(".mon-runs-table-row")].map((row) => row.getAttribute("data-run-id"));
    // Default triage order: the waiting run first, then the live one.
    expect(orderedIds()).toEqual(["run-blocked", "run-live", "run-old-finish"]);

    // The workflow cell owns row identity: name first, run id as secondary line.
    const firstCell = document.querySelector(".mon-runs-table-row .mon-table-workflow")!;
    expect(firstCell.querySelector(".mon-table-workflow-name")!.textContent).toBe("gamma");
    expect(firstCell.querySelector(".mon-table-runid")!.textContent).toBe("run-bloc");

    const sortHeader = byTestId("monitor-sort-started");
    await click(sortHeader); // → newest first
    expect(orderedIds()).toEqual(["run-blocked", "run-live", "run-old-finish"]);
    expect(sortHeader.textContent).toContain("▾");
    await click(sortHeader); // → oldest first
    expect(orderedIds()).toEqual(["run-old-finish", "run-live", "run-blocked"]);
    expect(sortHeader.textContent).toContain("▴");
    await click(sortHeader); // → back to triage order
    expect(orderedIds()).toEqual(["run-blocked", "run-live", "run-old-finish"]);
  });

  test("controlled sort reports header clicks upward and the keyboard cursor row is marked", async () => {
    const rows = [
      { runId: "run-a", workflowKey: "alpha", status: "finished", createdAtMs: 1, startedAtMs: 1 },
      { runId: "run-b", workflowKey: "beta", status: "finished", createdAtMs: 2, startedAtMs: 2 },
    ];
    const sorts: string[] = [];
    await render(
      <RunsTable
        runs={rows}
        loading={false}
        page={1}
        onPageChange={() => {}}
        onSelect={() => {}}
        sort="oldest"
        onSortChange={(sort) => sorts.push(sort)}
        cursorRunId="run-b"
      />,
    );
    // Controlled: rendered order follows the sort prop, clicks go to the owner.
    const orderedIds = () =>
      [...document.querySelectorAll(".mon-runs-table-row")].map((row) => row.getAttribute("data-run-id"));
    expect(orderedIds()).toEqual(["run-a", "run-b"]);
    await click(byTestId("monitor-sort-started"));
    expect(sorts).toEqual(["default"]);
    // The j/k cursor row carries its marker class for the highlight styles.
    expect(document.querySelector('[data-run-id="run-b"]')!.className).toContain("is-kbcursor");
    expect(document.querySelector('[data-run-id="run-a"]')!.className).not.toContain("is-kbcursor");
    expect(document.querySelector('[data-run-id="run-b"]')!.getAttribute("aria-current")).toBe("true");
    expect(document.querySelector('[data-run-id="run-a"]')!.getAttribute("aria-current")).toBeNull();
  });
});

describe("monitor event states", () => {
  test("distinguishes initial loading, durable emptiness, and both filtered-empty views", async () => {
    await render(<EventLog runId="run-events" eventsState={eventLogState({ loading: true, streaming: false })} />);
    expect(byTestId("monitor-events-state").getAttribute("data-state")).toBe("loading");
    expect(byTestId("monitor-events-state").getAttribute("role")).toBe("status");
    expect(byTestId("monitor-events-state").textContent).toContain("Loading events");

    await rerender(<EventLog runId="run-events" eventsState={eventLogState()} />);
    expect(byTestId("monitor-events-state").getAttribute("data-state")).toBe("empty");
    expect(byTestId("monitor-events-state").textContent).toContain("No events recorded for this run yet");

    const chatter = eventLogState({
      events: [{ event: "AgentSessionEvent", seq: 1, stateVersion: 0, payload: {} }],
    });
    await rerender(<EventLog runId="run-events" eventsState={chatter} />);
    expect(byTestId("monitor-events-state").getAttribute("data-state")).toBe("filtered-activity");
    expect(byTestId("monitor-events-state").textContent).toContain("Switch to All");

    await click(buttonNamed("Notable"));
    expect(byTestId("monitor-events-state").getAttribute("data-state")).toBe("filtered-notable");
    expect(byTestId("monitor-events-state").textContent).toContain("Switch to Activity or All");

    await click(buttonNamed("All"));
    expect(document.querySelectorAll(".mon-event").length).toBe(1);
    expect(document.querySelector('[data-testid="monitor-events-state"]')).toBeNull();
  });

  test("surfaces an empty query failure with guidance and a retry action", async () => {
    let retries = 0;
    await render(
      <EventLog
        runId="run-events"
        eventsState={eventLogState({
          error: new Error("event query failed"),
          streaming: false,
          refetch: async () => {
            retries++;
          },
        })}
      />,
    );
    expect(byTestId("monitor-events-error").getAttribute("data-state")).toBe("error");
    expect(byTestId("monitor-events-error").textContent).toContain("Couldn't load events");
    expect(byTestId("monitor-events-error").textContent).toContain("Check the gateway connection and credentials");
    expect(document.querySelector('[data-testid="monitor-events-state"]')).toBeNull();
    await click(byTestId("monitor-events-retry"));
    expect(retries).toBe(1);
  });

  test("keeps buffered events visible and labels them last-known when live updates fail", async () => {
    let retries = 0;
    await render(
      <EventLog
        runId="run-events"
        eventsState={eventLogState({
          events: [{ event: "NodeStarted", seq: 7, stateVersion: 0, payload: { nodeId: "build" } }],
          error: new Error("stream disconnected"),
          streaming: false,
          refetch: async () => {
            retries++;
          },
        })}
      />,
    );
    expect(byTestId("monitor-events-error").getAttribute("data-state")).toBe("stale");
    expect(byTestId("monitor-events-error").textContent).toContain("Showing last-known events");
    expect(document.querySelector(".mon-event")?.textContent).toContain("NodeStarted");
    await click(byTestId("monitor-events-retry"));
    expect(retries).toBe(1);
  });

  test("distinguishes an offline stream and explains whether cached events are last-known", async () => {
    await render(
      <EventLog
        runId="run-events"
        eventsState={eventLogState({
          events: [{ event: "NodeStarted", seq: 7, stateVersion: 0, payload: { nodeId: "build" } }],
          error: new Error("Run event stream failed."),
          streaming: false,
          connectionStatus: "offline",
        })}
      />,
    );
    expect(byTestId("monitor-events-error").getAttribute("data-state")).toBe("offline-stale");
    expect(byTestId("monitor-events-error").textContent).toContain("Live event connection lost");
    expect(byTestId("monitor-events-error").textContent).toContain("Showing last-known events");
    expect(byTestId("monitor-events-error").textContent).toContain("reconnects automatically");

    await rerender(
      <EventLog
        runId="run-events"
        eventsState={eventLogState({
          error: new Error("Run event stream failed."),
          streaming: false,
          connectionStatus: "offline",
        })}
      />,
    );
    expect(byTestId("monitor-events-error").getAttribute("data-state")).toBe("offline");
    expect(byTestId("monitor-events-error").textContent).toContain("No last-known events are available");
  });

  test("gives an unauthorized stream a credential-specific recovery path", async () => {
    await render(
      <EventLog
        runId="run-events"
        eventsState={eventLogState({
          error: new Error("Run event stream failed."),
          streaming: false,
          connectionStatus: "unauthorized",
        })}
      />,
    );
    expect(byTestId("monitor-events-error").getAttribute("data-state")).toBe("unauthorized");
    expect(byTestId("monitor-events-error").textContent).toContain("Event stream unauthorized");
    expect(byTestId("monitor-events-error").textContent).toContain("Re-open with smithers monitor");
    expect(byTestId("monitor-events-error").textContent).toContain("fresh gateway credentials");
  });
});
describe("event log accessibility", () => {
  const eventsState = (
    overrides: Partial<Parameters<typeof EventLog>[0]["eventsState"]> = {},
  ): Parameters<typeof EventLog>[0]["eventsState"] => ({
    events: [
      {
        type: "event",
        event: "NodeStarted",
        payload: { nodeId: "task-1" },
        seq: 1,
        stateVersion: 1,
        timestampMs: Date.now() - 2_000,
      },
      {
        type: "event",
        event: "AgentEvent",
        payload: { text: "working" },
        seq: 2,
        stateVersion: 2,
        timestampMs: Date.now() - 1_000,
      },
    ],
    lastHeartbeat: undefined,
    error: undefined,
    streaming: true,
    loading: false,
    ...overrides,
  });

  test("exposes a focusable live list, row semantics, and selected filter state", async () => {
    await render(<EventLog runId="run-events" eventsState={eventsState()} />);

    const list = byTestId("monitor-events");
    expect(list.tagName).toBe("OL");
    expect(list.tabIndex).toBe(0);
    expect(list.getAttribute("aria-label")).toBe("Activity event stream");
    expect(list.getAttribute("aria-live")).toBe("polite");
    expect(list.getAttribute("aria-relevant")).toBe("additions text");
    expect(list.getAttribute("aria-busy")).toBe("false");
    await act(async () => list.focus());
    expect(document.activeElement).toBe(list);

    const rows = [...list.querySelectorAll(".mon-event")];
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.tagName === "LI")).toBe(true);

    const activity = byTestId("monitor-events-filter-activity");
    const notable = byTestId("monitor-events-filter-notable");
    expect(activity.getAttribute("aria-pressed")).toBe("true");
    expect(notable.getAttribute("aria-pressed")).toBe("false");
    expect(activity.getAttribute("aria-controls")).toBe(list.id);

    await act(async () => notable.focus());
    expect(document.activeElement).toBe(notable);
    await click(notable);
    expect(notable.getAttribute("aria-pressed")).toBe("true");
    expect(activity.getAttribute("aria-pressed")).toBe("false");
    expect(list.getAttribute("aria-label")).toBe("Notable event stream");
    expect(list.querySelectorAll(".mon-event")).toHaveLength(1);
  });

  test("announces paused following and provides a keyboard-focusable resume control", async () => {
    await render(<EventLog runId="run-follow" eventsState={eventsState()} />);

    const list = byTestId("monitor-events");
    Object.defineProperty(list, "scrollHeight", { configurable: true, value: 1_000 });
    Object.defineProperty(list, "clientHeight", { configurable: true, value: 100 });
    list.scrollTop = 100;
    await act(async () => list.dispatchEvent(new Event("scroll", { bubbles: true })));

    const follow = byTestId("monitor-events-follow");
    const status = byTestId("monitor-events-follow-status");
    expect(follow.getAttribute("aria-pressed")).toBe("false");
    expect(follow.getAttribute("aria-label")).toBe("Resume following new events");
    expect(follow.textContent).toContain("Resume follow");
    expect(status.textContent).toContain("paused");
    expect(list.getAttribute("aria-live")).toBe("off");

    await act(async () => follow.focus());
    expect(document.activeElement).toBe(follow);
    await click(follow);
    expect(follow.getAttribute("aria-pressed")).toBe("true");
    expect(follow.getAttribute("aria-label")).toBe("Following new events");
    expect(follow.textContent).toContain("Following");
    expect(status.textContent).toContain("Following new events");
    expect(list.getAttribute("aria-live")).toBe("polite");
    expect(list.scrollTop).toBe(1_000);
  });
});

describe("execution tree unavailable states", () => {
  const historicalRoot = {
    key: "workflow#0",
    id: "workflow",
    name: "Previous valid frame",
    kind: "workflow",
    status: "running",
    children: [],
  };

  test("distinguishes live loading, successful empty, and failed query states", async () => {
    let retries = 0;
    await render(executionTree({ isLoading: true }));
    expect(byTestId("monitor-tree-loading").textContent).toContain("Loading execution tree");

    await rerender(executionTree());
    expect(byTestId("monitor-tree-empty").textContent).toContain("No nodes recorded yet");

    await rerender(
      <ExecutionTree
        runId="run-tree-states"
        treeQuery={{
          root: null,
          nodes: [],
          status: "queued",
          isLoading: false,
          error: new Error("live query failed"),
        }}
        selectedNodeKey={undefined}
        onSelectNode={() => {}}
        onRetry={() => retries++}
      />,
    );
    expect(byTestId("monitor-tree-error").textContent).toContain("live query failed");
    await click(byTestId("monitor-tree-retry"));
    expect(retries).toBe(1);
  });

  test("distinguishes empty and unavailable historical frames with recovery actions", async () => {
    let retries = 0;
    let returnsToLive = 0;
    const treeQuery = {
      root: null,
      nodes: [],
      status: "queued" as const,
      isLoading: false,
      error: undefined,
    };
    await render(
      <ExecutionTree
        runId="run-tree-states"
        treeQuery={treeQuery}
        selectedNodeKey={undefined}
        onSelectNode={() => {}}
        frameOverride={{ root: null, loading: false }}
      />,
    );
    expect(byTestId("monitor-frame-empty").textContent).toContain("No nodes in this frame");

    await rerender(
      <ExecutionTree
        runId="run-tree-states"
        treeQuery={treeQuery}
        selectedNodeKey={undefined}
        onSelectNode={() => {}}
        frameOverride={{
          root: null,
          loading: false,
          error: new Error("snapshot fetch failed"),
          onRetry: () => retries++,
          onReturnToLive: () => returnsToLive++,
        }}
      />,
    );
    expect(byTestId("monitor-frame-unavailable").textContent).toContain("snapshot fetch failed");
    await click(byTestId("monitor-frame-retry"));
    await click(byTestId("monitor-frame-live"));
    expect(retries).toBe(1);
    expect(returnsToLive).toBe(1);
  });

  test("keeps the previous valid frame visible while loading and after a failed scrub", async () => {
    const treeQuery = {
      root: null,
      nodes: [],
      status: "queued" as const,
      isLoading: false,
      error: undefined,
    };
    await render(
      <ExecutionTree
        runId="run-tree-states"
        treeQuery={treeQuery}
        selectedNodeKey={undefined}
        onSelectNode={() => {}}
        frameOverride={{ root: historicalRoot, loading: true }}
      />,
    );
    expect(byTestId("monitor-frame-loading").textContent).toContain("previous frame");
    expect(byTestId("monitor-tree").textContent).toContain("Previous valid frame");

    await rerender(
      <ExecutionTree
        runId="run-tree-states"
        treeQuery={treeQuery}
        selectedNodeKey={undefined}
        onSelectNode={() => {}}
        frameOverride={{ root: historicalRoot, loading: false, error: new Error("frame 3 failed") }}
      />,
    );
    expect(byTestId("monitor-frame-unavailable").textContent).toContain("Showing the previous frame");
    expect(byTestId("monitor-tree").textContent).toContain("Previous valid frame");
  });
});

describe("monitor theme contract", () => {
  test("execution views expose named focusable regions without claiming an incomplete ARIA tree", () => {
    expect(monitorSource).not.toContain('role="tree"');
    expect(monitorSource).not.toContain('role="treeitem"');
    expect(monitorSource).toContain('aria-label="Execution tree"');
    expect(monitorSource).toContain('aria-label="Execution tree XML"');
    expect(monitorSource).toContain("aria-expanded={expanded}");
  });

  test("inherits explicit light/dark and OS-fallback tokens from the shared theme", () => {
    expect(workflowUiThemeCss).toContain(":root:not([data-theme='light'])");
    expect(workflowUiThemeCss).toContain(":root[data-theme='dark']");
    expect(workflowUiThemeCss).toContain("prefers-color-scheme: dark");
    for (const token of ["--bg", "--surface", "--text", "--border", "--brand", "--ok", "--warn", "--err"]) {
      expect(workflowUiThemeCss).toContain(token);
      expect(monitorCss).toContain(`var(${token})`);
    }
  });

  test("shell, controls, statuses, cards, alerts, progress, dialogs, empty states, and terminal mounts use tokens", () => {
    const rules = [
      [".mon-shell", "overflow: hidden"],
      [".mon-filter-input", "min-width"],
      // The stat surface itself moved to the shared Card slot (data-slot="card",
      // asserted above); .mon-stat keeps only its flex sizing.
      [".mon-stat {", "flex: 1 1 120px"],
      [".mon-progress-fill", "var(--brand)"],
      [".mon-modal.sui-dialog-content", "max-width: none"],
      [".mon-empty", "var(--muted)"],
      [".mon-hijack-surface", "var(--sp-2)"],
    ];
    for (const [selector, declaration] of rules) {
      const start = monitorCss.indexOf(selector);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(monitorCss.slice(start, start + 500)).toContain(declaration);
    }
    expect(smithersUiCss).toContain(".sui-dialog-content");
    expect(monitorCss).not.toContain(".mon-modal-backdrop");
    expect(smithersUiCss).toContain(".sui-card");
    for (const selector of [".sui-badge", ".sui-alert"]) {
      expect(smithersUiCss).toContain(selector);
    }
    expect(monitorCss).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(monitorCss).not.toContain("background: white");
    expect(monitorCss).not.toContain("color-mix");
  });

  test("tree, timeline, approval, and summary controls expose the house focus ring", () => {
    for (const selector of [
      ".mon-tree-chevron:focus-visible",
      ".mon-tree-main:focus-visible",
      ".mon-events:focus-visible",
      ".mon-timeline-row:focus-visible",
      ".mon-approval-main:focus-visible",
      ".mon-runs-table-row:focus-visible",
      ".mon-diff-summary:focus-visible",
      ".mon-scores-summary:focus-visible",
    ]) {
      expect(monitorCss).toContain(selector);
    }
    expect(monitorCss).toContain("box-shadow: 0 0 0 3px var(--ring)");
  });
});

test("monitor delegates hijack UI to the shared maximizable oneshot surface", () => {
  expect(monitorSource).toContain("<OneshotSurface");
  expect(monitorSource).toContain('variant="overlay"');
  expect(monitorSource).toContain('initialTab="terminal"');
  expect(monitorSource).not.toContain("function HijackTerminal(");
});

describe("MonitorToolbar", () => {
  test("renders the shared Input and Select primitives with the monitor testids", async () => {
    const { element } = toolbarHarness();
    await render(element);

    const filter = byTestId("monitor-filter");
    expect(filter.tagName).toBe("INPUT");
    expect(filter.getAttribute("data-slot")).toBe("input");
    expect(filter.className).toContain("sui-input");

    for (const testId of ["monitor-status-filter", "monitor-workflow-filter"]) {
      const trigger = byTestId(testId);
      expect(trigger.getAttribute("data-slot")).toBe("select-trigger");
      expect(trigger.className).toContain("sui-select-trigger");
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
    }

    const metrics = byTestId("monitor-metrics-chip");
    expect(metrics.className).toContain("sui-button");
    expect(metrics.getAttribute("type")).toBe("button");
  });

  test("focus: the filter input and select triggers take keyboard focus", async () => {
    const { element } = toolbarHarness();
    await render(element);

    const filter = byTestId("monitor-filter");
    await act(async () => filter.focus());
    expect(document.activeElement).toBe(filter);

    const status = byTestId("monitor-status-filter");
    await act(async () => status.focus());
    expect(document.activeElement).toBe(status);
  });

  test("typing in the filter input reports the text (behavior preserved)", async () => {
    const { element, calls } = toolbarHarness();
    await render(element);
    const filter = byTestId("monitor-filter") as HTMLInputElement;
    await act(async () => {
      // Write through the prototype setter: React tracks the instance value to
      // dedupe events, so a plain `.value =` assignment would be swallowed.
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setValue?.call(filter, "docs");
      filter.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(calls.filterText).toEqual(["docs"]);
  });

  test("keyboard: ArrowDown opens the status listbox, Enter selects, and the filter fires", async () => {
    const { element, calls } = toolbarHarness();
    await render(element);
    const trigger = byTestId("monitor-status-filter");

    await keydown(trigger, "ArrowDown");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const items = [...document.querySelectorAll('[data-slot="select-item"]')] as HTMLElement[];
    expect(items.map((item) => item.textContent)).toEqual(["all statuses", "running", "failed"]);
    // Radix moves focus into the open listbox for keyboard navigation.
    expect((document.activeElement as HTMLElement | null)?.getAttribute("data-slot")).toBe("select-item");

    const running = items.find((item) => item.textContent === "running");
    expect(running).toBeDefined();
    await act(async () => running!.focus());
    await keydown(running!, "Enter");
    expect(calls.status).toEqual(["running"]);
    // Selection closes the listbox again.
    expect(document.querySelector('[data-slot="select-content"]')).toBeNull();
  });

  test("keyboard: Escape closes the open workflow listbox without selecting", async () => {
    const { element, calls } = toolbarHarness();
    await render(element);
    const trigger = byTestId("monitor-workflow-filter");

    await keydown(trigger, "ArrowDown");
    expect(document.querySelector('[data-slot="select-content"]')).not.toBeNull();
    await keydown(document.activeElement ?? trigger, "Escape");
    expect(document.querySelector('[data-slot="select-content"]')).toBeNull();
    expect(calls.workflow).toEqual([]);
  });

  test("active: the Metrics chip carries aria-pressed and the is-on accent only when on", async () => {
    const off = toolbarHarness();
    await render(off.element);
    const offChip = byTestId("monitor-metrics-chip");
    expect(offChip.getAttribute("aria-pressed")).toBe("false");
    expect(offChip.className).not.toContain("is-on");
    await click(offChip);
    expect(off.calls.metrics).toBe(1);

    if (root) {
      const r = root;
      await act(async () => r.unmount());
      root = undefined;
    }
    container?.remove();

    const on = toolbarHarness({ showMetrics: true });
    await render(on.element);
    const onChip = byTestId("monitor-metrics-chip");
    expect(onChip.getAttribute("aria-pressed")).toBe("true");
    expect(onChip.className).toContain("is-on");
  });
});

describe("RunsPagination", () => {
  test("disabled: Prev is inert on the first page, Next pages forward", async () => {
    const pages: number[] = [];
    await render(
      <RunsPagination
        page={1}
        pageCount={3}
        firstRow={1}
        lastRow={50}
        total={120}
        onPageChange={(page) => pages.push(page)}
      />,
    );
    expect(byTestId("monitor-runs-pagination")).toBeDefined();

    const prev = byTestId("monitor-page-prev") as HTMLButtonElement;
    const next = byTestId("monitor-page-next") as HTMLButtonElement;
    expect(prev.disabled).toBe(true);
    expect(next.disabled).toBe(false);
    expect(prev.className).toContain("sui-button");

    await click(prev);
    expect(pages).toEqual([]);
    await click(next);
    expect(pages).toEqual([2]);
  });

  test("disabled: Next is inert on the last page", async () => {
    const pages: number[] = [];
    await render(
      <RunsPagination
        page={3}
        pageCount={3}
        firstRow={101}
        lastRow={120}
        total={120}
        onPageChange={(page) => pages.push(page)}
      />,
    );
    const next = byTestId("monitor-page-next") as HTMLButtonElement;
    expect(next.disabled).toBe(true);
    await click(next);
    expect(pages).toEqual([]);
    await click(byTestId("monitor-page-prev"));
    expect(pages).toEqual([2]);
  });
});

describe("RunRailRow", () => {
  function row(active: boolean, onSelect: (runId: string) => void = () => {}) {
    return (
      <RunRailRow
        runId="run-42"
        name="hello"
        title="hello"
        shortId="run-42"
        tone="running"
        pulse
        when="3m ago"
        active={active}
        onSelect={onSelect}
      />
    );
  }

  test("active: the selected row is a shared RowButton with data-active", async () => {
    await render(row(true));
    const el = byTestId("monitor-run-row");
    expect(el.tagName).toBe("BUTTON");
    expect((el as HTMLButtonElement).type).toBe("button");
    expect(el.className).toContain("sui-row-button");
    expect(el.getAttribute("data-slot")).toBe("row-button");
    expect(el.getAttribute("data-active")).toBe("true");
    expect(el.getAttribute("data-run-id")).toBe("run-42");
    expect(el.getAttribute("aria-current")).toBe("true");
    expect(el.getAttribute("aria-label")).toBe("hello, run run-42");
  });

  test("inactive rows drop data-active, stay focusable, and select on click", async () => {
    const selected: string[] = [];
    await render(row(false, (runId) => selected.push(runId)));
    const el = byTestId("monitor-run-row");
    expect(el.getAttribute("data-active")).toBeNull();
    expect(el.getAttribute("aria-current")).toBeNull();
    expect(el.getAttribute("aria-label")).toBe("hello, run run-42");
    await act(async () => el.focus());
    expect(document.activeElement).toBe(el);
    await click(el);
    expect(selected).toEqual(["run-42"]);
  });
});

describe("RunLifecycleActions", () => {
  test("armed cancel renders an explicit destructive confirmation and keep affordance", async () => {
    const actions: string[] = [];
    let kept = 0;
    await render(
      <RunLifecycleActions
        resumable={false}
        pausable={false}
        cancellable
        cancelArmed
        busyAction={null}
        onAction={(kind) => actions.push(kind)}
        onCancelKeep={() => kept++}
      />,
    );
    expect(byTestId("monitor-confirm-cancel-run").textContent).toBe("Confirm cancel?");
    expect(byTestId("monitor-confirm-cancel-run").className).toContain("sui-button-destructive");
    await click(byTestId("monitor-confirm-cancel-run"));
    await click(byTestId("monitor-keep-cancel-run"));
    expect(actions).toEqual(["cancel"]);
    expect(kept).toBe(1);
  });

  test("idle: all applicable actions render enabled with their testids", async () => {
    const actions: string[] = [];
    await render(
      <RunLifecycleActions resumable pausable cancellable busyAction={null} onAction={(kind) => actions.push(kind)} />,
    );
    const resume = byTestId("monitor-resume-run") as HTMLButtonElement;
    const pause = byTestId("monitor-pause-run") as HTMLButtonElement;
    const cancel = byTestId("monitor-cancel-run") as HTMLButtonElement;
    expect(resume.disabled).toBe(false);
    expect(pause.disabled).toBe(false);
    expect(cancel.disabled).toBe(false);
    expect(cancel.className).toContain("sui-button-destructive");
    await click(resume);
    await click(pause);
    await click(cancel);
    expect(actions).toEqual(["resume", "pause", "cancel"]);
  });

  test("disabled: a busy action freezes every lifecycle button", async () => {
    const actions: string[] = [];
    await render(
      <RunLifecycleActions resumable pausable cancellable busyAction="pause" onAction={(kind) => actions.push(kind)} />,
    );
    const pause = byTestId("monitor-pause-run") as HTMLButtonElement;
    expect(pause.textContent).toBe("Pausing…");
    for (const testId of ["monitor-resume-run", "monitor-pause-run", "monitor-cancel-run"]) {
      const button = byTestId(testId) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      await click(button);
    }
    expect(actions).toEqual([]);
  });

  test("hidden: inapplicable lifecycle actions do not render at all", async () => {
    await render(
      <RunLifecycleActions resumable={false} pausable={false} cancellable busyAction={null} onAction={() => {}} />,
    );
    expect(document.querySelector('[data-testid="monitor-resume-run"]')).toBeNull();
    expect(document.querySelector('[data-testid="monitor-pause-run"]')).toBeNull();
    expect(document.querySelector('[data-testid="monitor-cancel-run"]')).not.toBeNull();
  });
});

describe("RunLifecycleControls", () => {
  const controls = (runId: string, onAction: (kind: "cancel" | "resume" | "pause") => void) => (
    <RunLifecycleControls
      runId={runId}
      resumable={false}
      pausable={false}
      cancellable
      busyAction={null}
      onAction={onAction}
    />
  );

  test("mounts after a loading state without changing the host's hook order", async () => {
    const Host = ({ loaded }: { loaded: boolean }) =>
      loaded ? controls("run-a", () => {}) : <div data-testid="monitor-run-loading">Loading run…</div>;

    await render(<Host loaded={false} />);
    expect(byTestId("monitor-run-loading").textContent).toBe("Loading run…");
    await rerender(<Host loaded />);
    expect(byTestId("monitor-cancel-run")).toBeTruthy();
  });

  test("does not transfer an armed cancel confirmation between runs", async () => {
    const actions: string[] = [];
    const onAction = (kind: "cancel" | "resume" | "pause") => actions.push(kind);
    await render(controls("run-a", onAction));
    await click(byTestId("monitor-cancel-run"));
    expect(byTestId("monitor-confirm-cancel-run")).toBeTruthy();

    await rerender(controls("run-b", onAction));
    expect(document.querySelector('[data-testid="monitor-confirm-cancel-run"]')).toBeNull();
    await click(byTestId("monitor-cancel-run"));
    expect(actions).toEqual([]);
    await click(byTestId("monitor-confirm-cancel-run"));
    expect(actions).toEqual(["cancel"]);
  });
});

describe("unavailable run selections", () => {
  test("distinguishes loading, missing, and failed selections", async () => {
    const noOp = () => {};
    await render(<RunSelectionState runId="deep-link-42" loading onRetry={noOp} onReturnToRuns={noOp} />);
    expect(byTestId("monitor-run-loading").textContent).toContain("deep-link-42");
    expect(document.querySelector('[data-testid="monitor-run-return"]')).toBeNull();

    await rerender(<RunSelectionState runId="deep-link-42" loading={false} onRetry={noOp} onReturnToRuns={noOp} />);
    expect(byTestId("monitor-run-unavailable").textContent).toContain("Run unavailable");
    expect(byTestId("monitor-run-unavailable").textContent).toContain("deep-link-42");
    expect(byTestId("monitor-run-refresh")).toBeTruthy();
    expect(byTestId("monitor-run-return")).toBeTruthy();

    for (const error of [
      Object.assign(new Error("no run"), { code: "RunNotFound" }),
      Object.assign(new Error("no run"), { code: "NOT_FOUND", status: 404 }),
    ]) {
      await rerender(
        <RunSelectionState runId="deep-link-42" loading={false} error={error} onRetry={noOp} onReturnToRuns={noOp} />,
      );
      expect(byTestId("monitor-run-unavailable").textContent).toContain("Run unavailable");
    }

    await rerender(
      <RunSelectionState
        runId="deep-link-42"
        loading={false}
        error={new Error("gateway timed out")}
        onRetry={noOp}
        onReturnToRuns={noOp}
      />,
    );
    expect(byTestId("monitor-run-query-error").getAttribute("role")).toBe("alert");
    expect(byTestId("monitor-run-query-error").textContent).toContain("Couldn't load run");
    expect(byTestId("monitor-run-query-error").textContent).toContain("gateway timed out");
    expect(byTestId("monitor-run-retry")).toBeTruthy();
  });

  test("retries a failed selection and returns safely to the runs landing", async () => {
    let returns = 0;
    const RecoveryHarness = () => {
      const [recovered, setRecovered] = useState(false);
      return recovered ? (
        <div data-testid="monitor-run-recovered">Recovered run</div>
      ) : (
        <RunSelectionState
          runId="run-recover"
          loading={false}
          error={new Error("temporary failure")}
          onRetry={() => setRecovered(true)}
          onReturnToRuns={() => returns++}
        />
      );
    };

    await render(<RecoveryHarness />);
    await click(byTestId("monitor-run-return"));
    expect(returns).toBe(1);
    await click(byTestId("monitor-run-retry"));
    expect(byTestId("monitor-run-recovered").textContent).toBe("Recovered run");
  });
});

describe("Chip", () => {
  test("plain action chips carry no aria-pressed; disabled chips swallow clicks", async () => {
    let clicks = 0;
    await render(
      <div>
        <Chip data-testid="chip-live" onClick={() => clicks++}>
          Live
        </Chip>
        <Chip data-testid="chip-prev" disabled onClick={() => clicks++} aria-label="Previous frame">
          ◀
        </Chip>
      </div>,
    );
    const live = byTestId("chip-live");
    expect(live.getAttribute("aria-pressed")).toBeNull();
    expect(live.className).toContain("sui-button-sm");
    await click(live);
    expect(clicks).toBe(1);

    const prev = byTestId("chip-prev") as HTMLButtonElement;
    expect(prev.disabled).toBe(true);
    await click(prev);
    expect(clicks).toBe(1);
  });
});
