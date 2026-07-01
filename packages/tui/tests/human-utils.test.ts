import { describe, it, expect } from "bun:test";
import type { GatewayRunNode, GatewayApprovalRow } from "@smithers-orchestrator/gateway-client";
import { snapshotToGatewayRunNode } from "@smithers-orchestrator/gateway-client";
import { isHumanTaskNode, buildHumanRequestUi } from "../src/modes/humanUtils.ts";

function node(overrides: Partial<GatewayRunNode> = {}): GatewayRunNode {
  return { id: "ask", name: "ask-human", kind: "human", status: "waiting", iteration: 0, ...overrides };
}

function approval(overrides: Partial<GatewayApprovalRow> = {}): GatewayApprovalRow {
  return {
    runId: "run-1",
    nodeId: "ask",
    iteration: 0,
    requestTitle: "Need a value",
    requestSummary: "Provide the deploy target",
    requestedAtMs: 1,
    ...overrides,
  };
}

describe("isHumanTaskNode", () => {
  it("is true only for kind=human", () => {
    expect(isHumanTaskNode(node({ kind: "human" }))).toBe(true);
    expect(isHumanTaskNode(node({ kind: "approval" }))).toBe(false);
    expect(isHumanTaskNode(node({ kind: "agent" }))).toBe(false);
    expect(isHumanTaskNode(null)).toBe(false);
    expect(isHumanTaskNode(undefined)).toBe(false);
  });
});

describe("buildHumanRequestUi", () => {
  it("builds a banner state for a HumanTask node with a pending request", () => {
    const ui = buildHumanRequestUi(node(), approval(), "run-1");
    expect(ui).not.toBeNull();
    expect(ui!.title).toBe("Need a value");
    expect(ui!.prompt).toBe("Provide the deploy target");
    expect(ui!.runId).toBe("run-1");
  });

  it("returns null for a non-human node (normal approval flow applies)", () => {
    expect(buildHumanRequestUi(node({ kind: "approval" }), approval(), "run-1")).toBeNull();
  });

  it("falls back to node metadata while the request row is still loading", () => {
    const ui = buildHumanRequestUi(node({ name: "collect-input" }), undefined, "run-1");
    expect(ui).toEqual({ title: "collect-input", prompt: undefined, runId: "run-1" });
  });

  it("returns null when the human node is no longer waiting", () => {
    expect(buildHumanRequestUi(node({ status: "done" }), approval(), "run-1")).toBeNull();
  });

  it("falls back the title to the node name when the request has no title", () => {
    const ui = buildHumanRequestUi(node({ name: "collect-input" }), approval({ requestTitle: undefined }), "run-1");
    expect(ui!.title).toBe("collect-input");
  });
});

describe("isHumanTaskNode on a real getDevToolsSnapshot shape", () => {
  it("detects a durable HumanTask mapped straight from the gateway snapshot", () => {
    // Regression guard: the gateway emits a LOWERCASE `task` node whose serialized
    // props carry `__smithersKind: "human"` (see components/HumanTask). The mapper
    // must turn that into kind "human" so the monitor shows CLI guidance rather
    // than approve/deny controls that would strand the run on a durable gate.
    const tree = snapshotToGatewayRunNode({
      root: {
        id: 1,
        name: "workflow",
        type: "workflow",
        children: [
          {
            id: 2,
            name: "human:review",
            type: "task",
            props: { __smithersKind: "human", label: "human:review" },
            task: { nodeId: "review", kind: "static", label: "human:review" },
            children: [],
          },
        ],
      },
      runState: { state: "waiting-approval", blocked: { nodeId: "review" } },
    });
    const humanNode = tree?.children?.[0] as GatewayRunNode | undefined;
    expect(humanNode?.kind).toBe("human");
    expect(isHumanTaskNode(humanNode)).toBe(true);
    // A neighbouring agent task must NOT be mistaken for a human gate.
    const agentTree = snapshotToGatewayRunNode({
      root: { id: 1, name: "run", type: "task", task: { nodeId: "build", kind: "agent" }, children: [] },
    });
    expect(isHumanTaskNode(agentTree as GatewayRunNode | undefined)).toBe(false);
  });
});
