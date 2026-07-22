/** @jsxImportSource react */
import { createGatewayReactRoot } from "smithers-orchestrator/gateway-react";
import { SimpleWorkflowDashboard } from "smithers-orchestrator/gateway-ui";

createGatewayReactRoot(<SimpleWorkflowDashboard workflow="agui-adopt-product-fix" title="adopt-product Fix Round" />);
