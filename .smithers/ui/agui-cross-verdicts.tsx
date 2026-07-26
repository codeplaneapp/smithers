/** @jsxImportSource react */
import { createGatewayReactRoot } from "smithers-orchestrator/gateway-react";
import { SimpleWorkflowDashboard } from "smithers-orchestrator/gateway-ui";

createGatewayReactRoot(
  <SimpleWorkflowDashboard workflow="agui-cross-verdicts" title="Agentic UI Cross-Seat Verdicts" />,
);
