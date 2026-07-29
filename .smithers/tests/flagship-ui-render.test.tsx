/** @jsxImportSource react */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as gatewayReact from "@smithers-orchestrator/gateway-react";
import * as gatewayUi from "@smithers-orchestrator/gateway-ui";

GlobalRegistrator.register();
const reactTestEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousActEnvironment = reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT;
reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const run = { runId: "run-flagship", workflowKey: "review", status: "running" };
let mockedRun: typeof run | undefined = run;
let mockedEvents: unknown[] = [
  { payload: { event: "node.finished", payload: { nodeId: "ci-postgres:ready", iteration: 0 } } },
];
const output = {
  data: { row: { reviewer: "fixture reviewer", approved: true, feedback: "looks good", issues: [] } },
  refetch: async () => {},
};

mock.module("smithers-orchestrator/gateway-react", () => ({
  ...gatewayReact,
  createGatewayReactRoot: () => {},
  useGatewayActions: () => ({ launchRun: async () => run, cancelRun: async () => {} }),
  useGatewayNodeOutput: () => output,
  useGatewayRun: () => ({ data: mockedRun, refetch: async () => {} }),
  useGatewayRunEvents: () => ({ events: mockedEvents }),
  useGatewayRuns: () => ({ data: [run], refetch: async () => {} }),
}));

mock.module("smithers-orchestrator/gateway-ui", () => ({
  ...gatewayUi,
  NodeOutputView: ({ nodeId }: { nodeId?: string }) => <div data-testid="node-output">{nodeId}</div>,
  RunEventLog: () => <div data-testid="event-log" />,
  RunTree: ({ onSelectNode }: { onSelectNode?: (node: { id: string }) => void }) => (
    <button data-testid="run-tree" onClick={() => onSelectNode?.({ id: "ci-postgres:ready" })}>
      tree
    </button>
  ),
}));

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  mockedRun = run;
  mockedEvents = [{ payload: { event: "node.finished", payload: { nodeId: "ci-postgres:ready", iteration: 0 } } }];
  host = document.createElement("div");
  document.body.replaceChildren(host);
  root = createRoot(host);
});

afterEach(async () => await act(async () => root.unmount()));

afterAll(() => {
  if (previousActEnvironment === undefined) delete reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT;
  else reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  GlobalRegistrator.unregister();
});

describe("flagship pack UI composition", () => {
  test("normalizes review-since-publish durable and live event frames", async () => {
    const { reviewProgress } = await import("../ui/review-since-publish.tsx");
    expect(
      reviewProgress([
        { type: "event", event: "NodeFinished", payload: { nodeId: "merge" }, seq: 1 },
        {
          type: "event",
          event: "run.event",
          payload: { event: "node.finished", payload: { nodeId: "merge:1" } },
          seq: 2,
        },
        {
          type: "event",
          event: "run.event",
          payload: { event: "node.started", payload: { nodeId: "fix:lane-1" } },
          seq: 3,
        },
        { type: "event", event: "NodeFinished", payload: { nodeId: "fix:lane-2" }, seq: 4 },
      ]),
    ).toEqual({ rounds: 2, fixLanes: 2 });
  });

  test("renders the review dashboard through shared UI primitives", async () => {
    const { ReviewApp } = await import("../ui/review.tsx");
    await act(async () => root.render(<ReviewApp />));

    expect(host.querySelector('[data-testid="review-ui"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="review-verdict"]')?.textContent).toContain("synthesized verdict");
    expect(host.querySelector('[data-testid="review-reviewer-0"]')?.textContent).toContain("fixture reviewer");
    expect(host.querySelector('[data-testid="review-status"]')?.textContent).toContain("Running");
  });

  test("keyboard: Enter and Space toggle a focusable reviewer lane", async () => {
    const { ReviewApp } = await import("../ui/review.tsx");
    await act(async () => root.render(<ReviewApp />));
    const lane = host.querySelector<HTMLElement>('[data-testid="review-reviewer-0"]')!;

    expect(lane.tabIndex).toBe(0);
    expect(lane.getAttribute("role")).toBe("button");
    expect(lane.getAttribute("aria-expanded")).toBe("false");
    await act(async () => lane.focus());
    expect(document.activeElement).toBe(lane);

    await act(async () =>
      lane.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })),
    );
    expect(lane.getAttribute("aria-expanded")).toBe("true");

    await act(async () =>
      lane.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true })),
    );
    expect(lane.getAttribute("aria-expanded")).toBe("false");
  });

  test("renders issue-blitz live lane state with shared status components", async () => {
    const { IssueBlitzApp } = await import("../ui/issue-blitz.tsx");
    const runStatus = () => host.querySelector('[data-testid="issue-blitz-run-status"]');
    const isolatedStatus = () => host.querySelector('[data-testid="issue-blitz-isolated-status"]');

    mockedRun = undefined;
    mockedEvents = [];
    await act(async () => root.render(<IssueBlitzApp />));

    expect(host.querySelector('[data-testid="issue-blitz-ui"]')).not.toBeNull();
    expect(host.textContent).toContain("ci-postgres");
    expect(host.textContent).toContain("isolated worktrees");
    expect(host.querySelector('[data-testid="run-tree"]')).not.toBeNull();
    expect(runStatus()?.getAttribute("data-status")).toBe("unknown");
    expect(isolatedStatus()?.getAttribute("data-status")).toBe("pending");

    mockedRun = { ...run, status: "idle" };
    await act(async () => root.render(<IssueBlitzApp />));
    expect(runStatus()?.getAttribute("data-status")).toBe("idle");
    expect(isolatedStatus()?.getAttribute("data-status")).toBe("pending");

    mockedRun = run;
    mockedEvents = [{ payload: { event: "node.started", payload: { nodeId: "ci-postgres:implement", iteration: 0 } } }];
    await act(async () => root.render(<IssueBlitzApp />));
    expect(runStatus()?.getAttribute("data-status")).toBe("running");
    expect(isolatedStatus()?.getAttribute("data-status")).toBe("running");

    mockedRun = { ...run, status: "failed" };
    mockedEvents = [{ payload: { event: "node.failed", payload: { nodeId: "ci-postgres:implement", iteration: 0 } } }];
    await act(async () => root.render(<IssueBlitzApp />));
    expect(runStatus()?.getAttribute("data-status")).toBe("failed");
    expect(isolatedStatus()?.getAttribute("data-status")).toBe("pending");

    mockedRun = { ...run, status: "cancelled" };
    mockedEvents = [
      { payload: { event: "node.cancelled", payload: { nodeId: "ci-postgres:implement", iteration: 0 } } },
    ];
    await act(async () => root.render(<IssueBlitzApp />));
    expect(runStatus()?.getAttribute("data-status")).toBe("cancelled");
    expect(isolatedStatus()?.getAttribute("data-status")).toBe("pending");

    mockedRun = { ...run, status: "finished" };
    mockedEvents = [
      "ci-postgres",
      "e2e-orphans",
      "dual-react",
      "url-schemes",
      "pack-home",
      "pack-scan",
      "workflow-dirs",
      "dead-code",
      "mcp-confirm",
      "coerce-props",
      "audit-atomic",
    ].map((item) => ({ payload: { event: "node.finished", payload: { nodeId: `${item}:ready`, iteration: 0 } } }));
    await act(async () => root.render(<IssueBlitzApp />));
    expect(runStatus()?.getAttribute("data-status")).toBe("finished");
    expect(isolatedStatus()?.getAttribute("data-status")).toBe("done");
  });
});
