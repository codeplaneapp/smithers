/** @jsxImportSource react */
/**
 * Monitor shell controls on the shared smithers-orchestrator/ui primitives
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
GlobalRegistrator.register();
globalThis.fetch = nativeFetch;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
type ReactElement = import("react").ReactElement;
type Root = import("react-dom/client").Root;
const { SMITHERS_UI_STYLE_ATTR, smithersUiCss } = await import("smithers-orchestrator/ui");
const { workflowUiThemeCss } = await import("smithers-orchestrator/gateway-ui");
const { Chip, MonitorToolbar, RunLifecycleActions, RunLifecycleControls, RunRailRow, RunsPagination } = await import(
  "../src/monitor-ui/monitorShell.tsx"
);
const { monitorCss, RunProgressCell, RunsRail, RunsTable, StatCard, StatusTag } = await import(
  "../src/monitor-ui/monitor.tsx"
);
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
    expect(document.querySelector('[data-status="running"]')?.className).toContain("tone-running");
    expect(document.querySelector('[data-status="waiting-approval"]')?.className).toContain("tone-waiting");
    expect(document.querySelector('[data-status="finished"]')?.className).toContain("tone-ok");
    expect(document.querySelector('[data-status="failed"]')?.className).toContain("tone-failed");
    expect(byTestId("monitor-stat-test").className).toContain("tone-waiting");
    expect(byTestId("monitor-stat-test").textContent).toContain("active runs");
    expect(byTestId("monitor-run-progress").textContent).toContain("4/5");
    expect(byTestId("monitor-run-progress").textContent).toContain("1 failed");
  });

  test("renders populated, loading, empty, offline, and unauthorized run-rail states", async () => {
    await render(
      <RunsRail runs={[run]} loading={false} connStatus="online" selectedRunId={run.runId} onSelect={() => {}} />,
    );
    expect(byTestId("monitor-runs")).toBeDefined();
    expect(byTestId("monitor-run-row").getAttribute("data-active")).toBe("true");
    expect(byTestId("monitor-run-row").textContent).toContain("rendered-coverage");

    await rerender(<RunsRail runs={[]} loading connStatus="connecting" selectedRunId={undefined} onSelect={() => {}} />);
    expect(byTestId("monitor-runs").textContent).toContain("Loading runs");
    await rerender(<RunsRail runs={[]} loading={false} connStatus="online" selectedRunId={undefined} onSelect={() => {}} />);
    expect(byTestId("monitor-empty").textContent).toContain("No runs match");
    await rerender(<RunsRail runs={[]} loading={false} connStatus="offline" selectedRunId={undefined} onSelect={() => {}} />);
    expect(byTestId("monitor-runs-offline").textContent?.toLowerCase()).toContain("gateway");
    await rerender(<RunsRail runs={[]} loading={false} connStatus="unauthorized" selectedRunId={undefined} onSelect={() => {}} />);
    expect(byTestId("monitor-runs-unauthorized").textContent?.toLowerCase()).toContain("credentials");
  });

  test("renders loading and empty table heroes plus a populated shared table panel", async () => {
    await render(<RunsTable runs={[]} loading page={1} onPageChange={() => {}} onSelect={() => {}} />);
    expect(byTestId("monitor-empty-detail").textContent).toContain("Loading runs");
    await rerender(<RunsTable runs={[]} loading={false} page={1} onPageChange={() => {}} onSelect={() => {}} />);
    expect(byTestId("monitor-empty-detail").textContent).toContain("No runs match");
    await rerender(<RunsTable runs={[run]} loading={false} page={1} onPageChange={() => {}} onSelect={() => {}} />);
    expect(byTestId("monitor-runs-table")).toBeDefined();
    expect(document.querySelector(".mon-panel.mon-runs-table-panel")).not.toBeNull();
    expect(byTestId("monitor-run-progress").textContent).toContain("1 failed");
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
      />,
    );

    const scrollport = document.querySelector<HTMLElement>(".mon-runs-scroll")!;
    expect(scrollport.tabIndex).toBe(0);
    expect(scrollport.getAttribute("role")).toBe("region");
    expect(scrollport.getAttribute("aria-label")).toBe("Runs table");

    const row = document.querySelector<HTMLElement>(".mon-runs-table-row")!;
    expect(row.tabIndex).toBe(0);
    expect(row.getAttribute("role")).toBe("button");
    await act(async () => row.focus());
    expect(document.activeElement).toBe(row);

    await keydown(row, "Enter");
    await keydown(row, " ");
    expect(selected).toEqual([run.runId, run.runId]);
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
      [".mon-pill", "var(--tone)"],
      [".mon-stat", "var(--surface)"],
      [".mon-banner", "var(--tone)"],
      [".mon-progress-fill", "var(--brand)"],
      [".mon-modal { width: min(1280px, 96vw)", "var(--surface)"],
      [".mon-empty", "var(--muted)"],
      [".mon-hijack-terminal", "var(--sp-2)"],
    ];
    for (const [selector, declaration] of rules) {
      const start = monitorCss.indexOf(selector);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(monitorCss.slice(start, start + 500)).toContain(declaration);
    }
    expect(monitorCss).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(monitorCss).not.toContain("background: white");
  });
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
      <RunsPagination page={1} pageCount={3} firstRow={1} lastRow={50} total={120} onPageChange={(page) => pages.push(page)} />,
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
      <RunsPagination page={3} pageCount={3} firstRow={101} lastRow={120} total={120} onPageChange={(page) => pages.push(page)} />,
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
    expect(el.className).toContain("sui-row-button");
    expect(el.getAttribute("data-slot")).toBe("row-button");
    expect(el.getAttribute("data-active")).toBe("true");
    expect(el.getAttribute("data-run-id")).toBe("run-42");
  });

  test("inactive rows drop data-active, stay focusable, and select on click", async () => {
    const selected: string[] = [];
    await render(row(false, (runId) => selected.push(runId)));
    const el = byTestId("monitor-run-row");
    expect(el.getAttribute("data-active")).toBeNull();
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
      <RunLifecycleActions
        resumable
        pausable
        cancellable
        busyAction={null}
        onAction={(kind) => actions.push(kind)}
      />,
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
      <RunLifecycleActions
        resumable
        pausable
        cancellable
        busyAction="pause"
        onAction={(kind) => actions.push(kind)}
      />,
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
