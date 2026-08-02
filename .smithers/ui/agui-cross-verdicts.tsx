/** @jsxImportSource react */
import { createGatewayReactRoot } from "smthrs/gateway-react";
import { SimpleWorkflowDashboard } from "smthrs/gateway-ui";

createGatewayReactRoot(
  <SimpleWorkflowDashboard workflow="agui-cross-verdicts" title="Agentic UI Cross-Seat Verdicts" />,
);
