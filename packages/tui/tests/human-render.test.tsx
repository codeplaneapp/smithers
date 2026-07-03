/** @jsxImportSource @opentui/react */
import { it, expect } from "bun:test";
import { describeHeadlessRender, renderForTest } from "./renderHelpers.tsx";
import type { GatewayRunNode } from "@smithers-orchestrator/gateway-client";
import { NodeInspectorView, type ApprovalUiState } from "../src/modes/TreeMode.tsx";
import type { HumanRequestUiState } from "../src/modes/humanUtils.ts";
import type { NodeDiffView } from "../src/modes/diffUtils.ts";
import type { TabId } from "../src/modes/treeUtils.ts";

/**
 * The monitor cannot submit a HumanTask's typed answer (no gateway RPC), so the
 * inspector must surface CLI guidance instead of approve/deny controls that
 * would strand the run. CI-safe: props-only, no gateway.
 */

const HUMAN_NODE: GatewayRunNode = {
  id: "ask",
  name: "ask-human",
  kind: "human",
  status: "waiting",
  iteration: 0,
};

const EMPTY_DIFF: NodeDiffView = { kind: "empty", message: "No diff available." };

function baseProps(overrides: Partial<Parameters<typeof NodeInspectorView>[0]> = {}) {
  return {
    node: HUMAN_NODE,
    activeTab: "props" as TabId,
    outputText: "",
    nodeLogs: [],
    propsText: "{}",
    diff: EMPTY_DIFF,
    diffLoading: false,
    approval: null as ApprovalUiState | null,
    humanRequest: null as HumanRequestUiState | null,
    ...overrides,
  };
}

describeHeadlessRender("NodeInspectorView – human-task banner (CI-safe, no gateway)", () => {
  it("renders the human-request banner with the prompt and CLI guidance", async () => {
    const humanRequest: HumanRequestUiState = {
      title: "Need a value",
      prompt: "Provide the deploy target",
      runId: "run-abc123",
    };
    const { waitForVisualIdle, captureCharFrame, renderer } = await renderForTest(
      <NodeInspectorView {...baseProps({ humanRequest })} />,
      { width: 120, height: 24 },
    );
    await waitForVisualIdle();
    const f = captureCharFrame();
    expect(f).toContain("Need a value");
    expect(f).toContain("[human input]");
    expect(f).toContain("Provide the deploy target");
    // Points at the real CLI to answer, with the run id for context.
    expect(f).toContain("smithers human");
    expect(f).toContain("run-abc123");
    renderer.destroy();
  });

  it("shows the human banner INSTEAD of an approval banner when both are present", async () => {
    // Production passes approval=null for a human task, but assert the view
    // prioritizes the human banner so a stray approval prop can't show
    // approve/deny controls that would strand the run.
    const humanRequest: HumanRequestUiState = { title: "Need a value", runId: "run-1" };
    const approval: ApprovalUiState = {
      title: "Should never show",
      mode: "gate",
      options: [],
      selectedKey: null,
      busy: false,
      error: null,
    };
    const { waitForVisualIdle, captureCharFrame, renderer } = await renderForTest(
      <NodeInspectorView {...baseProps({ humanRequest, approval })} />,
      { width: 120, height: 24 },
    );
    await waitForVisualIdle();
    const f = captureCharFrame();
    expect(f).toContain("[human input]");
    expect(f).not.toContain("Should never show");
    expect(f).not.toContain("approve");
    renderer.destroy();
  });
});
