/** @jsxImportSource react */
import { createGatewayReactRoot } from "smithers-orchestrator/gateway-react";
import { SimpleWorkflowDashboard } from "smithers-orchestrator/gateway-ui";

createGatewayReactRoot(
  <SimpleWorkflowDashboard
    workflow="sol-issue-train"
    title="Sol Issue Train: oldest-first fixes, codex review to LGTM, blocked issues filed to ops"
  />,
);
