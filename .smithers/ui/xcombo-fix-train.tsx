/** @jsxImportSource react */
import { createGatewayReactRoot } from "smithers-orchestrator/gateway-react";
import { SimpleWorkflowDashboard } from "smithers-orchestrator/gateway-ui";

createGatewayReactRoot(
  <SimpleWorkflowDashboard
    workflow="xcombo-fix-train"
    title="Xcombo Fix Train: Sol fixes, Opus reviews, Sol+Fable final polish"
  />,
);
