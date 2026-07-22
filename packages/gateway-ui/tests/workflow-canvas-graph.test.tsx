/** @jsxImportSource react */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Register a real DOM before react-dom/client is imported so effects (which
// carry ReactFlow's store updater) actually run for the mounted-contract
// tests. Idempotent: another test file may already have registered.
const nativeFetch = globalThis.fetch;
try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}
globalThis.fetch = nativeFetch;

import { afterEach, describe, expect, test } from "bun:test";
import { act, createElement, memo, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { ReactFlowProvider, useStore, type NodeProps } from "@xyflow/react";
import {
  SmithersNodeHandles,
  SmithersTaskNode,
  WorkflowGraph,
  workflowToFlow,
  type SmithersFlowNode,
  type WorkflowSpecNode,
} from "../src/WorkflowGraph";
import { SmithersCanvasNode } from "../src/SmithersCanvasNode";
import { workflowGraphChromeCss } from "../src/workflowGraphCss";

/**
 * The workflow-canvas lane's gateway integration: SmithersNodeHandles is the
 * shared handle pair every smithersTask renderer must render, and
 * SmithersCanvasNode composes the renderer-neutral @smithers-orchestrator/ui
 * canvas anatomy inside it. happy-dom cannot paint canvases, so assertions
 * target the parsed model plus renderToStaticMarkup inside a
 * ReactFlowProvider (handles read the ReactFlow store).
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SPEC: WorkflowSpecNode[] = [
  { id: "plan", label: "Plan the work", kind: "agent", output: "3 steps", status: "done" },
  { id: "build", label: "Build it", kind: "compute", status: "running", dependsOn: ["plan"] },
];

function renderInProvider(node: ReactElement): string {
  return renderToStaticMarkup(createElement(ReactFlowProvider, null, node));
}

/** Strip the inline <style> payload so class-name assertions target markup only. */
function markupOnly(html: string): string {
  return html.replace(/<style>[\s\S]*?<\/style>/g, "");
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

describe("SmithersTaskNode (legacy alias of SmithersCanvasNode)", () => {
  test("paints the shared canvas anatomy and keeps both handles attached", () => {
    const node = createElement(SmithersTaskNode, {
      data: { label: "Plan the work", kind: "agent", output: "3 steps", status: "done" },
    } as unknown as NodeProps<SmithersFlowNode>);
    const html = renderInProvider(node);
    expect(html).toContain('data-handlepos="left"');
    expect(html).toContain('data-handlepos="right"');
    expect(html).toContain('data-slot="workflow-node"');
    expect(html).toContain('data-status="done"');
    expect(html).toContain("Done");
    expect(html).toContain("Plan the work");
    expect(html).toContain("3 steps");
    // The legacy inline-styled card no longer exists.
    expect(html).not.toContain("node-kicker");
    expect(html).not.toContain("node-dot");
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
    expect(html).toContain('role="option"');
    expect(html).toContain('aria-selected="true"');
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
    expect(html).toContain('role="option"');
    expect(html).toContain('aria-selected="false"');
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

  test("a custom smithersTask renderer replaces the default card in the painted markup", () => {
    const Custom = memo((props: NodeProps<SmithersFlowNode>) =>
      createElement("div", { "data-slot": "custom-node" }, props.data.label),
    );
    const html = renderToStaticMarkup(
      createElement(WorkflowGraph, {
        spec: SPEC,
        nodeTypes: { smithersTask: Custom },
      }),
    );
    // ReactFlow SSRs node content: the override must actually paint, and the
    // default canvas-anatomy card must be gone (replacement, not stacking).
    expect(html).toContain('data-slot="custom-node"');
    expect(html).toContain("Build it");
    expect(html).not.toContain('data-slot="workflow-node"');
  });

  test("unrelated nodeTypes entries merge over the default without replacing it", () => {
    const Other = memo(() => createElement("div", { "data-slot": "other-node" }));
    const html = renderToStaticMarkup(
      createElement(WorkflowGraph, { spec: SPEC, nodeTypes: { other: Other } }),
    );
    // No spec node emits type "other", so the default canvas-anatomy card stays.
    expect(html).toContain('data-slot="workflow-node"');
    expect(html).not.toContain('data-slot="other-node"');
  });

  test("mounts unchanged with no nodeTypes prop, painting the default canvas anatomy", () => {
    const html = renderToStaticMarkup(createElement(WorkflowGraph, { spec: SPEC }));
    expect(html).toContain("react-flow");
    expect(html).toContain('data-slot="workflow-canvas"');
    expect(html).toContain('data-slot="workflow-node"');
    expect(html).not.toContain("node-kicker");
  });
});

describe("WorkflowGraph keyboard focus contract", () => {
  test("gives every laid-out node an accessible aria-label", () => {
    const { nodes } = workflowToFlow(SPEC);
    expect(nodes.map((node) => node.ariaLabel)).toEqual([
      "Plan the work (agent node)",
      "Build it (compute node)",
    ]);
  });

  test("node wrappers are tab-focusable and carry their accessible names", () => {
    const html = renderToStaticMarkup(createElement(WorkflowGraph, { spec: SPEC }));
    const wrappers = html.match(/<div class="react-flow__node [^"]*"[^>]*>/g) ?? [];
    expect(wrappers.length).toBe(2);
    for (const wrapper of wrappers) {
      expect(wrapper).toContain('tabindex="0"');
      expect(wrapper).toContain("aria-label=");
    }
    expect(html).toContain('aria-label="Plan the work (agent node)"');
    expect(html).toContain('aria-label="Build it (compute node)"');
  });

  test("ships a visible focus indicator for focused nodes, resolved through house tokens", () => {
    expect(workflowGraphChromeCss).toContain(".react-flow__node:focus-visible");
    // No raw hex colors outside var() fallback position in the chrome rules.
    const stripped = workflowGraphChromeCss.replace(
      /var\(--[\w-]+(?:,\s*(?:#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|[^)]*?))?\)/g,
      "VAR",
    );
    expect(stripped).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});

describe("WorkflowGraph mounted accessible tree", () => {
  async function mount(props: Parameters<typeof WorkflowGraph>[0]) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    let root: Root | undefined;
    await act(async () => {
      root = createRoot(container);
      root.render(createElement(WorkflowGraph, props));
    });
    return {
      container,
      async unmount() {
        await act(async () => root!.unmount());
        container.remove();
      },
    };
  }

  test("the canvas is a listbox that owns every node option card", async () => {
    const { container, unmount } = await mount({ spec: SPEC });
    // Exactly one listbox: the WorkflowCanvas region itself.
    const listboxes = container.querySelectorAll("[role='listbox']");
    expect(listboxes.length).toBe(1);
    const listbox = listboxes[0]!;
    expect(listbox.getAttribute("data-slot")).toBe("workflow-canvas");
    expect(listbox.getAttribute("aria-label")).toBe("Workflow graph");
    expect(listbox.getAttribute("aria-multiselectable")).toBe("true");
    // Every node card renders as an option OWNED by the listbox — an
    // orphaned role="option" (the previous structure) is invalid ARIA.
    const options = listbox.querySelectorAll("[role='option']");
    expect(options.length).toBe(2);
    for (const option of options) {
      expect(option.getAttribute("data-slot")).toBe("workflow-node");
      expect(option.getAttribute("aria-selected")).toBe("false");
    }
    // No option escapes the listbox context.
    expect(container.querySelectorAll("[role='option']").length).toBe(2);
    // ReactFlow's focusable node wrappers sit between the two as groups —
    // a legal context for option children.
    const wrappers = container.querySelectorAll(".react-flow__node");
    expect(wrappers.length).toBe(2);
    for (const wrapper of wrappers) {
      expect(wrapper.getAttribute("role")).toBe("group");
    }
    await unmount();
  });

  test("node selection updates selection state truthfully", async () => {
    const { container, unmount } = await mount({ spec: SPEC });
    const wrapperA = container.querySelector("[data-id='plan']") as HTMLElement;
    const wrapperB = container.querySelector("[data-id='build']") as HTMLElement;
    const cardOf = (wrapper: HTMLElement) =>
      wrapper.querySelector("[data-slot='workflow-node']")!;
    await act(async () => {
      wrapperA.click();
    });
    expect(wrapperA.classList.contains("selected")).toBe(true);
    expect(cardOf(wrapperA).getAttribute("aria-selected")).toBe("true");
    expect(cardOf(wrapperB).getAttribute("aria-selected")).toBe("false");
    // Selecting another node moves the selection rather than sticking.
    await act(async () => {
      wrapperB.click();
    });
    expect(wrapperA.classList.contains("selected")).toBe(false);
    expect(cardOf(wrapperA).getAttribute("aria-selected")).toBe("false");
    expect(wrapperB.classList.contains("selected")).toBe(true);
    expect(cardOf(wrapperB).getAttribute("aria-selected")).toBe("true");
    await unmount();
  });

  test("drag repositions nodes when editable and stays pinned when read-only", async () => {
    // Editable: the gesture moves the node and the new position sticks
    // (the position change round-trips through the controlled state).
    const editable = await mount({ spec: SPEC, readOnly: false });
    const nodeA = editable.container.querySelector("[data-id='plan']") as HTMLElement;
    const before = nodeA.style.transform;
    await act(async () => {
      nodeA.dispatchEvent(new MouseEvent("mousedown", {
        bubbles: true, cancelable: true, view: window, clientX: 100, clientY: 100, button: 0,
      }));
    });
    await act(async () => {
      // Two moves: the first crosses d3-drag's click-distance threshold and
      // starts the gesture; the second produces the actual delta.
      window.dispatchEvent(new MouseEvent("mousemove", {
        bubbles: true, cancelable: true, view: window, clientX: 180, clientY: 180, buttons: 1,
      }));
      window.dispatchEvent(new MouseEvent("mousemove", {
        bubbles: true, cancelable: true, view: window, clientX: 200, clientY: 200, buttons: 1,
      }));
    });
    await act(async () => {
      window.dispatchEvent(new MouseEvent("mouseup", {
        bubbles: true, cancelable: true, view: window, clientX: 200, clientY: 200, button: 0,
      }));
    });
    expect(nodeA.style.transform).not.toBe(before);
    await editable.unmount();

    // Read-only (the default): the same gesture is inert.
    const readOnly = await mount({ spec: SPEC });
    const pinned = readOnly.container.querySelector("[data-id='plan']") as HTMLElement;
    const pinnedBefore = pinned.style.transform;
    await act(async () => {
      pinned.dispatchEvent(new MouseEvent("mousedown", {
        bubbles: true, cancelable: true, view: window, clientX: 100, clientY: 100, button: 0,
      }));
      window.dispatchEvent(new MouseEvent("mousemove", {
        bubbles: true, cancelable: true, view: window, clientX: 180, clientY: 180, buttons: 1,
      }));
      window.dispatchEvent(new MouseEvent("mousemove", {
        bubbles: true, cancelable: true, view: window, clientX: 200, clientY: 200, buttons: 1,
      }));
      window.dispatchEvent(new MouseEvent("mouseup", {
        bubbles: true, cancelable: true, view: window, clientX: 200, clientY: 200, button: 0,
      }));
    });
    expect(pinned.style.transform).toBe(pinnedBefore);
    await readOnly.unmount();
  });

  test("click-to-connect adds a real edge when editable and is inert when read-only", async () => {
    // A third unconnected node: ReactFlow's addEdge dedupes connections that
    // already exist, so wiring plan->build (already an edge in SPEC) could
    // never prove a mutation. plan->ship is a genuinely new edge.
    const CONNECT_SPEC: WorkflowSpecNode[] = [
      ...SPEC,
      { id: "ship", label: "Ship it", kind: "agent" },
    ];
    // happy-dom never measures handle bounds, so EdgeWrapper returns null and
    // no .react-flow__edge element reaches the DOM. The truthful surface for
    // the edge mutation is the controlled edges state; this probe renderer
    // (dropped in through the supported nodeTypes override, still painting
    // the real SmithersCanvasNode + handles) mirrors it out of the store.
    const observed: { edges: { id: string; source: string; target: string }[] } = { edges: [] };
    function ProbeNode(props: NodeProps) {
      const edges = useStore((state) => state.edges);
      observed.edges = edges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target }));
      return createElement(SmithersCanvasNode, props);
    }
    const connections: { source: string; target: string }[] = [];
    const editable = await mount({
      spec: CONNECT_SPEC,
      readOnly: false,
      onConnect: (connection) => connections.push({ source: connection.source, target: connection.target }),
      nodeTypes: { smithersTask: ProbeNode },
    });
    expect(observed.edges).toEqual([{ id: "plan->build", source: "plan", target: "build" }]);
    const sourceHandle = editable.container.querySelector(
      "[data-id='plan'] .react-flow__handle.source",
    ) as HTMLElement;
    const targetHandle = editable.container.querySelector(
      "[data-id='ship'] .react-flow__handle.target",
    ) as HTMLElement;
    await act(async () => {
      sourceHandle.click();
    });
    expect(sourceHandle.classList.contains("clickconnecting")).toBe(true);
    await act(async () => {
      targetHandle.click();
    });
    expect(connections).toEqual([{ source: "plan", target: "ship" }]);
    // The edge mutation, not just the callback: the new edge round-tripped
    // through addEdge into the controlled state (ReactFlow's generated
    // connection id proves it came from the gesture, not the spec).
    expect(observed.edges).toEqual([
      { id: "plan->build", source: "plan", target: "build" },
      { id: "xy-edge__plan-ship", source: "plan", target: "ship" },
    ]);
    await editable.unmount();

    // Read-only (the default): handles are not connectable, so the same
    // clicks never even start a connection gesture — no callback, no edge.
    const readOnlyConnections: unknown[] = [];
    const readOnly = await mount({
      spec: CONNECT_SPEC,
      onConnect: (connection) => readOnlyConnections.push(connection),
      nodeTypes: { smithersTask: ProbeNode },
    });
    expect(observed.edges.length).toBe(1);
    const roSource = readOnly.container.querySelector(
      "[data-id='plan'] .react-flow__handle.source",
    ) as HTMLElement;
    const roTarget = readOnly.container.querySelector(
      "[data-id='ship'] .react-flow__handle.target",
    ) as HTMLElement;
    await act(async () => {
      roSource.click();
      roTarget.click();
    });
    expect(roSource.classList.contains("clickconnecting")).toBe(false);
    expect(readOnlyConnections).toEqual([]);
    expect(observed.edges).toEqual([{ id: "plan->build", source: "plan", target: "build" }]);
    await readOnly.unmount();
  });
});

describe("WorkflowGraph read-only contract", () => {
  test("bakes the read-only flags onto every laid-out node", () => {
    const readonlyNodes = workflowToFlow(SPEC).nodes;
    for (const node of readonlyNodes) {
      expect(node.draggable).toBe(false);
      expect(node.connectable).toBe(false);
      expect(node.deletable).toBe(false);
    }
    const editableNodes = workflowToFlow(SPEC, { readOnly: false }).nodes;
    for (const node of editableNodes) {
      expect(node.draggable).toBe(true);
      expect(node.connectable).toBe(true);
      expect(node.deletable).toBe(true);
    }
  });

  test("defaults to read-only at first paint: no draggable nodes or connectable handles in SSR markup", () => {
    const html = markupOnly(renderToStaticMarkup(createElement(WorkflowGraph, { spec: SPEC })));
    const wrappers = html.match(/<div class="react-flow__node [^"]*"[^>]*>/g) ?? [];
    expect(wrappers.length).toBe(2);
    for (const wrapper of wrappers) {
      expect(wrapper).not.toContain("draggable");
    }
    expect(html).not.toContain("connectablestart");
    // ...but nodes stay keyboard-focusable in read-only mode.
    for (const wrapper of wrappers) {
      expect(wrapper).toContain('tabindex="0"');
    }
  });

  test("readOnly={false} opts into real drag and connect mutations at first paint", () => {
    const html = markupOnly(renderToStaticMarkup(
      createElement(WorkflowGraph, { spec: SPEC, readOnly: false }),
    ));
    const wrappers = html.match(/<div class="react-flow__node [^"]*"[^>]*>/g) ?? [];
    expect(wrappers.length).toBe(2);
    for (const wrapper of wrappers) {
      expect(wrapper).toContain("draggable");
    }
    expect(html).toContain("connectablestart");
  });

  test("the mounted store enforces the same contract after effects run", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    let root: Root | undefined;
    await act(async () => {
      root = createRoot(container);
      root.render(createElement(WorkflowGraph, { spec: SPEC }));
    });
    const nodes = [...container.querySelectorAll(".react-flow__node")];
    expect(nodes.length).toBe(2);
    for (const node of nodes) {
      expect(node.classList.contains("draggable")).toBe(false);
      expect(node.getAttribute("tabindex")).toBe("0");
    }
    expect(container.querySelector(".react-flow__handle.connectablestart")).toBeNull();
    await act(async () => {
      root!.render(createElement(WorkflowGraph, { spec: SPEC, readOnly: false }));
    });
    for (const node of container.querySelectorAll(".react-flow__node")) {
      expect(node.classList.contains("draggable")).toBe(true);
    }
    expect(container.querySelector(".react-flow__handle.connectablestart")).not.toBeNull();
    await act(async () => root!.unmount());
    container.remove();
  });
});
