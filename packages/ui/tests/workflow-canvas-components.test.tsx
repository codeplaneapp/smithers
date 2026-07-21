/** @jsxImportSource react */
import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SMITHERS_UI_STYLE_ATTR } from "../src/index";
import {
  WorkflowCanvas,
  WorkflowConnection,
  WorkflowControls,
  WorkflowEdge,
  WorkflowMinimap,
  WorkflowNode,
  WorkflowNodeContent,
  WorkflowNodeHeader,
  WorkflowNodeStatus,
  WorkflowPanel,
  WorkflowToolbar,
} from "../src/canvas/WorkflowCanvas";
import { WORKFLOW_CANVAS_CSS_ID } from "../src/canvas/canvasCss";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | undefined;
let root: Root | undefined;

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => current.unmount());
    root = undefined;
  }
  container?.remove();
  container = undefined;
  delete document.documentElement.dataset.theme;
  document.querySelectorAll(`style[${SMITHERS_UI_STYLE_ATTR}]`).forEach((element) => element.remove());
  document
    .querySelectorAll(`style[data-smithers-ui-lane="${WORKFLOW_CANVAS_CSS_ID}"]`)
    .forEach((element) => element.remove());
});

async function render(element: ReactElement): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const current = root;
  await act(async () => current.render(element));
  return container;
}

describe("WorkflowCanvas", () => {
  test("renders a labelled group region with the sui-canvas class", async () => {
    const host = await render(<WorkflowCanvas>nodes</WorkflowCanvas>);
    const canvas = host.querySelector("[data-slot='workflow-canvas']")!;
    expect(canvas.getAttribute("role")).toBe("group");
    expect(canvas.getAttribute("aria-label")).toBe("Workflow canvas");
    expect(canvas.classList.contains("sui-canvas")).toBe(true);
    expect(canvas.textContent).toContain("nodes");
  });

  test("honours an aria-label override", async () => {
    const host = await render(<WorkflowCanvas aria-label="Run DAG" />);
    expect(host.querySelector("[data-slot='workflow-canvas']")!.getAttribute("aria-label")).toBe("Run DAG");
  });

  test("self-injects the lane stylesheet exactly once", async () => {
    await render(<WorkflowCanvas />);
    const styles = document.querySelectorAll(`style[data-smithers-ui-lane="${WORKFLOW_CANVAS_CSS_ID}"]`);
    expect(styles.length).toBe(1);
    expect(styles[0]!.textContent).toContain(".sui-canvas-node {");
  });
});

describe("WorkflowNode", () => {
  test("renders title, kind badge, and status pill in a card", async () => {
    const host = await render(<WorkflowNode title="Build it" kind="agent" status="running" />);
    const node = host.querySelector("[data-slot='workflow-node']")!;
    expect(node.getAttribute("data-kind")).toBe("agent");
    expect(node.getAttribute("data-status")).toBe("running");
    expect(node.getAttribute("data-selected")).toBe("false");
    expect(node.querySelector(".sui-canvas-node-title")!.textContent).toBe("Build it");
    expect(node.querySelector(".sui-canvas-node-kind")!.textContent).toBe("agent");
    expect(node.querySelector("[data-slot='workflow-node-status']")!.textContent).toContain("Running");
  });

  test("marks the selected ring via data-selected", async () => {
    const host = await render(<WorkflowNode title="x" selected />);
    expect(host.querySelector("[data-slot='workflow-node']")!.getAttribute("data-selected")).toBe("true");
  });

  test("renders compound children verbatim when composed", async () => {
    const host = await render(
      <WorkflowNode>
        <WorkflowNodeHeader>
          <span className="custom-head">head</span>
        </WorkflowNodeHeader>
        <WorkflowNodeContent>body</WorkflowNodeContent>
      </WorkflowNode>,
    );
    expect(host.querySelector("[data-slot='workflow-node-header'] .custom-head")!.textContent).toBe("head");
    expect(host.querySelector("[data-slot='workflow-node-content']")!.textContent).toBe("body");
  });

  test("renders correctly under data-theme=dark", async () => {
    document.documentElement.dataset.theme = "dark";
    const host = await render(<WorkflowNode title="Dark node" status="failed" />);
    expect(host.querySelector("[data-slot='workflow-node']")!.getAttribute("data-status")).toBe("failed");
    expect(host.querySelector("[data-slot='workflow-node-status']")!.textContent).toContain("Failed");
  });
});

