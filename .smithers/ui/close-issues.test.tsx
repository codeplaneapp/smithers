/** @jsxImportSource react */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as gatewayReact from "@smthrs/gateway-react";

GlobalRegistrator.register();
const reactTestEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousActEnvironment = reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT;
reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

let mockedApprovals: unknown[] = [];
let mockedEvents: unknown[] = [];
let mockedDiscoverOutput: unknown;

mock.module("smthrs/gateway-react", () => ({
  ...gatewayReact,
  createGatewayReactRoot: () => {},
  useGatewayActions: () => ({
    launchRun: async () => ({ runId: "run-ci-test" }),
    submitApproval: async () => {},
    cancelRun: async () => {},
  }),
  useGatewayRuns: () => ({
    data: [{ runId: "run-ci-test", workflowKey: "close-issues", status: "waiting-approval" }],
    refetch: async () => {},
  }),
  useGatewayRun: () => ({ data: { runId: "run-ci-test", status: "waiting-approval" }, refetch: async () => {} }),
  useGatewayRunEvents: () => ({ events: mockedEvents, refetch: async () => {} }),
  useGatewayApprovals: () => ({ data: mockedApprovals, refetch: async () => {} }),
  useGatewayNodeOutput: () => ({ data: mockedDiscoverOutput, refetch: async () => {} }),
}));

const { App } = await import("./close-issues");

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  mockedApprovals = [];
  mockedEvents = [];
  mockedDiscoverOutput = undefined;
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

describe("close-issues approval gate", () => {
  test("renders the flat requestTitle/requestSummary from GatewayApprovalSummary", async () => {
    mockedApprovals = [
      {
        runId: "run-ci-test",
        nodeId: "approve-landing",
        iteration: 0,
        requestTitle: "Land 3 prepared PRs?",
        requestSummary: "PR #41, #42, #43 are green and ready to merge.",
      },
    ];
    await act(async () => root.render(<App />));

    const gate = host.querySelector('[data-testid="approval-gate"]');
    expect(gate).not.toBeNull();
    expect(host.textContent).toContain("Land 3 prepared PRs?");
    expect(host.textContent).toContain("PR #41, #42, #43 are green and ready to merge.");
    expect(host.textContent).not.toContain("Approval required — land these fixes to main?");
    expect(host.textContent).not.toContain("Review the prepared PRs, then approve to start the merge queue.");
  });

  test("falls back to generic copy when the approval row has no summary", async () => {
    mockedApprovals = [{ runId: "run-ci-test", nodeId: "approve-landing", iteration: 0 }];
    await act(async () => root.render(<App />));

    expect(host.querySelector('[data-testid="approval-gate"]')).not.toBeNull();
    expect(host.textContent).toContain("Approval required — land these fixes to main?");
    expect(host.textContent).toContain("Review the prepared PRs, then approve to start the merge queue.");
  });

  test("ignores approvals for other nodes", async () => {
    mockedApprovals = [
      {
        runId: "run-ci-test",
        nodeId: "some-other-gate",
        iteration: 0,
        requestTitle: "Unrelated gate",
        requestSummary: "Should not render.",
      },
    ];
    await act(async () => root.render(<App />));

    expect(host.querySelector('[data-testid="approval-gate"]')).toBeNull();
    expect(host.textContent).not.toContain("Unrelated gate");
  });

  test("derives issue phases and merged progress from durable run-event frames", async () => {
    mockedDiscoverOutput = {
      row: { issues: [{ number: 41, title: "Fix event decoding" }], summary: "One issue found." },
    };
    mockedEvents = [
      {
        type: "event",
        event: "NodeStarted",
        payload: { runId: "run-ci-test", nodeId: "issue-41-implement" },
        seq: 1,
      },
      {
        type: "event",
        event: "NodeFinished",
        payload: { runId: "run-ci-test", nodeId: "merge-41" },
        seq: 2,
      },
    ];

    await act(async () => root.render(<App />));

    expect(host.querySelector('[data-testid="issue-41-implement"]')?.getAttribute("data-status")).toBe("running");
    expect(host.querySelector('[data-testid="issue-41-merge"]')?.getAttribute("data-status")).toBe("done");
    expect(host.querySelector('[data-testid="merged-count"]')?.textContent).toContain("1/1 merged");
    expect(host.querySelector('[data-testid="banner-done"]')).not.toBeNull();
  });
});
