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
 * first and everything DOM-dependent is imported dynamically after it.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, describe, expect, test } from "bun:test";

// happy-dom replaces fetch with a node:http one; keep bun's native fetch so
// unrelated network-using tests in the same process stay on the real stack.
const nativeFetch = globalThis.fetch;
try {
  GlobalRegistrator.register();
} catch {
  /* already registered by another test file in this process */
}
globalThis.fetch = nativeFetch;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
type ReactElement = import("react").ReactElement;
type Root = import("react-dom/client").Root;
const { SMITHERS_UI_STYLE_ATTR, smithersUiCss } = await import("smithers-orchestrator/ui");
const { Chip, MonitorToolbar, RunLifecycleActions, RunRailRow, RunsPagination } = await import(
  "../src/monitor-ui/monitorShell.tsx"
);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | undefined;
let root: Root | undefined;

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
