/** @jsxImportSource react */
import { createGatewayReactRoot } from "smithers-orchestrator/gateway-react";
import { SimpleWorkflowDashboard } from "smithers-orchestrator/gateway-ui";

createGatewayReactRoot(
  <SimpleWorkflowDashboard workflow="converge-agentic-ui-library" title="Converge Agentic UI Library" />,
);
