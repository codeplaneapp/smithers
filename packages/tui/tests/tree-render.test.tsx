/** @jsxImportSource @opentui/react */
import { describe, it, expect } from "bun:test";
import { renderForTest } from "./renderHelpers.tsx";
import type { GatewayRunNode, GatewayEventFrame } from "@smithers-orchestrator/gateway-client";
import { NodeInspectorView, type ApprovalUiState } from "../src/modes/TreeMode.tsx";
import type { NodeDiffView } from "../src/modes/diffUtils.ts";
import { ALL_TABS, type TabId } from "../src/modes/treeUtils.ts";

/**
 * Terminal rendering tests for the REAL Tree inspector (`NodeInspectorView`),
 * the same presentational component production mounts via the gateway-connected
 * `NodeInspector` wrapper. CI-safe: props-only, no gateway / agent / browser.
 */

const NODE: GatewayRunNode = {
  id: "node-alpha",
  name: "fetch-data",
  kind: "task",
  status: "running",
  iteration: 0,
};

const EMPTY_DIFF: NodeDiffView = { kind: "empty", message: "No diff available for this node." };

function logFrame(seq: number, event: string, payload?: unknown): GatewayEventFrame {
  return { type: "event", seq, event, payload, stateVersion: seq };
}

function baseProps(overrides: Partial<Parameters<typeof NodeInspectorView>[0]> = {}) {
  return {
    node: NODE,
    activeTab: "output" as TabId,
    outputText: "hello-output",
    nodeLogs: [] as GatewayEventFrame[],
    propsText: '{ "id": "node-alpha" }',
    diff: EMPTY_DIFF,
    diffLoading: false,
    approval: null as ApprovalUiState | null,
    ...overrides,
  };
}

describe("NodeInspectorView – terminal rendering (CI-safe, no gateway)", () => {
  it("shows the placeholder when no node is selected", async () => {
    const { waitForVisualIdle, captureCharFrame, renderer } = await renderForTest(
      <NodeInspectorView {...baseProps({ node: null })} />,
      { width: 100, height: 24 },
    );
    await waitForVisualIdle();
    expect(captureCharFrame()).toContain("Select a node");
    renderer.destroy();
  });

  it("renders all tab labels and the output text", async () => {
    const { waitForVisualIdle, captureCharFrame, renderer } = await renderForTest(
      <NodeInspectorView {...baseProps()} />,
      { width: 100, height: 24 },
    );
    await waitForVisualIdle();
    const f = captureCharFrame();
    for (const tab of ALL_TABS) expect(f).toContain(tab);
    expect(f).toContain("hello-output");
    renderer.destroy();
  });

  it("renders injected node log events on the logs tab", async () => {
    const logs = [
      logFrame(11, "tool.use", { nodeId: "node-alpha", toolName: "read_file" }),
      logFrame(12, "agent.message", { nodeId: "node-alpha", text: "working" }),
    ];
    const { waitForVisualIdle, captureCharFrame, renderer } = await renderForTest(
      <NodeInspectorView {...baseProps({ activeTab: "logs", nodeLogs: logs })} />,
      { width: 120, height: 24 },
    );
    await waitForVisualIdle();
    const f = captureCharFrame();
    expect(f).toContain("tool.use");
    expect(f).toContain("[11]");
    renderer.destroy();
  });

  it("renders a unified diff (summary + patch text) on the diff tab", async () => {
    const diff: NodeDiffView = {
      kind: "patch",
      summary: "1 file changed",
      unified: "# modify src/a.ts\n@@ -1 +1 @@\n-old\n+new",
    };
    const { waitForVisualIdle, captureCharFrame, renderer } = await renderForTest(
      <NodeInspectorView {...baseProps({ activeTab: "diff", diff })} />,
      { width: 120, height: 24 },
    );
    await waitForVisualIdle();
    const f = captureCharFrame();
    expect(f).toContain("1 file changed");
    expect(f).toContain("src/a.ts");
    expect(f).toContain("+new");
    renderer.destroy();
  });

  it("shows a loading state for the diff tab", async () => {
    const { waitForVisualIdle, captureCharFrame, renderer } = await renderForTest(
      <NodeInspectorView {...baseProps({ activeTab: "diff", diffLoading: true })} />,
      { width: 100, height: 24 },
    );
    await waitForVisualIdle();
    expect(captureCharFrame()).toContain("Loading diff");
    renderer.destroy();
  });

  it("shows an explicit empty/unavailable state for the diff tab", async () => {
    const { waitForVisualIdle, captureCharFrame, renderer } = await renderForTest(
      <NodeInspectorView {...baseProps({ activeTab: "diff" })} />,
      { width: 100, height: 24 },
    );
    await waitForVisualIdle();
    expect(captureCharFrame()).toContain("No diff available");
    renderer.destroy();
  });

  it("renders a gate approval banner with approve/deny controls", async () => {
    const approval: ApprovalUiState = {
      title: "Ship it?",
      summary: "Deploy to prod",
      mode: "gate",
      options: [],
      selectedKey: null,
      busy: false,
      error: null,
    };
    const { waitForVisualIdle, captureCharFrame, renderer } = await renderForTest(
      <NodeInspectorView {...baseProps({ approval })} />,
      { width: 120, height: 28 },
    );
    await waitForVisualIdle();
    const f = captureCharFrame();
    expect(f).toContain("Ship it?");
    expect(f).toContain("[gate]");
    expect(f).toContain("approve");
    expect(f).toContain("deny");
    renderer.destroy();
  });

  it("renders a select approval banner with options and the highlighted choice", async () => {
    const approval: ApprovalUiState = {
      title: "Pick a plan",
      summary: "Choose the best option",
      mode: "select",
      options: [
        { key: "light", label: "Light" },
        { key: "balanced", label: "Balanced" },
      ],
      selectedKey: "balanced",
      busy: false,
      error: null,
    };
    const { waitForVisualIdle, captureCharFrame, renderer } = await renderForTest(
      <NodeInspectorView {...baseProps({ approval })} />,
      { width: 120, height: 30 },
    );
    await waitForVisualIdle();
    const f = captureCharFrame();
    expect(f).toContain("Pick a plan");
    expect(f).toContain("[select]");
    expect(f).toContain("Light");
    expect(f).toContain("Balanced");
    // The highlighted option is marked and the controls advertise approve-selected.
    expect(f).toContain("›");
    expect(f).toContain("approve selected");
    renderer.destroy();
  });

  it("surfaces an approval error in the banner", async () => {
    const approval: ApprovalUiState = {
      title: "Pick a plan",
      mode: "select",
      options: [{ key: "a", label: "A" }],
      selectedKey: null,
      busy: false,
      error: "select an option before approving",
    };
    const { waitForVisualIdle, captureCharFrame, renderer } = await renderForTest(
      <NodeInspectorView {...baseProps({ approval })} />,
      { width: 120, height: 28 },
    );
    await waitForVisualIdle();
    expect(captureCharFrame()).toContain("select an option");
    renderer.destroy();
  });
});
