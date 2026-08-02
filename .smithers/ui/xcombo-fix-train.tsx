/** @jsxImportSource react */
import { createGatewayReactRoot } from "smthrs/gateway-react";
import { SimpleWorkflowDashboard } from "smthrs/gateway-ui";

createGatewayReactRoot(
  <SimpleWorkflowDashboard
    workflow="xcombo-fix-train"
    title="Xcombo Fix Train: Sol fixes, Opus reviews, Sol+Fable final polish"
  />,
);
