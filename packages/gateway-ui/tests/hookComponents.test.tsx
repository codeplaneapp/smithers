/** @jsxImportSource react */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Register a real DOM before react-dom/client is imported so useEffect/layout
// effects and event delegation actually run. Idempotent guard keeps this safe
// when another test file in the same bun process already registered.
//
// happy-dom installs a node:http-based `fetch` that can't read the gateway's
// streaming SSE response (throws HPE_UNEXPECTED_CONTENT_LENGTH). Bun's native
// fetch streams it fine, so capture it before registration and restore it after
// — we want the real DOM (events/effects) with the real streaming transport.
const nativeFetch = globalThis.fetch;
try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}
globalThis.fetch = nativeFetch;

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SmithersCollectionsProvider } from "@smithers-orchestrator/gateway-react";
import {
  ApprovalPanel,
  ConnectionBadge,
  LaunchButton,
  NodeOutputCard,
  NodeOutputView,
  RunEventLog,
  RunList,
  summarize,
  RunTree,
  SimpleWorkflowDashboard,
  WorkflowGraph,
  WorkflowPicker,
} from "../src/index.ts";
import { startInMemoryGateway, type InMemoryGateway, type SeedState } from "./inMemoryGateway.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Harness = {
  container: HTMLElement;
  render: (element: ReactElement) => Promise<void>;
  flush: (ms?: number) => Promise<void>;
  unmount: () => Promise<void>;
};

let gateway: InMemoryGateway | undefined;
const activeHarnesses: Harness[] = [];

async function mount(gw: InMemoryGateway, element: ReactElement): Promise<Harness> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
  });
  const wrapped = () =>
    createElement(SmithersCollectionsProvider, { mode: { kind: "local" as const, apiBaseUrl: gw.baseUrl } }, element);
  const harness: Harness = {
    container,
    render: async (next) => {
      await act(async () => {
        root.render(
          createElement(
            SmithersCollectionsProvider,
            { mode: { kind: "local" as const, apiBaseUrl: gw.baseUrl } },
            next,
          ),
        );
      });
      await harness.flush();
    },
    flush: async (ms = 20) => {
      await act(async () => {
        await sleep(ms);
      });
    },
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
  activeHarnesses.push(harness);
  await harness.render(element);
  void wrapped;
  return harness;
}

async function waitFor(harness: Harness, assertion: () => boolean, label: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (assertion()) return;
    await harness.flush(25);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

function click(el: Element | null) {
  if (!el) throw new Error("click: element not found");
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

// Drive a React-controlled text input's onChange. Setting `.value` directly
// updates React's value tracker so the synthetic onChange is suppressed; the
// reliable path in this happy-dom + React 19 env is: deliver `focusin` through
// React's delegation (start watching), set the value via the native prototype
// setter (bypasses the tracker so React sees a real change), then a `keyup`
// which makes React re-check and fire onChange.
function setInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  el.dispatchEvent(new Event("focusin", { bubbles: true }));
  const nativeSetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el) as object, "value")?.set;
  nativeSetter?.call(el, value);
  el.dispatchEvent(new Event("keyup", { bubbles: true }));
}

