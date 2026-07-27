/** @jsxImportSource @opentui/react */
import { it, expect } from "bun:test";
import { act } from "react";
import { describeHeadlessRender, renderForTest } from "./renderHelpers.tsx";
import type { GatewayRunNode } from "@smithers-orchestrator/gateway-client";
import { GraphView } from "../src/modes/GraphMode.tsx";

/**
 * CI-safe terminal rendering tests for GRAPH mode. No gateway, no agent CLI, no
 * browser.
 *
 * These render the REAL presentational `GraphView` (the same component
 * production mounts via `GraphMode`, a thin `useRunInspectorVm` wrapper) with
 * injected tree data, so the DAG layout + Enter→onSelectNodeKey wiring can't
 * drift from what these exercise.
 */

const ROOT: GatewayRunNode = {
  id: "root",
  name: "root",
  kind: "task",
  status: "running",
  childIds: ["alpha", "beta"],
};
const ALPHA: GatewayRunNode = { id: "alpha", name: "alpha", kind: "task", status: "done", parentId: "root" };
const BETA: GatewayRunNode = { id: "beta", name: "beta", kind: "task", status: "done", parentId: "root" };
const NODES: GatewayRunNode[] = [ROOT, ALPHA, BETA];

describeHeadlessRender("GraphView – terminal rendering (CI-safe, no gateway)", () => {
  it("renders the GRAPH header, node count, node cards, and connector arrows", async () => {
    const { waitForVisualIdle, captureCharFrame, renderer } = await renderForTest(
      <GraphView nodes={NODES} root={ROOT} isLoading={false} error={undefined} />,
      { width: 120, height: 30 },
    );
    await waitForVisualIdle();
    const f = captureCharFrame();
    expect(f).toContain("GRAPH");
    expect(f).toContain("3 node(s)");
    expect(f).toContain("root");
    expect(f).toContain("alpha");
    expect(f).toContain("beta");
    // Normal-width layout draws the "──▶" connector between columns.
    expect(f).toContain("▶");
    renderer.destroy();
  });

  it("shows the loading placeholder", async () => {
    const { waitForVisualIdle, captureCharFrame, renderer } = await renderForTest(
      <GraphView nodes={[]} root={null} isLoading={true} error={undefined} />,
      { width: 120, height: 20 },
    );
    await waitForVisualIdle();
    expect(captureCharFrame()).toContain("Loading graph");
    renderer.destroy();
  });

  it("shows the error text", async () => {
    const { waitForVisualIdle, captureCharFrame, renderer } = await renderForTest(
      <GraphView nodes={[]} root={null} isLoading={false} error={new Error("boom")} />,
      { width: 120, height: 20 },
    );
    await waitForVisualIdle();
    expect(captureCharFrame()).toContain("Error: boom");
    renderer.destroy();
  });

  it("shows the empty state when there are no nodes", async () => {
    const { waitForVisualIdle, captureCharFrame, renderer } = await renderForTest(
      <GraphView nodes={[]} root={null} isLoading={false} error={undefined} />,
      { width: 120, height: 20 },
    );
    await waitForVisualIdle();
    expect(captureCharFrame()).toContain("(no nodes)");
    renderer.destroy();
  });

  it("Enter fires onSelectNodeKey with the focused node's key (root, column-major first)", async () => {
    const selected: string[] = [];
    const { waitForVisualIdle, mockInput, flush, renderer } = await renderForTest(
      <GraphView
        nodes={NODES}
        root={ROOT}
        isLoading={false}
        error={undefined}
        onSelectNodeKey={(k) => selected.push(k)}
      />,
      { width: 120, height: 30 },
    );
    await waitForVisualIdle();

    act(() => {
      mockInput.pressEnter();
    });
    await flush();
    await waitForVisualIdle();
    expect(selected).toEqual(["root"]);

    renderer.destroy();
  });

  it("j moves selection to the next node, then Enter fires it", async () => {
    const selected: string[] = [];
    const { waitForVisualIdle, mockInput, flush, renderer } = await renderForTest(
      <GraphView
        nodes={NODES}
        root={ROOT}
        isLoading={false}
        error={undefined}
        onSelectNodeKey={(k) => selected.push(k)}
      />,
      { width: 120, height: 30 },
    );
    await waitForVisualIdle();

    act(() => {
      mockInput.pressKey("j");
    });
    await flush();
    await waitForVisualIdle();
    act(() => {
      mockInput.pressEnter();
    });
    await flush();
    await waitForVisualIdle();
    expect(selected).toEqual(["alpha"]);

    renderer.destroy();
  });
});
