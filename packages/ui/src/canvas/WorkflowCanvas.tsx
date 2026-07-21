/** @jsxImportSource react */
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../cn";
import { Badge } from "../badge";
import { StatusPill } from "../status-pill";
import { statusClass } from "../status";
import { useInjectUiCss } from "../styles";
import { useInjectLaneCss } from "../internal/useInjectLaneCss";
import { canvasCss, WORKFLOW_CANVAS_CSS_ID } from "./canvasCss";

/**
 * Renderer-neutral workflow canvas anatomy: the visual language a graph
 * renderer (e.g. the gateway-ui ReactFlow layer) composes into its node/edge
 * renderers. Purely presentational and props-driven — `@xyflow/react` never
 * enters this package. Geometry, pan/zoom, and selection behavior belong to
 * the renderer; these parts cover cards, legends, and overlay chrome only.
 */

function useCanvasCss(): void {
  useInjectUiCss();
  useInjectLaneCss(WORKFLOW_CANVAS_CSS_ID, canvasCss);
}

export type WorkflowCanvasProps = ComponentProps<"div">;

/**
 * The labelled region a renderer paints its canvas into. `role="group"` (not
 * `role="application"`: no application-mode keyboard contract exists at this
 * layer — pan/zoom/selection keys are the renderer's model).
 */
export function WorkflowCanvas({
  className,
  role,
  "aria-label": ariaLabel,
  children,
  ...props
}: WorkflowCanvasProps) {
  useCanvasCss();
  return (
    <div
      data-slot="workflow-canvas"
      role={role ?? "group"}
      aria-label={ariaLabel ?? "Workflow canvas"}
      className={cn("sui-canvas", className)}
      {...props}
    >
      {children}
    </div>
  );
}

export type WorkflowNodeProps = Omit<ComponentProps<"div">, "children" | "title"> & {
  /** Card title; renders in the header row. */
  title?: ReactNode;
  /** Run/node status string, rendered as a StatusPill. */
  status?: string;
  /** Node kind discriminator (e.g. "agent", "approval"), rendered as a Badge. */
  kind?: string;
  /** Selected ring (data-selected), driven by the renderer's selection state. */
  selected?: boolean;
  children?: ReactNode;
};

/**
 * One node card. With `title`/`kind`/`status` props it renders its own header
 * row; children render verbatim after it (or compose WorkflowNodeHeader /
 * WorkflowNodeContent directly and pass no header props). Renderer handles
 * (ReactFlow `<Handle>`s) are passed as children by the renderer.
 */
export function WorkflowNode({
  title,
  status,
  kind,
  selected,
  className,
  children,
  ...props
}: WorkflowNodeProps) {
  useCanvasCss();
  const hasHeader = title != null || kind !== undefined || status !== undefined;
  return (
    <div
      data-slot="workflow-node"
      data-status={status}
      data-kind={kind}
      data-selected={selected ? "true" : "false"}
      className={cn("sui-canvas-node", className)}
      {...props}
    >
      {hasHeader ? (
        <WorkflowNodeHeader>
          {kind !== undefined ? (
            <Badge variant="muted" className="sui-canvas-node-kind">
              {kind}
            </Badge>
          ) : null}
          {title != null ? <span className="sui-canvas-node-title">{title}</span> : null}
          {status !== undefined ? <WorkflowNodeStatus status={status} /> : null}
        </WorkflowNodeHeader>
      ) : null}
      {children}
    </div>
  );
}

export function WorkflowNodeHeader({ className, ...props }: ComponentProps<"div">) {
  useCanvasCss();
  return (
    <div
      data-slot="workflow-node-header"
      className={cn("sui-canvas-node-header", className)}
      {...props}
    />
  );
}

export function WorkflowNodeContent({ className, ...props }: ComponentProps<"div">) {
  useCanvasCss();
  return (
    <div
      data-slot="workflow-node-content"
      className={cn("sui-canvas-node-content", className)}
      {...props}
    />
  );
}

export type WorkflowNodeStatusProps = Omit<ComponentProps<"span">, "children"> & {
  /** Any status string; piped through the shared status vocabulary. */
  status: string;
};

export function WorkflowNodeStatus({ status, className, ...props }: WorkflowNodeStatusProps) {
  useCanvasCss();
  return (
    <StatusPill
      status={status}
      data-slot="workflow-node-status"
      className={cn("sui-canvas-node-status", className)}
      {...props}
    />
  );
}

export type WorkflowEdgeProps = Omit<ComponentProps<"span">, "children"> & {
  /** Source node id/label. */
  from?: string;
  /** Target node id/label. */
  to?: string;
  /** Optional edge label (e.g. a condition). */
  label?: ReactNode;
  /** Edge status; colors the leading dot via the shared status classes. */
  status?: string;
};

