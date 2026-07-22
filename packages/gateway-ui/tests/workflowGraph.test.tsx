/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReactFlowProvider, type NodeProps } from "@xyflow/react";
import {
  SmithersTaskNode,
  WorkflowGraph,
  workflowToFlow,
  type SmithersFlowNode,
  type WorkflowSpecNode,
} from "../src/WorkflowGraph";

/**
 * `workflowToFlow` is pure (dagre only, no DOM), so it is unit-tested directly.
 * `SmithersTaskNode` reads the ReactFlow store via its `<Handle>`s, so it renders
 * only inside a `<ReactFlowProvider>`; `renderToStaticMarkup` gives us the card
 * markup without a live DOM. The full `<WorkflowGraph>` provides its own store,
 * so it renders standalone — we assert it mounts and ships its CSS rather than
 * the post-measurement node positions, which only exist after layout effects.
 */

const SPEC: WorkflowSpecNode[] = [
  { id: "plan", label: "Plan the work", kind: "agent", output: "3 steps", status: "done" },
  { id: "build", label: "Build it", kind: "compute", status: "running", dependsOn: ["plan"] },
  { id: "ship", label: "Ship it", kind: "approval", output: "", dependsOn: ["build", "ghost"] },
];

// SmithersTaskNode only reads `data`; the rest of NodeProps is irrelevant here.
function renderNode(data: SmithersFlowNode["data"]): string {
  const node = createElement(SmithersTaskNode, { data } as unknown as NodeProps<SmithersFlowNode>);
  return renderToStaticMarkup(createElement(ReactFlowProvider, null, node) as ReactElement);
}

describe("workflowToFlow", () => {
  test("lays out every spec node left-to-right and wires dependency edges", () => {
    const { nodes, edges } = workflowToFlow(SPEC);

    expect(nodes.map((node) => node.id)).toEqual(["plan", "build", "ship"]);
    for (const node of nodes) {
      expect(node.type).toBe("smithersTask");
      expect(Number.isFinite(node.position.x)).toBe(true);
      expect(Number.isFinite(node.position.y)).toBe(true);
    }
    // rankdir "LR": a dependent sits to the right of what it depends on.
    const byId = Object.fromEntries(nodes.map((node) => [node.id, node]));
    expect(byId.build.position.x).toBeGreaterThan(byId.plan.position.x);
    expect(byId.ship.position.x).toBeGreaterThan(byId.build.position.x);

    // Only real dependencies produce edges — the dangling "ghost" dep is dropped.
    expect(edges).toEqual([
      { id: "plan->build", source: "plan", target: "build", type: "smoothstep" },
      { id: "build->ship", source: "build", target: "ship", type: "smoothstep" },
    ]);
  });

  test("defaults a missing output to an empty string and carries status through", () => {
    const { nodes } = workflowToFlow(SPEC);
    const byId = Object.fromEntries(nodes.map((node) => [node.id, node]));
    expect(byId.build.data.output).toBe("");
    expect(byId.plan.data.output).toBe("3 steps");
    expect(byId.build.data.status).toBe("running");
    expect(byId.ship.data.status).toBeUndefined();
  });

  test("an empty spec yields no nodes and no edges without throwing", () => {
    expect(workflowToFlow([])).toEqual({ nodes: [], edges: [] });
  });
});

describe("SmithersTaskNode card", () => {
  test("renders the shared canvas anatomy: kind badge, status pill, title and output", () => {
    const html = renderNode({ label: "Plan the work", kind: "agent", output: "3 steps", status: "running" });
    expect(html).toContain('data-kind="agent"');
    expect(html).toContain('data-status="running"');
    // Status flows through the shared StatusPill vocabulary, not a bespoke dot.
    expect(html).toContain('data-slot="workflow-node-status"');
    expect(html).toContain("Running");
    expect(html).toContain("Plan the work");
    expect(html).toContain("3 steps");
    // uppercase kind kicker
    expect(html).toContain("agent");
  });

  test("omits the status pill when a node has no status and hides an empty output", () => {
    const html = renderNode({ label: "Ship it", kind: "approval", output: "" });
    expect(html).not.toContain('data-slot="workflow-node-status"');
    expect(html).not.toContain('data-slot="workflow-node-content"');
    expect(html).toContain("Ship it");
    expect(html).toContain('data-kind="approval"');
  });
});

describe("WorkflowGraph", () => {
  test("renders the react-flow canvas and ships its base stylesheet inline", () => {
    const html = renderToStaticMarkup(<WorkflowGraph spec={SPEC} />);
    expect(html).toContain("react-flow");
    expect(html).toContain('data-theme-mode="light"');
    // The required base CSS is shipped in a <style> tag so gateway bundling keeps it.
    expect(html).toContain("<style>");
    expect(html).toContain(".react-flow__node");
  });

  test("renders an empty canvas gracefully for an empty spec", () => {
    const html = renderToStaticMarkup(<WorkflowGraph spec={[]} />);
    expect(html).toContain("react-flow");
    expect(html.length).toBeGreaterThan(0);
  });

  test("derives ReactFlow colorMode from the shared reactive theme contract", () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../src/WorkflowGraph.tsx"),
      "utf8",
    );
    expect(source).toContain("useSyncExternalStore<ResolvedTheme>(subscribeTheme, resolveTheme");
    expect(source).toContain("colorMode={colorMode}");
    expect(source).not.toContain('colorMode="system"');
  });
});