function changeSelect(el: HTMLSelectElement, value: string) {
  el.value = value;
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

afterEach(async () => {
  for (const harness of activeHarnesses.splice(0)) {
    await harness.unmount().catch(() => undefined);
  }
  if (gateway) {
    await gateway.close();
    gateway = undefined;
  }
  document.documentElement.removeAttribute("data-theme");
});

describe("WorkflowGraph theme", () => {
  test("updates its resolved mode when root data-theme changes", async () => {
    document.documentElement.setAttribute("data-theme", "light");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(createElement(WorkflowGraph, { spec: [] })));
      expect(container.querySelector(".smithers-graph")?.getAttribute("data-theme-mode")).toBe("light");

      await act(async () => {
        document.documentElement.setAttribute("data-theme", "dark");
        await sleep(20);
      });
      expect(container.querySelector(".smithers-graph")?.getAttribute("data-theme-mode")).toBe("dark");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});

function boot(seed: SeedState = {}): InMemoryGateway {
  gateway = startInMemoryGateway(seed);
  return gateway;
}

const SAMPLE_TREE = {
  root: {
    id: 1,
    name: "Workflow",
    type: "workflow",
    task: { nodeId: "root" },
    children: [
      { id: 2, name: "plan", type: "task", task: { nodeId: "plan", kind: "agent" } },
      {
        id: 3,
        name: "loop",
        type: "loop",
        task: { nodeId: "loop" },
        children: [
          { id: 4, name: "attempt", type: "task", task: { nodeId: "task", kind: "agent", iteration: 0 } },
          { id: 5, name: "attempt", type: "task", task: { nodeId: "task", kind: "agent", iteration: 1 } },
        ],
      },
    ],
  },
  runState: { state: "running", blocked: { nodeId: "plan" } },
};

describe("ConnectionBadge (live SSE)", () => {
  test("renders a connection status derived from the real stream", async () => {
    const gw = boot();
    const harness = await mount(gw, createElement(ConnectionBadge, { className: "chip" }));
    await waitFor(
      harness,
      () => harness.container.querySelector("[data-status]")?.getAttribute("data-status") === "online",
      "gateway stream to become online",
    );
    const badge = harness.container.querySelector("[data-status]");
    expect(badge).not.toBeNull();
    // The stream connects against the real gateway, so it reaches online.
    expect(badge?.getAttribute("data-status")).toBe("online");
    expect(badge?.textContent).toContain("Connected");
  });

  test("renders offline styling when the stream endpoint rejects", async () => {
    const gw = boot({ streamStatus: 500 });
    const harness = await mount(gw, createElement(ConnectionBadge, {}));
    await harness.flush(60);
    const badge = harness.container.querySelector("[data-status]");
    expect(badge).not.toBeNull();
    expect(["offline", "connecting", "idle"]).toContain(badge?.getAttribute("data-status"));
  });
});

describe("RunList", () => {
  test("lists runs, selects on click, and polls", async () => {
    const gw = boot({
      runs: [
        {
          runId: "run-a",
          workflowKey: "implement",
          status: "running",
          createdAtMs: Date.now(),
          startedBy: { harness: "codex", sessionId: "thread-1", detected: true },
        },
        { runId: "run-b", status: "ok" },
      ],
    });
    const selected: string[] = [];
    const harness = await mount(
      gw,
      createElement(RunList, {
        filter: { workflow: "implement", limit: 10 },
        activeRunId: "run-a",
        onSelect: (id: string) => selected.push(id),
        pollMs: 30,
      }),
    );
    await harness.flush(40);
    const buttons = harness.container.querySelectorAll("button");
    expect(buttons.length).toBe(2);
    expect(buttons[0]?.className).toContain("gw-run-row");
    expect(buttons[0]?.textContent).toContain("codex");
    expect(buttons[0]?.getAttribute("title")).toBeNull();
    expect(buttons[0]?.querySelector('[title*="thread-1"]')?.getAttribute("title")).toContain("auto-detected");
    // run-a has createdAtMs (shortTime present); run-b has none (shortTime "").
    click(buttons[1]);
    await harness.flush();
    expect(selected).toContain("run-b");
    // Let the poll interval fire at least once.
    await harness.flush(40);
  });

  test("shows the empty state when there are no runs and polling disabled", async () => {
    const gw = boot({ runs: [] });
    const harness = await mount(gw, createElement(RunList, { pollMs: 0 }));
    await harness.flush(40);
    expect(harness.container.textContent).toContain("No runs yet.");
  });

  test("renders the error banner when the runs hook reports an error", async () => {
    // The local gateway path never surfaces an error (useGatewayRuns pins
    // error: undefined), so drive the GatewayAsyncState error contract through
    // the injected hook seam with a real function — no mocks.
    const gw = boot({ runs: [] });
    const harness = await mount(
      gw,
      createElement(RunList, {
        pollMs: 0,
        useRuns: () => ({
          data: [],
          error: new Error("gateway unreachable"),
          loading: false,
          refetch: async () => {},
        }),
      }),
    );
    await harness.flush(20);
    expect(harness.container.textContent).toContain("gateway unreachable");
  });

  test("renders the fallback error text when the error has no message", async () => {
    const gw = boot({ runs: [] });
    const harness = await mount(
      gw,
      createElement(RunList, {
        pollMs: 0,
        useRuns: () => ({
          data: [],
          error: {} as Error,
          loading: false,
          refetch: async () => {},
        }),
      }),
    );
    await harness.flush(20);
    expect(harness.container.textContent).toContain("Failed to load runs.");
  });
});

describe("RunTree", () => {
  test("renders the node tree and selects a node on click", async () => {
    const gw = boot({ trees: { "run-a": SAMPLE_TREE } });
    const selectedNodes: string[] = [];
    const harness = await mount(
      gw,
      createElement(RunTree, {
        runId: "run-a",
        activeNodeId: "plan",
        onSelectNode: (node: { id: string }) => selectedNodes.push(node.id),
      }),
    );
    await harness.flush(50);
    const buttons = harness.container.querySelectorAll("button");
    expect(buttons.length).toBeGreaterThanOrEqual(4);
    expect(buttons[0]?.className).toContain("gw-node-row");
    click(buttons[0]);
    await harness.flush();
    expect(selectedNodes.length).toBeGreaterThan(0);
  });

  test("renders the empty prompt with no runId", async () => {
    const gw = boot();
    const harness = await mount(gw, createElement(RunTree, { runId: undefined }));
    await harness.flush(20);
    expect(harness.container.textContent).toContain("Select a run.");
  });

  test("degrades to an empty tree without crashing when the tree endpoint fails", async () => {
    const gw = boot({ failPaths: new Set(["/v1/api/runs/run-x/tree"]) });
    const harness = await mount(gw, createElement(RunTree, { runId: "run-x" }));
    await harness.flush(120);
    // The nodes collection swallows the initial-sync failure and resolves
    // ready-empty (useGatewayRunTree only reports `error` on a live-query error,
    // not an initial fetch rejection), so RunTree renders no node rows rather
    // than throwing. The container itself mounts.
    expect(harness.container.querySelector("div")).not.toBeNull();
    expect(harness.container.querySelectorAll("button").length).toBe(0);
  });
});

describe("NodeOutputView", () => {
  async function renderOutput(seedOutput: unknown, nodeId = "n1") {
    const gw = boot({ outputs: { [`run-a:${nodeId}`]: seedOutput } });
    const harness = await mount(gw, createElement(NodeOutputView, { runId: "run-a", nodeId, iteration: 0 }));
    await harness.flush(50);
    return harness;
  }

  test("no node selected", async () => {
    const gw = boot();
    const harness = await mount(gw, createElement(NodeOutputView, { runId: "run-a", nodeId: undefined }));
    await harness.flush(20);
    expect(harness.container.textContent).toContain("Select a node");
  });

  test("string output", async () => {
    const harness = await renderOutput("hello world");
    expect(harness.container.textContent).toContain("hello world");
  });

  test("produced envelope with row.output", async () => {
    const harness = await renderOutput({ status: "produced", row: { output: "the-output" } });
    expect(harness.container.textContent).toContain("the-output");
  });

  test("produced envelope with row.text", async () => {
    const harness = await renderOutput({ status: "produced", row: { text: "the-text" } });
    expect(harness.container.textContent).toContain("the-text");
  });

  test("renders recognizable agent rows through agentic components", async () => {
    const harness = await renderOutput({
      status: "produced",
      row: {
        text: "Final **answer**",
        reasoningSummary: "Inspect first",
        toolCalls: [{ toolName: "read", input: { path: "README.md" }, result: "ok" }],
      },
    });
    expect(harness.container.querySelector('[data-slot="agent-output"]')).not.toBeNull();
    expect(harness.container.querySelector('[data-slot="message-response"]')).not.toBeNull();
    expect(harness.container.querySelector('[data-slot="reasoning"]')).not.toBeNull();
    expect(harness.container.querySelector('[data-slot="tool-call"]')).not.toBeNull();
    expect(harness.container.querySelector('[data-slot="node-output-fallback"]')).toBeNull();
  });

  test("renders a nested streaming agent result through the parsed model", async () => {
    const harness = await renderOutput({
      status: "produced",
      row: {
        status: "running",
        output: {
          message: {
            content: [
              { type: "reasoning", summary: [{ type: "summary_text", text: "Inspect first" }] },
              { type: "tool-call", toolName: "read", input: { path: "README.md" } },
              { type: "text", text: "Final **answer**" },
            ],
          },
        },
      },
    });
    const output = harness.container.querySelector('[data-slot="agent-output"]');
    expect(output?.getAttribute("data-streaming")).toBe("true");
    expect(output?.querySelector('[data-slot="reasoning"]')).not.toBeNull();
    expect(output?.querySelector('[data-slot="tool-call"]')?.getAttribute("data-state")).toBe("closed");
    expect(output?.querySelector('[data-slot="message-response"]')).not.toBeNull();
  });

  test("clears the selected node's agent output while its replacement loads", async () => {
    const gw = boot({
      outputs: {
        "run-a:n1": { status: "produced", row: { text: "first node answer" } },
        "run-a:n2": { status: "produced", row: { text: "second node answer" } },
      },
      outputDelayMs: { "run-a:n2": 150 },
    });
    const harness = await mount(gw, createElement(NodeOutputView, { runId: "run-a", nodeId: "n1", iteration: 0 }));
    await waitFor(
      harness,
      () => harness.container.textContent?.includes("first node answer") ?? false,
      "first node output to load",
    );

    await harness.render(createElement(NodeOutputView, { runId: "run-a", nodeId: "n2", iteration: 0 }));
    expect(harness.container.textContent).toContain("Loading…");
    expect(harness.container.textContent).not.toContain("first node answer");
    expect(harness.container.querySelector('[data-slot="agent-output"]')).toBeNull();

    await waitFor(
      harness,
      () => harness.container.textContent?.includes("second node answer") ?? false,
      "replacement node output to load",
    );
  });

  test("produced envelope with an object row falls back to pretty JSON", async () => {
    const harness = await renderOutput({ status: "produced", row: { foo: 42 } });
    expect(harness.container.textContent).toContain("foo");
    expect(harness.container.querySelector('[data-slot="node-output-fallback"]')).not.toBeNull();
    expect(harness.container.querySelector('[data-slot="agent-output"]')).toBeNull();
  });

  test("produced envelope with a string row", async () => {
    const harness = await renderOutput({ status: "produced", row: "plain-string-row" });
    expect(harness.container.textContent).toContain("plain-string-row");
  });

  test("pending envelope", async () => {
    const harness = await renderOutput({ status: "pending" });
    expect(harness.container.textContent).toContain("not available yet");
  });

  test("failed envelope", async () => {
    const harness = await renderOutput({ status: "failed" });
    expect(harness.container.textContent).toContain("failed before producing");
  });

  test("bare object output pretty-prints", async () => {
    const harness = await renderOutput({ arbitrary: "data" });
    expect(harness.container.textContent).toContain("arbitrary");
  });

  test("null output renders the no-output fallback", async () => {
    const harness = await renderOutput(null);
    expect(harness.container.textContent).toContain("No output.");
  });

  test("produced envelope with a null row", async () => {
    const harness = await renderOutput({ status: "produced", row: null });
    expect(harness.container.textContent).toContain("No output.");
  });

  test("error state when the output endpoint fails", async () => {
    const gw = boot({ failPaths: new Set(["/v1/api/nodes/run-a/nboom/output"]) });
    const harness = await mount(gw, createElement(NodeOutputView, { runId: "run-a", nodeId: "nboom" }));
    await harness.flush(60);
    // GatewayRpcError surfaces the gateway's own error message.
    expect(harness.container.textContent).toContain("Forced failure");
  });
});

describe("NodeOutputCard", () => {
  // A fake node-output hook so pending/produced/failed chrome is driven
  // deterministically, matching RunList's injectable `useRuns` seam.
  const hookReturning = (data: unknown, extra: Record<string, unknown> = {}) =>
    (() => ({ data, error: undefined, loading: false, refetch: async () => {}, ...extra })) as never;

  test("pending → produced → failed chrome transitions", async () => {
    const gw = boot();
    const harness = await mount(
      gw,
      createElement(NodeOutputCard, {
        runId: "run-a",
        nodeId: "n1",
        useNodeOutput: hookReturning({ status: "pending" }),
      }),
    );
    await harness.flush(20);
    expect(harness.container.querySelector('[data-status="pending"]')).not.toBeNull();

    await harness.render(
      createElement(NodeOutputCard, {
        runId: "run-a",
        nodeId: "n1",
        useNodeOutput: hookReturning({ status: "produced", row: { output: "the-output" } }),
      }),
    );
    expect(harness.container.querySelector('[data-status="produced"]')).not.toBeNull();
    expect(harness.container.textContent).toContain("the-output");

    await harness.render(
      createElement(NodeOutputCard, {
        runId: "run-a",
        nodeId: "n1",
        useNodeOutput: hookReturning({ status: "failed" }),
      }),
    );
    expect(harness.container.querySelector('[data-status="failed"]')).not.toBeNull();
  });

  test("the render prop receives the unwrapped row object", async () => {
    const gw = boot();
    let received: unknown;
    const harness = await mount(
      gw,
      createElement(NodeOutputCard, {
        runId: "run-a",
        nodeId: "n1",
        useNodeOutput: hookReturning({ status: "produced", row: { foo: 42 } }),
        children: (row: unknown) => {
          received = row;
          return createElement("span", null, "custom body");
        },
      }),
    );
    await harness.flush(20);
    expect(received).toEqual({ foo: 42 });
    expect(harness.container.textContent).toContain("custom body");
  });

  test("renders default title/summary when no body is provided", async () => {
    const gw = boot();
    const harness = await mount(
      gw,
      createElement(NodeOutputCard, {
        runId: "run-a",
        nodeId: "plan-node",
        useNodeOutput: hookReturning({ status: "produced", row: { output: "the-body" } }),
      }),
    );
    await harness.flush(20);
    // Default title falls back to the nodeId; default summary is the status label;
    // the default body reuses NodeOutputView's formatOutput on the row.
    expect(harness.container.textContent).toContain("plan-node");
    expect(harness.container.textContent).toContain("Produced");
    expect(harness.container.textContent).toContain("the-body");
    expect(harness.container.querySelector('[data-slot="agent-output"]')).not.toBeNull();
  });

  test("keeps arbitrary default bodies on the JSON fallback", async () => {
    const gw = boot();
    const harness = await mount(
      gw,
      createElement(NodeOutputCard, {
        runId: "run-a",
        nodeId: "n1",
        useNodeOutput: hookReturning({ status: "produced", row: { count: 2 } }),
      }),
    );
    await harness.flush(20);
    expect(harness.container.querySelector('[data-slot="node-output-fallback"]')).not.toBeNull();
    expect(harness.container.querySelector('[data-slot="agent-output"]')).toBeNull();
  });

  test("surfaces the hook error as failed chrome", async () => {
    const gw = boot();
    const harness = await mount(
      gw,
      createElement(NodeOutputCard, {
        runId: "run-a",
        nodeId: "n1",
        useNodeOutput: hookReturning(undefined, { error: new Error("boom") }),
      }),
    );
    await harness.flush(20);
    expect(harness.container.querySelector('[data-status="failed"]')).not.toBeNull();
    expect(harness.container.textContent).toContain("boom");
  });

  test("reads live output through the real gateway hook", async () => {
    const gw = boot({ outputs: { "run-a:n1": { status: "produced", row: { output: "live-value" } } } });
    const harness = await mount(gw, createElement(NodeOutputCard, { runId: "run-a", nodeId: "n1", iteration: 0 }));
    await waitFor(
      harness,
      () => harness.container.textContent?.includes("live-value") ?? false,
      "live node output to load",
    );
    expect(harness.container.querySelector('[data-status="produced"]')).not.toBeNull();
  });

  test("clears the selected card's agent output while its replacement loads", async () => {
    const gw = boot({
      outputs: {
        "run-a:n1": { status: "produced", row: { text: "first card answer" } },
        "run-a:n2": { status: "produced", row: { text: "second card answer" } },
      },
      outputDelayMs: { "run-a:n2": 150 },
    });
    const harness = await mount(gw, createElement(NodeOutputCard, { runId: "run-a", nodeId: "n1", iteration: 0 }));
    await waitFor(
      harness,
      () => harness.container.textContent?.includes("first card answer") ?? false,
      "first card output to load",
    );

    await harness.render(createElement(NodeOutputCard, { runId: "run-a", nodeId: "n2", iteration: 0 }));
    expect(harness.container.querySelector('[data-status="pending"]')).not.toBeNull();
    expect(harness.container.textContent).toContain("Loading…");
    expect(harness.container.textContent).not.toContain("first card answer");
    expect(harness.container.querySelector('[data-slot="agent-output"]')).toBeNull();

    await waitFor(
      harness,
      () => harness.container.textContent?.includes("second card answer") ?? false,
      "replacement card output to load",
    );
  });
});

describe("LaunchButton", () => {
  test("launches and reports the new runId", async () => {
    const gw = boot();
    const launched: string[] = [];
    const harness = await mount(
      gw,
      createElement(LaunchButton, {
        workflow: "implement",
        input: { prompt: "go" },
        startedBy: { harness: "codex", sessionId: "thread-1" },
        onLaunched: (id: string) => launched.push(id),
      }),
    );
    await harness.flush(20);
    const button = harness.container.querySelector("button")!;
    expect(button.textContent).toContain("Launch implement");
    click(button);
    await harness.flush(60);
    expect(launched.length).toBe(1);
    expect(gw.launches[0]?.workflow).toBe("implement");
    expect(gw.launches[0]?.options).toEqual({ startedBy: { harness: "codex", sessionId: "thread-1" } });
  });

  test("renders custom children and reports launch errors", async () => {
    const gw = boot({ failPaths: new Set(["/v1/api/runs"]) });
    const errors: Error[] = [];
    const harness = await mount(
      gw,
      createElement(LaunchButton, { workflow: "broken", onError: (e: Error) => errors.push(e) }, "Go Now"),
    );
    await harness.flush(20);
    const button = harness.container.querySelector("button")!;
    expect(button.textContent).toContain("Go Now");
    click(button);
    await harness.flush(60);
    expect(errors.length).toBe(1);
  });
});

describe("WorkflowPicker", () => {
  test("lists workflows and reports selection", async () => {
    const gw = boot({
      workflows: [{ key: "implement", readableName: "Implement" }, { key: "review" }],
    });
    const chosen: string[] = [];
    const harness = await mount(
      gw,
      createElement(WorkflowPicker, { value: "implement", onChange: (k: string) => chosen.push(k), hasUiOnly: true }),
    );
    await harness.flush(40);
    const select = harness.container.querySelector("select")!;
    const options = select.querySelectorAll("option");
    // placeholder + 2 workflows
    expect(options.length).toBe(3);
    changeSelect(select, "review");
    await harness.flush();
    expect(chosen).toContain("review");
  });

  test("renders with no value and hasUiOnly false", async () => {
    const gw = boot({ workflows: [] });
    const harness = await mount(gw, createElement(WorkflowPicker, {}));
    await harness.flush(20);
    expect(harness.container.querySelector("select")).not.toBeNull();
  });
});

describe("ApprovalPanel", () => {
  test("lists pending approvals and approves one", async () => {
    const gw = boot({
      approvals: [
        {
          runId: "run-a",
          nodeId: "gate",
          iteration: 0,
          workflowKey: "implement",
          requestTitle: "Ship it?",
          requestSummary: "Deploy to prod",
        },
        { runId: "run-b", nodeId: "gate2", iteration: 1 },
      ],
    });
    const harness = await mount(gw, createElement(ApprovalPanel, { filter: { workflow: "implement" }, pollMs: 0 }));
    await harness.flush(50);
    expect(harness.container.textContent).toContain("Ship it?");
    // Second approval has no title/summary -> default title path.
    expect(harness.container.textContent).toContain("Approval: gate2");
    const approveButtons = [...harness.container.querySelectorAll("button")].filter((b) => b.textContent === "Approve");
    expect(approveButtons[0]?.className).toContain("gw-approval-button-success");
    click(approveButtons[0]);
    await waitFor(
      harness,
      () =>
        gw.approvalsSubmitted.length === 1 &&
        [...harness.container.querySelectorAll("button")].filter((button) => button.textContent === "Approve")
          .length === 1,
      "approved request removed",
    );
    expect(gw.approvalsSubmitted).toHaveLength(1);
    expect(
      [...harness.container.querySelectorAll("button")].filter((button) => button.textContent === "Approve"),
    ).toHaveLength(1);
    const status = harness.container.querySelector("[role='status']");
    expect(status?.textContent).toContain("Approved gate Ship it? for run run-a.");
    expect(status?.textContent).toContain("1 approval remains pending.");
  });

  test("confirms denial with gate and run context while preserving the optional note", async () => {
    const gw = boot({
      approvals: [{ runId: "run-c", nodeId: "gate", iteration: 0 }],
    });
    const harness = await mount(gw, createElement(ApprovalPanel, { pollMs: 0 }));
    await harness.flush(50);
    const note = harness.container.querySelector<HTMLTextAreaElement>("textarea")!;
    setInputValue(note, "not safe yet");
    const denyButtons = [...harness.container.querySelectorAll("button")].filter((b) => b.textContent === "Deny");
    click(denyButtons[0]);
    await harness.flush();
    const confirmation = harness.container.querySelector("[role='alertdialog']");
    expect(confirmation?.textContent).toContain("gate");
    expect(confirmation?.textContent).toContain("run-c");
    expect((document.activeElement as HTMLElement | null)?.textContent).toBe("Confirm deny");
    expect(gw.approvalsSubmitted).toHaveLength(0);

    await act(async () => {
      confirmation!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(harness.container.querySelector("[role='alertdialog']")).toBeNull();
    expect(note.value).toBe("not safe yet");
    expect(gw.approvalsSubmitted).toHaveLength(0);
    expect((document.activeElement as HTMLElement | null)?.textContent).toBe("Deny");

    click([...harness.container.querySelectorAll("button")].find((button) => button.textContent === "Deny")!);
    await harness.flush();
    click([...harness.container.querySelectorAll("button")].find((button) => button.textContent === "Confirm deny")!);
    await harness.flush(60);
    expect(gw.approvalsSubmitted[0]).toMatchObject({
      decision: { approved: false, note: "not safe yet" },
      note: "not safe yet",
    });
    expect(harness.container.querySelector("[role='status']")?.textContent).toContain(
      "Denied gate gate for run run-c. 0 approvals remain pending.",
    );
  });

  test("disables a pending row and ignores duplicate decision clicks", async () => {
    const gw = boot({
      approvals: [{ runId: "run-c", nodeId: "gate", iteration: 0 }],
      deferApprovalSubmit: true,
    });
    const harness = await mount(gw, createElement(ApprovalPanel, { pollMs: 0 }));
    await harness.flush(50);
    const approve = [...harness.container.querySelectorAll("button")].find(
      (button) => button.textContent === "Approve",
    )!;
    click(approve);
    click(approve);
    await harness.flush();
    expect(approve.disabled).toBe(true);
    expect(harness.container.querySelector<HTMLTextAreaElement>("textarea")!.disabled).toBe(true);

    gw.releaseApprovalSubmits();
    await waitFor(harness, () => gw.approvalsSubmitted.length === 1, "single approval submitted");
    await harness.flush(50);
    expect(gw.approvalsSubmitted).toHaveLength(1);
  });

  test("shows the empty state", async () => {
    const gw = boot({ approvals: [] });
    const harness = await mount(gw, createElement(ApprovalPanel, {}));
    await harness.flush(40);
    expect(harness.container.textContent).toContain("No approvals waiting.");
  });

  test("surfaces the actionable gateway rejection, retains the request, and retries", async () => {
    const gw = boot({
      approvals: [{ runId: "run-c", nodeId: "gate", iteration: 0 }],
      failApprovalSubmit: true,
    });
    const harness = await mount(gw, createElement(ApprovalPanel, { pollMs: 0 }));
    await harness.flush(50);
    const approveButtons = [...harness.container.querySelectorAll("button")].filter((b) => b.textContent === "Approve");
    click(approveButtons[0]);
    await waitFor(
      harness,
      () => harness.container.querySelector("[role='alert']")?.textContent?.includes("Forced failure") === true,
      "gateway rejection shown",
    );
    const alert = harness.container.querySelector("[role='alert']");
    expect(alert?.textContent).toContain("Approve failed for gate gate on run run-c");
    expect(alert?.textContent).toContain("Forced failure for approval submit");
    expect(alert?.textContent).toContain("Try again");
    expect(harness.container.textContent).toContain("Approval: gate");
    const stillApprove = [...harness.container.querySelectorAll("button")].filter((b) => b.textContent === "Approve");
    expect((stillApprove[0] as HTMLButtonElement).disabled).toBe(false);
    expect(document.activeElement).toBe(stillApprove[0]);

    gw.state.failApprovalSubmit = false;
    click(stillApprove[0]);
    await waitFor(
      harness,
      () => gw.approvalsSubmitted.length === 1 && !harness.container.textContent!.includes("Approval: gate"),
      "retry accepted",
    );
    expect(gw.approvalsSubmitted).toHaveLength(1);
    expect(harness.container.textContent).not.toContain("Approval: gate");
    expect(harness.container.querySelector("[role='status']")?.textContent).toContain(
      "Approved gate gate for run run-c.",
    );
  });

  test("reports a post-decision refresh failure without exposing a duplicate retry", async () => {
    const gw = boot({
      approvals: [{ runId: "run-c", nodeId: "gate", iteration: 0 }],
      failApprovalRefreshAfterSubmit: true,
    });
    const errors: Error[] = [];
    const harness = await mount(
      gw,
      createElement(ApprovalPanel, { pollMs: 0, onError: (error: Error) => errors.push(error) }),
    );
    await harness.flush(50);
    click([...harness.container.querySelectorAll("button")].find((button) => button.textContent === "Approve")!);
    await waitFor(
      harness,
      () =>
        harness.container
          .querySelector("[role='alert']")
          ?.textContent?.includes("Approval accepted, but refreshing the pending list failed") === true,
      "post-decision refresh failure shown",
    );
    expect(gw.approvalsSubmitted).toHaveLength(1);

    const status = harness.container.querySelector("[role='status']");
    expect(status?.textContent).toContain("Approved gate gate for run run-c.");
    expect(status?.textContent).toContain("0 approvals remain pending.");
    const alert = harness.container.querySelector("[role='alert']");
    expect(alert?.textContent).toContain("pending approvals could not be refreshed");
    expect(alert?.textContent).toContain("Approval accepted, but refreshing the pending list failed");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("Approval accepted, but refreshing the pending list failed");
    expect(harness.container.querySelector("[data-approval-deny-confirmation]")).toBeNull();
    expect([...harness.container.querySelectorAll("button")].some((button) => button.textContent === "Approve")).toBe(
      false,
    );
  });

  test("calls onError when submitApproval rejects", async () => {
    const gw = boot({
      approvals: [{ runId: "run-c", nodeId: "gate", iteration: 0 }],
      failApprovalSubmit: true,
    });
    const errors: Error[] = [];
    const harness = await mount(gw, createElement(ApprovalPanel, { pollMs: 0, onError: (e: Error) => errors.push(e) }));
    await harness.flush(50);
    const approveButtons = [...harness.container.querySelectorAll("button")].filter((b) => b.textContent === "Approve");
    click(approveButtons[0]);
    await harness.flush(60);
    expect(errors.length).toBe(1);
    expect(errors[0]).toBeInstanceOf(Error);
  });
});

describe("RunEventLog", () => {
  test("streams events with varied payloads and follows the tail", async () => {
    const gw = boot({
      events: {
        "run-a": [
          { runId: "run-a", seq: 0, event: "run.started", payload: "a string payload" },
          { runId: "run-a", seq: 1, event: "node.ok", payload: { small: true } },
          { runId: "run-a", seq: 2, event: "node.big", payload: { big: "x".repeat(500) } },
          { runId: "run-a", seq: 3, event: "node.null", payload: null },
          { runId: "run-a", seq: 4, event: "run.heartbeat", payload: { hb: 1 } },
        ],
      },
    });
    const harness = await mount(gw, createElement(RunEventLog, { runId: "run-a", maxEvents: 100, follow: true }));
    await harness.flush(60);
    // Structured rows (a kind badge + zero-padded seq), not raw JSON lines. The
    // RunEventLog opts into heartbeat delivery, so all 5 frames remain.
    const rows = harness.container.querySelectorAll('[data-slot="event-row"]');
    expect(rows.length).toBe(5);
    expect(harness.container.textContent).toContain("run.started");
    expect(harness.container.textContent).toContain("0000");
    // The full payload is collapsed; expand the first row's JSON toggle to see it.
    const toggle = rows[0]!.querySelector(".gw-event-row-toggle") as HTMLButtonElement;
    click(toggle);
    await harness.flush();
    expect(rows[0]!.querySelector('[data-slot="event-json"]')?.textContent).toContain("a string payload");
  });

  test("renders the select-a-run prompt with no runId", async () => {
    const gw = boot();
    const harness = await mount(gw, createElement(RunEventLog, { runId: undefined, follow: false }));
    await harness.flush(20);
    expect(harness.container.textContent).toContain("Select a run to stream");
  });

  test("coalesces consecutive per-node heartbeats and toggles to show them all", async () => {
    const gw = boot({
      events: {
        "run-a": [
          { runId: "run-a", seq: 1, event: "NodeStarted", payload: { type: "NodeStarted", nodeId: "build" } },
          { runId: "run-a", seq: 2, event: "TaskHeartbeat", payload: { type: "TaskHeartbeat", nodeId: "build" } },
          { runId: "run-a", seq: 3, event: "TaskHeartbeat", payload: { type: "TaskHeartbeat", nodeId: "build" } },
          { runId: "run-a", seq: 4, event: "TaskHeartbeat", payload: { type: "TaskHeartbeat", nodeId: "build" } },
          { runId: "run-a", seq: 5, event: "NodeFinished", payload: { type: "NodeFinished", nodeId: "build" } },
        ],
      },
    });
    const harness = await mount(gw, createElement(RunEventLog, { runId: "run-a" }));
    await harness.flush(60);
    // 5 frames fold to 3 rows: started, one coalesced heartbeat (×3), finished.
    let rows = harness.container.querySelectorAll('[data-slot="event-row"]');
    expect(rows.length).toBe(3);
    const hb = harness.container.querySelector('[data-slot="event-row"][data-heartbeat="true"]');
    expect(hb).not.toBeNull();
    expect(hb?.textContent).toContain("×3");
    expect(harness.container.textContent).toContain("build finished");

    // The toolbar toggle expands every heartbeat into its own row.
    const toggle = [...harness.container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Show all heartbeats"),
    )!;
    expect(toggle).toBeDefined();
    click(toggle);
    await harness.flush(20);
    rows = harness.container.querySelectorAll('[data-slot="event-row"]');
    expect(rows.length).toBe(5);
    expect(
      [...harness.container.querySelectorAll("button")].some((b) => b.textContent?.includes("Coalesce heartbeats")),
    ).toBe(true);
  });

  test("syncs heartbeat visibility when showAllHeartbeats changes", async () => {
    const gw = boot({
      events: {
        "run-a": [
          { runId: "run-a", seq: 1, event: "TaskHeartbeat", payload: { nodeId: "build" } },
          { runId: "run-a", seq: 2, event: "TaskHeartbeat", payload: { nodeId: "build" } },
        ],
      },
    });
    const harness = await mount(gw, createElement(RunEventLog, { runId: "run-a", showAllHeartbeats: false }));
    await harness.flush(40);
    expect(harness.container.querySelectorAll('[data-slot="event-row"]').length).toBe(1);

    await harness.render(createElement(RunEventLog, { runId: "run-a", showAllHeartbeats: true }));
    expect(harness.container.querySelectorAll('[data-slot="event-row"]').length).toBe(2);

    await harness.render(createElement(RunEventLog, { runId: "run-a", showAllHeartbeats: false }));
    expect(harness.container.querySelectorAll('[data-slot="event-row"]').length).toBe(1);
  });

  test("makes a failed node visually prominent with an error summary", async () => {
    const gw = boot({
      events: {
        "run-a": [
          {
            runId: "run-a",
            seq: 7,
            event: "NodeFailed",
            payload: { type: "NodeFailed", nodeId: "flaky", error: "boom happened" },
          },
        ],
      },
    });
    const harness = await mount(gw, createElement(RunEventLog, { runId: "run-a" }));
    await harness.flush(40);
    const failed = harness.container.querySelector('[data-slot="event-row"][data-tone="failed"]');
    expect(failed).not.toBeNull();
    expect(failed?.getAttribute("data-node")).toBe("flaky");
    expect(failed?.textContent).toContain("flaky failed: boom happened");
  });

  test("selects a node when a node-bearing row is clicked and highlights the active node", async () => {
    const gw = boot({
      events: {
        "run-a": [{ runId: "run-a", seq: 1, event: "NodeStarted", payload: { type: "NodeStarted", nodeId: "plan" } }],
      },
    });
    const selected: string[] = [];
    const harness = await mount(
      gw,
      createElement(RunEventLog, {
        runId: "run-a",
        selectedNodeId: "plan",
        onSelectNode: (id: string) => selected.push(id),
      }),
    );
    await harness.flush(40);
    const row = harness.container.querySelector('[data-slot="event-row"][data-node="plan"]');
    expect(row?.getAttribute("data-active")).toBe("true");
    const main = row!.querySelector(".gw-event-row-main") as HTMLButtonElement;
    expect(main.getAttribute("data-selectable")).toBe("true");
    click(main);
    await harness.flush();
    expect(selected).toContain("plan");
  });

  test("keeps inert row mains out of the tab order while retaining payload toggles", async () => {
    const gw = boot({
      events: {
        "run-a": [
          { runId: "run-a", seq: 1, event: "run.started", payload: {} },
          { runId: "run-a", seq: 2, event: "NodeStarted", payload: { nodeId: "plan" } },
        ],
      },
    });
    const harness = await mount(gw, createElement(RunEventLog, { runId: "run-a" }));
    await harness.flush(40);
    const rows = [...harness.container.querySelectorAll('[data-slot="event-row"]')];
    expect(rows[0]!.querySelector(".gw-event-row-main").tagName).toBe("DIV");
    expect(rows[0]!.querySelector(".gw-event-row-main")?.getAttribute("data-selectable")).toBe("false");
    expect(rows[1]!.querySelector(".gw-event-row-main").tagName).toBe("DIV");
    expect(harness.container.querySelectorAll(".gw-event-row-toggle").length).toBe(2);
  });

  test("distinguishes an initial event load from a loaded empty stream", async () => {
    const gw = boot({ events: { "run-empty": [] } });
    const originalFetch = globalThis.fetch;
    let releaseEvents!: () => void;
    const eventRequestReleased = new Promise<void>((resolve) => {
      releaseEvents = resolve;
    });
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      const input = args[0];
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (new URL(url).pathname === "/v1/api/events") await eventRequestReleased;
      return originalFetch(...args);
    }) as typeof fetch;

    try {
      const harness = await mount(gw, createElement(RunEventLog, { runId: "run-empty" }));
      expect(harness.container.textContent).toContain("Loading events…");
      expect(harness.container.textContent).not.toContain("Waiting for events…");
      expect(harness.container.textContent).not.toContain("No events.");

      await act(async () => {
        releaseEvents();
        await sleep(40);
      });
      expect(harness.container.textContent).not.toContain("Loading events…");
      expect(harness.container.textContent).toContain("Waiting for events…");
    } finally {
      releaseEvents();
      globalThis.fetch = originalFetch;
    }
  });

  test("surfaces a stream error when the connection is unauthorized", async () => {
    const gw = boot({ streamStatus: 401, events: { "run-a": [] } });
    const harness = await mount(gw, createElement(RunEventLog, { runId: "run-a" }));
    await harness.flush(80);
    expect(harness.container.textContent).toContain("Event stream failed");
    expect(harness.container.textContent).toContain("Run event stream failed.");
    expect(harness.container.querySelector('[data-slot="event-row"]')).toBeNull();
  });

  test("keeps buffered events visible with a dismissible stream error banner", async () => {
    const gw = boot({
      events: {
        "run-a": [{ runId: "run-a", seq: 1, event: "NodeStarted", payload: { nodeId: "plan" } }],
      },
    });
    const harness = await mount(gw, createElement(RunEventLog, { runId: "run-a" }));
    await harness.flush(60);
    const row = harness.container.querySelector('[data-slot="event-row"]');
    expect(row).not.toBeNull();

    await act(async () => {
      await gw.close();
    });
    await harness.flush(80);

    expect(harness.container.querySelector('[data-slot="event-row"]')).toBe(row);
    expect(harness.container.textContent).toContain("NodeStarted");
    expect(harness.container.querySelector('[data-slot="run-event-log-error"][role="alert"]')).not.toBeNull();

    click(harness.container.querySelector('[aria-label="Dismiss event stream error"]'));
    await harness.flush();
    expect(harness.container.querySelector('[data-slot="run-event-log-error"]')).toBeNull();
    expect(harness.container.querySelector('[data-slot="event-row"]')).not.toBeNull();
  });

  test("keeps following the tail once the event buffer hits maxEvents", async () => {
    const seed = Array.from({ length: 5 }, (_, i) => ({
      runId: "run-a",
      seq: i + 1,
      event: `node.step-${i + 1}`,
      payload: { i },
    }));
    const gw = boot({ events: { "run-a": seed } });
    const scrollSpy = spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    try {
      const harness = await mount(gw, createElement(RunEventLog, { runId: "run-a", maxEvents: 5, follow: true }));
      await harness.flush(60);
      const callsBeforePush = scrollSpy.mock.calls.length;
      expect(callsBeforePush).toBeGreaterThan(0);

      gw.pushEvents("run-a", [
        { runId: "run-a", seq: 6, event: "node.step-6", payload: { i: 5 } },
        { runId: "run-a", seq: 7, event: "node.step-7", payload: { i: 6 } },
        { runId: "run-a", seq: 8, event: "node.step-8", payload: { i: 7 } },
      ]);
      await harness.flush(60);

      // The buffer stays capped at maxEvents, so events.length never changes,
      // yet the newest frame keeps replacing the oldest — follow must still fire.
      expect(harness.container.textContent).toContain("node.step-8");
      expect(harness.container.textContent).not.toContain("node.step-1");
      expect(scrollSpy.mock.calls.length).toBeGreaterThan(callsBeforePush);
    } finally {
      scrollSpy.mockRestore();
    }
  });
});

describe("summarize", () => {
  const reference = (payload: unknown): string => {
    if (payload == null) return "";
    if (typeof payload === "string") return payload;
    try {
      const json = JSON.stringify(payload);
      return json.length > 200 ? `${json.slice(0, 200)}…` : json;
    } catch {
      return "";
    }
  };

  test("matches JSON.stringify+slice for a spread of payload shapes", () => {
    const payloads: unknown[] = [
      null,
      undefined,
      "",
      "a plain string payload",
      42,
      true,
      { small: true },
      { nested: { deep: [1, "two", null, { ok: false }] } },
      [1, undefined, "x"],
      { "esc\"aped": "uni snowman ☃\nnewline" },
      { when: new Date("2024-01-02T03:04:05.000Z") },
      { skip: undefined, fn: () => 1, keep: 1 },
      { big: "x".repeat(500) },
      { exact: "y".repeat(190) },
      Number.NaN,
      { cycle: null as unknown },
    ];
    (payloads[payloads.length - 1] as { cycle: unknown }).cycle = payloads[payloads.length - 1];
    for (const payload of payloads) {
      expect(summarize(payload)).toBe(reference(payload));
    }
  });

  test("truncates a large payload without serializing past the preview budget", () => {
    // A throwing getter positioned after the first 200 serialized characters:
    // a full JSON.stringify would invoke it and throw (old behavior returned
    // ""), while the bounded preview never reaches it.
    const payload = {
      head: "x".repeat(500),
      get tail(): never {
        throw new Error("serialized past the preview budget");
      },
    };
    const expected = `${JSON.stringify({ head: "x".repeat(500) }).slice(0, 200)}…`;
    expect(summarize(payload)).toBe(expected);
  });

  test("returns an empty string for circular payloads", () => {
    const payload: { self?: unknown } = {};
    payload.self = payload;
    expect(summarize(payload)).toBe("");
  });
});

describe("SimpleWorkflowDashboard", () => {
  test("renders runs, starts a run, and selects rows", async () => {
    const gw = boot({
      runs: [
        { runId: "run-aaaaaa11", workflowKey: "implement", status: "running", createdAtMs: Date.now() },
        { runId: "run-bbbbbb22", workflowKey: "implement", status: "ok" },
      ],
      trees: { "run-aaaaaa11": SAMPLE_TREE },
      events: { "run-aaaaaa11": [{ runId: "run-aaaaaa11", seq: 1, event: "run.started", payload: "hi" }] },
    });
    const harness = await mount(
      gw,
      createElement(SimpleWorkflowDashboard, {
        workflow: "implement",
        title: "Implement",
        testId: "dash",
        runLimit: 10,
      }),
    );
    await harness.flush(80);
    expect(harness.container.querySelector('[data-testid="dash"]')).not.toBeNull();
    expect(harness.container.textContent).toContain("run-bbbb");

    // Type a prompt and start a run. The typed prompt must reach the launch
    // input, which proves the controlled-input onChange fired.
    const input = harness.container.querySelector("input.input") as HTMLInputElement;
    setInputValue(input, "do the thing");
    await harness.flush();
    const startButton = [...harness.container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Start"),
    )!;
    click(startButton);
    await harness.flush(80);
    const launch = gw.launches.find((l) => l.workflow === "implement");
    expect(launch).toBeDefined();
    expect((launch?.input as { prompt?: string })?.prompt).toBe("do the thing");

    // Select the second run row.
    const runRow = [...harness.container.querySelectorAll("button")].find((b) => b.textContent?.includes("run-bbbb"));
    if (runRow) {
      click(runRow);
      await harness.flush(40);
    }
  });

  test("keeps the just-launched run selected while the runs collection catches up", async () => {
    // The run list only refreshes on the gateway's async re-pull, so a run
    // launched here is selected while still absent from `runs` — the window in
    // which the auto-select reconcile used to snap back to the previous run.
    const gw = boot({
      runsDelayMs: 250,
      runs: [{ runId: "run-old00001", workflowKey: "implement", status: "running", createdAtMs: Date.now() }],
    });
    const harness = await mount(gw, createElement(SimpleWorkflowDashboard, { workflow: "implement", testId: "dash" }));
    const rowFor = (runId: string) =>
      [...harness.container.querySelectorAll("button.workflow-run-row")].find((row) =>
        row.textContent?.includes(runId.slice(0, 8)),
      );
    await waitFor(
      harness,
      () => rowFor("run-old00001")?.getAttribute("aria-pressed") === "true",
      "existing run auto-selected",
    );

    click([...harness.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Start"))!);
    // Commit the launch's selection while the run list is still stale...
    await harness.flush(40);
    const launchedRunId = gw.state.runs[0]!.runId as string;
    expect(launchedRunId).not.toBe("run-old00001");
    expect(rowFor(launchedRunId)).toBeUndefined();
    expect(harness.container.querySelector('[aria-label="Run detail"] .mono')?.textContent).toBe(
      launchedRunId.slice(0, 8),
    );

    // ...then let the re-pull land it. The launched run stays selected.
    await waitFor(harness, () => rowFor(launchedRunId) !== undefined, "launched run row");
    expect(rowFor(launchedRunId)?.getAttribute("aria-pressed")).toBe("true");
    expect(rowFor("run-old00001")?.getAttribute("aria-pressed")).toBe("false");
  });

  test("renders the empty state and reports a launch error", async () => {
    const gw = boot({ runs: [], failPaths: new Set(["/v1/api/runs"]) });
    const harness = await mount(
      gw,
      createElement(SimpleWorkflowDashboard, {
        workflow: "implement",
        promptPlaceholder: "prompt here",
        initialPrompt: "seed",
        inputFromPrompt: (prompt: string) => ({ text: prompt }),
      }),
    );
    await harness.flush(60);
    expect(harness.container.textContent).toContain("No runs yet.");
    const startButton = [...harness.container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Start"),
    )!;
    click(startButton);
    await harness.flush(80);
    expect(harness.container.querySelector(".alert.err")).not.toBeNull();
  });
});
