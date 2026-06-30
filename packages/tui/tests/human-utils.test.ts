import { describe, it, expect } from "bun:test";
import type { GatewayRunNode, GatewayApprovalRow } from "@smithers-orchestrator/gateway-client";
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

  it("returns null when there is no pending approval/request", () => {
    expect(buildHumanRequestUi(node(), undefined, "run-1")).toBeNull();
  });

  it("falls back the title to the node name when the request has no title", () => {
    const ui = buildHumanRequestUi(node({ name: "collect-input" }), approval({ requestTitle: undefined }), "run-1");
    expect(ui!.title).toBe("collect-input");
  });
});
