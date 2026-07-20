/** @jsxImportSource react */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const run = { runId: "run-flagship", workflowKey: "review", status: "running" };
const output = { data: { row: { reviewer: "fixture reviewer", approved: true, feedback: "looks good", issues: [] } }, refetch: async () => {} };

mock.module("smithers-orchestrator/gateway-react", () => ({
  createGatewayReactRoot: () => {},
  useGatewayActions: () => ({ launchRun: async () => run, cancelRun: async () => {} }),
  useGatewayNodeOutput: () => output,
  useGatewayRun: () => ({ data: run, refetch: async () => {} }),
  useGatewayRunEvents: () => ({ events: [{ payload: { event: "node.finished", payload: { nodeId: "ci-postgres:ready", iteration: 0 } } }] }),
  useGatewayRuns: () => ({ data: [run], refetch: async () => {} }),
}));

mock.module("smithers-orchestrator/gateway-ui", () => ({
  NodeOutputView: ({ nodeId }: { nodeId?: string }) => <div data-testid="node-output">{nodeId}</div>,
  RunEventLog: () => <div data-testid="event-log" />,
  RunTree: ({ onSelectNode }: { onSelectNode?: (node: { id: string }) => void }) => <button data-testid="run-tree" onClick={() => onSelectNode?.({ id: "ci-postgres:ready" })}>tree</button>,
}));

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.replaceChildren(host);
  root = createRoot(host);
});

afterEach(async () => await act(async () => root.unmount()));

afterAll(() => GlobalRegistrator.unregister());

describe("flagship pack UI composition", () => {
  test("renders the review dashboard through shared UI primitives", async () => {
    const { ReviewApp } = await import("../ui/review.tsx");
    await act(async () => root.render(<ReviewApp />));

    expect(host.querySelector('[data-testid="review-ui"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="review-verdict"]')?.textContent).toContain("synthesized verdict");
    expect(host.querySelector('[data-testid="review-reviewer-0"]')?.textContent).toContain("fixture reviewer");
    expect(host.querySelector('[data-testid="review-status"]')?.textContent).toContain("Running");
  });

  test("renders issue-blitz live lane state with shared status components", async () => {
    const { IssueBlitzApp } = await import("../ui/issue-blitz.tsx");
    await act(async () => root.render(<IssueBlitzApp />));

    expect(host.querySelector('[data-testid="issue-blitz-ui"]')).not.toBeNull();
    expect(host.textContent).toContain("ci-postgres");
    expect(host.textContent).toContain("isolated worktrees");
    expect(host.querySelector('[data-testid="run-tree"]')).not.toBeNull();
  });
});
