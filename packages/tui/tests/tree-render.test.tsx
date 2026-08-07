/** @jsxImportSource @opentui/react */
import { it, expect } from "bun:test";
import { describeHeadlessRender, renderForTest } from "./renderHelpers.tsx";
import type { GatewayRunNode, GatewayEventFrame } from "@smthrs/gateway-client";
import { NodeInspectorView, TreePanel, type ApprovalUiState } from "../src/modes/TreeMode.tsx";
import type { NodeDiffView } from "../src/modes/diffUtils.ts";
import { ALL_TABS, type FlatNode, type TabId } from "../src/modes/treeUtils.ts";

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

describeHeadlessRender("NodeInspectorView – terminal rendering (CI-safe, no gateway)", () => {
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

  // The empty logs tab is the FIRST thing an operator sees after pressing [2]
  // on a node that has produced no events yet (a parked root, a pending task),
  // so its placeholder is the tab's only observable render. The PTY monitor
  // e2e (apps/cli/tests/tui-monitor-zmux.e2e.test.js) asserts this exact
  // string, but only runs on a dev box with zmux — cover it here so CI catches
  // a drifting placeholder. It must stay parenthesized like every other
  // inspector placeholder ("(no output)", "(no log events)").
  it("renders the parenthesized placeholder when the logs tab has no events", async () => {
    const { waitForVisualIdle, captureCharFrame, renderer } = await renderForTest(
      <NodeInspectorView {...baseProps({ activeTab: "logs", nodeLogs: [] })} />,
      { width: 120, height: 24 },
    );
    await waitForVisualIdle();
    expect(captureCharFrame()).toContain("(no log events for this node)");
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

  it("renders a live working-copy diff with its live marker while the node runs", async () => {
    const diff: NodeDiffView = {
      kind: "patch",
      summary: "2 files changed (live)",
      unified: "# modify src/a.ts\n@@ -1 +1 @@\n-old\n+new",
      live: true,
    };
    const { waitForVisualIdle, captureCharFrame, renderer } = await renderForTest(
      <NodeInspectorView {...baseProps({ activeTab: "diff", diff })} />,
      { width: 120, height: 24 },
    );
    await waitForVisualIdle();
    const f = captureCharFrame();
    expect(f).toContain("2 files changed (live)");
    expect(f).toContain("+new");
    // A live diff is data, not the old terminal-state gate error.
    expect(f).not.toContain("Diff unavailable");
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

  it("surfaces a failed diff RPC distinctly, not as 'No diff available'", async () => {
    const diff: NodeDiffView = { kind: "error", message: "DiffTooLarge: bundle exceeds 50MB" };
    const { waitForVisualIdle, captureCharFrame, renderer } = await renderForTest(
      <NodeInspectorView {...baseProps({ activeTab: "diff", diff })} />,
      { width: 120, height: 24 },
    );
    await waitForVisualIdle();
    const f = captureCharFrame();
    expect(f).toContain("Diff unavailable");
    expect(f).toContain("DiffTooLarge");
    expect(f).not.toContain("No diff available");
    renderer.destroy();
  });

  it("keeps a select approval's highlight visible past the 6-row fold and announces hidden options", async () => {
    // 8 options with the 7th highlighted: cycling wraps the FULL list, so the
    // rendered window must follow the pick (it used to slice 0..6 and let the
    // › marker vanish while [a] silently approved the invisible option).
    const approval: ApprovalUiState = {
      title: "Pick a plan",
      mode: "select",
      options: Array.from({ length: 8 }, (_, i) => ({
        key: `opt-${i + 1}`,
        label: `Plan-${i + 1}`,
      })),
      selectedKey: "opt-7",
      busy: false,
      error: null,
    };
    const { waitForVisualIdle, captureCharFrame, renderer } = await renderForTest(
      <NodeInspectorView {...baseProps({ approval })} />,
      { width: 120, height: 30 },
    );
    await waitForVisualIdle();
    const f = captureCharFrame();
    expect(f).toContain("Plan-7");
    expect(f).toContain("›");
    // The window slid: the first option is off-screen, hidden count announced.
    expect(f).not.toContain("Plan-1 ");
    expect(f).toContain("+3 more");
    renderer.destroy();
  });

  it("announces hidden entries for an overflowing rank approval", async () => {
    const approval: ApprovalUiState = {
      title: "Order the rollout",
      mode: "rank",
      options: Array.from({ length: 8 }, (_, i) => ({
        key: `step-${i + 1}`,
        label: `Step-${i + 1}`,
      })),
      selectedKey: null,
      busy: false,
      error: null,
    };
    const { waitForVisualIdle, captureCharFrame, renderer } = await renderForTest(
      <NodeInspectorView {...baseProps({ approval })} />,
      { width: 120, height: 30 },
    );
    await waitForVisualIdle();
    const f = captureCharFrame();
    // First five rows shown with their true rank numbers + the indicator, so
    // "approve (ranked as listed)" can't silently include unseen entries.
    expect(f).toContain("1.");
    expect(f).toContain("Step-5");
    expect(f).toContain("+3 more");
    expect(f).not.toContain("Step-8");
    renderer.destroy();
  });
});

// ─── TreePanel scroll window ──────────────────────────────────────────────────

function flatRow(i: number): FlatNode {
  const id = `task-${String(i).padStart(2, "0")}`;
  return {
    node: { id, name: id, kind: "task", status: "done" },
    depth: 0,
    hasChildren: false,
    isCollapsed: false,
  };
}

describeHeadlessRender("TreePanel – scroll window follows the focused row (CI-safe, no gateway)", () => {
  const rows = Array.from({ length: 40 }, (_, i) => flatRow(i));

  it("keeps a focused row past the fold visible", async () => {
    // 40 rows in a 10-row pane, focus on row 35: without the window the
    // highlight was culled off-screen with no way to scroll it back.
    const { waitForVisualIdle, captureCharFrame, renderer } = await renderForTest(
      <TreePanel flat={rows} focusIdx={35} panelWidth={60} paneRows={10} />,
      { width: 80, height: 12 },
    );
    await waitForVisualIdle();
    const f = captureCharFrame();
    expect(f).toContain("task-35");
    expect(f).not.toContain("task-00");
    renderer.destroy();
  });

  it("shows the top of the list while the focus is above the fold", async () => {
    const { waitForVisualIdle, captureCharFrame, renderer } = await renderForTest(
      <TreePanel flat={rows} focusIdx={0} panelWidth={60} paneRows={10} />,
      { width: 80, height: 12 },
    );
    await waitForVisualIdle();
    const f = captureCharFrame();
    expect(f).toContain("task-00");
    expect(f).not.toContain("task-35");
    renderer.destroy();
  });

  it("reaches the very last row without a blank tail", async () => {
    const { waitForVisualIdle, captureCharFrame, renderer } = await renderForTest(
      <TreePanel flat={rows} focusIdx={39} panelWidth={60} paneRows={10} />,
      { width: 80, height: 12 },
    );
    await waitForVisualIdle();
    const f = captureCharFrame();
    expect(f).toContain("task-39");
    expect(f).toContain("task-30");
    renderer.destroy();
  });
});
