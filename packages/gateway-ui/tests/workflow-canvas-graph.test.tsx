/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { createElement, memo, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReactFlowProvider, type NodeProps } from "@xyflow/react";
import {
  SmithersNodeHandles,
  SmithersTaskNode,
  WorkflowGraph,
  workflowToFlow,
  type SmithersFlowNode,
  type WorkflowSpecNode,
} from "../src/WorkflowGraph";
import { SmithersCanvasNode } from "../src/SmithersCanvasNode";

/**
 * The workflow-canvas lane's gateway integration: SmithersNodeHandles is the
 * shared handle pair every smithersTask renderer must render, and
 * SmithersCanvasNode composes the renderer-neutral @smithers-orchestrator/ui
 * canvas anatomy inside it. happy-dom cannot paint canvases, so assertions
 * target the parsed model plus renderToStaticMarkup inside a
 * ReactFlowProvider (handles read the ReactFlow store).
 */

const SPEC: WorkflowSpecNode[] = [
  { id: "plan", label: "Plan the work", kind: "agent", output: "3 steps", status: "done" },
  { id: "build", label: "Build it", kind: "compute", status: "running", dependsOn: ["plan"] },
];

function renderInProvider(node: ReactElement): string {
  return renderToStaticMarkup(createElement(ReactFlowProvider, null, node));
}

describe("SmithersNodeHandles", () => {
  test("renders exactly the target-left / source-right handle pair, no ids", () => {
    const html = renderInProvider(createElement(SmithersNodeHandles));
    const handles = html.match(/react-flow__handle-(left|right)/g) ?? [];
    expect(handles).toEqual(["react-flow__handle-left", "react-flow__handle-right"]);
    expect(html).toContain('data-handlepos="left"');
    expect(html).toContain('data-handlepos="right"');
    expect(html).not.toContain('data-handleid=');
  });
});

describe("SmithersTaskNode (refactored onto SmithersNodeHandles)", () => {
  test("still renders both handles and the unchanged card anatomy", () => {
    const node = createElement(SmithersTaskNode, {
      data: { label: "Plan the work", kind: "agent", output: "3 steps", status: "done" },
    } as unknown as NodeProps<SmithersFlowNode>);
    const html = renderInProvider(node);
    expect(html).toContain('data-handlepos="left"');
    expect(html).toContain('data-handlepos="right"');
    expect(html).toContain("node-kicker");
    expect(html).toContain("node-dot");
    expect(html).toContain("Plan the work");
    expect(html).toContain("3 steps");
  });
});

describe("SmithersCanvasNode", () => {
  test("composes the ui canvas anatomy inside SmithersNodeHandles", () => {
    const node = createElement(SmithersCanvasNode, {
      data: { label: "Build it", kind: "compute", output: "chunk 2/5", status: "running" },
      selected: true,
    } as unknown as NodeProps<SmithersFlowNode>);
    const html = renderInProvider(node);
    expect(html).toContain('data-slot="workflow-node"');
    expect(html).toContain('data-kind="compute"');
    expect(html).toContain('data-status="running"');
    expect(html).toContain('data-selected="true"');
    expect(html).toContain('data-slot="workflow-node-header"');
    expect(html).toContain('data-slot="workflow-node-status"');
    expect(html).toContain("Running");
    expect(html).toContain("Build it");
    expect(html).toContain('data-slot="workflow-node-content"');
    expect(html).toContain("chunk 2/5");
    // Handles stay inside the node root so edges attach.
    expect(html).toContain('data-handlepos="left"');
    expect(html).toContain('data-handlepos="right"');
  });

  test("omits the content slot and status pill when the model lacks them", () => {
    const node = createElement(SmithersCanvasNode, {
      data: { label: "Ship it", kind: "approval", output: "" },
      selected: false,
    } as unknown as NodeProps<SmithersFlowNode>);
    const html = renderInProvider(node);
    expect(html).toContain('data-slot="workflow-node"');
    expect(html).toContain('data-selected="false"');
    expect(html).not.toContain('data-slot="workflow-node-content"');
    expect(html).not.toContain('data-slot="workflow-node-status"');
    expect(html).toContain("Ship it");
  });
});

describe("WorkflowGraph nodeTypes seam", () => {
  test("still lays out every node as smithersTask (the overridable key)", () => {
    const { nodes } = workflowToFlow(SPEC);
    expect(nodes.map((node) => node.type)).toEqual(["smithersTask", "smithersTask"]);
  });

  test("mounts with a custom smithersTask renderer merged over the default", () => {
    const html = renderToStaticMarkup(
      createElement(WorkflowGraph, {
        spec: SPEC,
        nodeTypes: { smithersTask: memo(SmithersCanvasNode) },
      }),
    );
    expect(html).toContain("react-flow");
    expect(html.length).toBeGreaterThan(0);
  });

  test("mounts unchanged with no nodeTypes prop", () => {
    const html = renderToStaticMarkup(createElement(WorkflowGraph, { spec: SPEC }));
    expect(html).toContain("react-flow");
  });
});
