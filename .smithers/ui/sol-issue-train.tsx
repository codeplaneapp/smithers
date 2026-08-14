/** @jsxImportSource react */
import { createGatewayReactRoot } from "smthrs/gateway-react";
import { SimpleWorkflowDashboard } from "smthrs/gateway-ui";

createGatewayReactRoot(
  <SimpleWorkflowDashboard
    workflow="sol-issue-train"
    title="Sol Issue Train: oldest-first fixes, codex review to LGTM, blocked issues filed to ops"
  />,
);