/**
 * The legend/inline representation of an edge (`from → to` with an optional
 * label and status dot). Drawing the edge geometry is the renderer's job.
 */
export function WorkflowEdge({ from, to, label, status, className, ...props }: WorkflowEdgeProps) {
  useCanvasCss();
  return (
    <span
      data-slot="workflow-edge"
      data-status={status}
      data-status-class={status !== undefined ? statusClass(status) : undefined}
      className={cn("sui-canvas-edge", className)}
      {...props}
    >
      {status !== undefined ? <span aria-hidden className="sui-canvas-edge-dot" /> : null}
      {from !== undefined ? <span className="sui-canvas-edge-end">{from}</span> : null}
      {from !== undefined && to !== undefined ? (
        <span aria-hidden className="sui-canvas-edge-arrow">
          →
        </span>
      ) : null}
      {to !== undefined ? <span className="sui-canvas-edge-end">{to}</span> : null}
      {label != null ? <span className="sui-canvas-edge-label">{label}</span> : null}
    </span>
  );
}

export type WorkflowConnectionProps = Omit<ComponentProps<"span">, "children"> & {
  /** Pending-connection validity, as reported by the renderer. */
  status?: "valid" | "invalid" | "pending";
};

/**
 * The legend/inline representation of an in-progress connection drag. The
 * live drag line itself is painted by the renderer.
 */
export function WorkflowConnection({ status = "pending", className, ...props }: WorkflowConnectionProps) {
  useCanvasCss();
  return (
    <span
      data-slot="workflow-connection"
      data-status={status}
      aria-hidden
      className={cn("sui-canvas-connection", className)}
      {...props}
    />
  );
}

export type WorkflowControlsProps = Omit<ComponentProps<"div">, "children"> & {
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onFitView?: () => void;
  children?: ReactNode;
};

/**
 * Zoom/fit control cluster. Each button renders only when its callback is
 * provided; the actual zoom behavior lives in the renderer, which wires these
 * callbacks to its viewport API.
 */
export function WorkflowControls({
  onZoomIn,
  onZoomOut,
  onFitView,
  className,
  children,
  ...props
}: WorkflowControlsProps) {
  useCanvasCss();
  return (
    <div
      data-slot="workflow-controls"
      role="toolbar"
      aria-label="Canvas controls"
      className={cn("sui-canvas-controls", className)}
      {...props}
    >
      {onZoomIn ? (
        <button
          type="button"
          aria-label="Zoom in"
          className="sui-canvas-controls-button"
          onClick={onZoomIn}
        >
          <span aria-hidden>+</span>
        </button>
      ) : null}
      {onZoomOut ? (
        <button
          type="button"
          aria-label="Zoom out"
          className="sui-canvas-controls-button"
          onClick={onZoomOut}
        >
          <span aria-hidden>−</span>
        </button>
      ) : null}
      {onFitView ? (
        <button
          type="button"
          aria-label="Fit view"
          className="sui-canvas-controls-button"
          onClick={onFitView}
        >
          <span aria-hidden>⤢</span>
        </button>
      ) : null}
      {children}
    </div>
  );
}

export type WorkflowPanelProps = ComponentProps<"div"> & {
  /** Canvas corner the overlay anchors to. */
  position?: "top-left" | "top-right" | "bottom-left" | "bottom-right";
};

/** Positioned overlay slot for canvas chrome (controls, legends, panels). */
export function WorkflowPanel({ position = "top-left", className, ...props }: WorkflowPanelProps) {
  useCanvasCss();
  return (
    <div
      data-slot="workflow-panel"
      data-position={position}
      className={cn("sui-canvas-panel", className)}
      {...props}
    />
  );
}

export function WorkflowToolbar({ className, role, "aria-label": ariaLabel, ...props }: ComponentProps<"div">) {
  useCanvasCss();
  return (
    <div
      data-slot="workflow-toolbar"
      role={role ?? "toolbar"}
      aria-label={ariaLabel ?? "Workflow toolbar"}
      className={cn("sui-canvas-toolbar", className)}
      {...props}
    />
  );
}

/**
 * Minimap seam frame. The base anatomy only provides the labelled frame; the
 * renderer parks its own MiniMap widget inside.
 */
export function WorkflowMinimap({ className, "aria-label": ariaLabel, ...props }: ComponentProps<"div">) {
  useCanvasCss();
  return (
    <div
      data-slot="workflow-minimap"
      aria-label={ariaLabel ?? "Workflow minimap"}
      className={cn("sui-canvas-minimap", className)}
      {...props}
    />
  );
}
