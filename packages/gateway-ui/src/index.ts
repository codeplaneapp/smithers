/**
 * @smithers-orchestrator/gateway-ui
 *
 * Reusable React components for Smithers Gateway UIs, built on the
 * `@smithers-orchestrator/gateway-react` hooks. Drop them into a custom workflow
 * UI under `.smithers/ui/<workflow>.tsx` (mounted with `createGatewayReactRoot`)
 * to assemble a run dashboard in minutes instead of wiring hooks by hand.
 *
 * Every component is self-styled with inline styles (no `.css` import) so it
 * bundles cleanly through the gateway's `Bun.build`, and every component accepts
 * `className` + `style` to override.
 *
 * @example
 * import { createGatewayReactRoot } from "smithers-orchestrator/gateway-react";
 * import { RunList, RunTree, ApprovalPanel } from "smithers-orchestrator/gateway-ui";
 * import { useState } from "react";
 *
 * function App() {
 *   const [runId, setRunId] = useState<string>();
 *   return (
 *     <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
 *       <RunList filter={{ workflow: "implement" }} activeRunId={runId} onSelect={setRunId} />
 *       <RunTree runId={runId} />
 *       <ApprovalPanel filter={{ workflow: "implement" }} />
 *     </div>
 *   );
 * }
 * createGatewayReactRoot(<App />);
 */
export {
  theme,
  statusColor,
  statusColors,
  normalizeStatus,
  statusClass,
  formatStatus,
  isTerminalRunStatus,
} from "./theme";
export {
  WorkflowUiStyles,
  WorkflowUiShell,
  composeWorkflowUiStyles,
  workflowUiThemeCss,
  workflowUiLayoutCss,
  workflowUiStyles,
  type WorkflowUiStylesProps,
  type WorkflowUiShellProps,
} from "./styleguide";
export {
  SimpleWorkflowDashboard,
  type SimpleWorkflowDashboardProps,
  type SimpleWorkflowRun,
} from "./SimpleWorkflowDashboard";
export { StatusPill, type StatusPillProps } from "./StatusPill";
export { ConnectionBadge, type ConnectionBadgeProps } from "./ConnectionBadge";
export { RunList, type RunListProps } from "./RunList";
export { RunEventLog, type RunEventLogProps } from "./RunEventLog";
export { RunTree, type RunTreeProps } from "./RunTree";
export { ApprovalPanel, type ApprovalPanelProps } from "./ApprovalPanel";
export { LaunchButton, type LaunchButtonProps } from "./LaunchButton";
export { WorkflowPicker, type WorkflowPickerProps } from "./WorkflowPicker";
export {
  NodeOutputView,
  formatOutput,
  unwrapNodeOutput,
  type NodeOutputViewProps,
  type NodeOutputStatus,
  type UnwrappedNodeOutput,
} from "./NodeOutputView";
export {
  NodeOutputCard,
  type NodeOutputCardProps,
  type NodeOutputCardBody,
  type NodeOutputCardBodyState,
} from "./NodeOutputCard";