describe("WorkflowNodeStatus", () => {
  test("pipes the status string through StatusPill", async () => {
    const host = await render(<WorkflowNodeStatus status="waiting-approval" />);
    const pill = host.querySelector("[data-slot='workflow-node-status']")!;
    expect(pill.textContent).toContain("Waiting for approval");
  });
});

describe("WorkflowEdge", () => {
  test("renders a from -> to legend chip with an optional label and status dot", async () => {
    const host = await render(<WorkflowEdge from="plan" to="build" label="depends on" status="done" />);
    const edge = host.querySelector("[data-slot='workflow-edge']")!;
    expect(edge.getAttribute("data-status")).toBe("done");
    expect(edge.getAttribute("data-status-class")).toBe("ok");
    expect(edge.querySelector(".sui-canvas-edge-dot")).not.toBeNull();
    expect(edge.textContent).toContain("plan");
    expect(edge.textContent).toContain("build");
    expect(edge.textContent).toContain("depends on");
  });
});

describe("WorkflowConnection", () => {
  test("defaults to pending and carries the connection state", async () => {
    const host = await render(<WorkflowConnection />);
    expect(host.querySelector("[data-slot='workflow-connection']")!.getAttribute("data-status")).toBe("pending");
  });

  test("accepts valid and invalid states", async () => {
    const host = await render(
      <>
        <WorkflowConnection status="valid" />
        <WorkflowConnection status="invalid" />
      </>,
    );
    const statuses = [...host.querySelectorAll("[data-slot='workflow-connection']")].map((el) =>
      el.getAttribute("data-status"),
    );
    expect(statuses).toEqual(["valid", "invalid"]);
  });
});

describe("WorkflowControls", () => {
  test("renders a toolbar with buttons only for the provided callbacks", async () => {
    const calls: string[] = [];
    const host = await render(
      <WorkflowControls onZoomIn={() => calls.push("in")} onFitView={() => calls.push("fit")} />,
    );
    const toolbar = host.querySelector("[data-slot='workflow-controls']")!;
    expect(toolbar.getAttribute("role")).toBe("toolbar");
    expect(toolbar.getAttribute("aria-label")).toBe("Canvas controls");
    const buttons = [...toolbar.querySelectorAll("button")];
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual(["Zoom in", "Fit view"]);
    for (const button of buttons) {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }
    expect(calls).toEqual(["in", "fit"]);
  });

  test("renders children as extra controls", async () => {
    const host = await render(
      <WorkflowControls>
        <button type="button">custom</button>
      </WorkflowControls>,
    );
    expect(host.querySelector("[data-slot='workflow-controls']")!.textContent).toContain("custom");
  });
});

describe("WorkflowPanel", () => {
  test("positions the overlay slot via data-position", async () => {
    const host = await render(
      <>
        <WorkflowPanel>a</WorkflowPanel>
        <WorkflowPanel position="bottom-right">b</WorkflowPanel>
      </>,
    );
    const panels = [...host.querySelectorAll("[data-slot='workflow-panel']")];
    expect(panels[0]!.getAttribute("data-position")).toBe("top-left");
    expect(panels[1]!.getAttribute("data-position")).toBe("bottom-right");
  });
});

describe("WorkflowToolbar", () => {
  test("renders a toolbar landmark", async () => {
    const host = await render(<WorkflowToolbar>tools</WorkflowToolbar>);
    const toolbar = host.querySelector("[data-slot='workflow-toolbar']")!;
    expect(toolbar.getAttribute("role")).toBe("toolbar");
    expect(toolbar.textContent).toContain("tools");
  });
});

describe("WorkflowMinimap", () => {
  test("renders a labelled seam frame the renderer can park a minimap inside", async () => {
    const host = await render(<WorkflowMinimap>map</WorkflowMinimap>);
    const minimap = host.querySelector("[data-slot='workflow-minimap']")!;
    expect(minimap.getAttribute("aria-label")).toBe("Workflow minimap");
    expect(minimap.textContent).toContain("map");
  });
});
