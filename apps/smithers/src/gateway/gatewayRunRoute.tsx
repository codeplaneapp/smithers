import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "../app/rootRoute";
import { GatewayRunInspector } from "./GatewayRunInspector";

/**
 * A gateway-backed run inspector (`/gw/$workflowKey/$runId`). Distinct from the
 * local-engine inspector at `/runs/$runId`: this surface drives a real run on a
 * connected gateway and can embed the workflow's own custom UI. Mounting the
 * inspector starts the run-tree subscription; unmounting tears it down.
 */
function GatewayRunPage() {
  const { workflowKey, runId } = gatewayRunRoute.useParams();
  return <GatewayRunInspector workflowKey={workflowKey} runId={runId} />;
}

export const gatewayRunRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/gw/$workflowKey/$runId",
  component: GatewayRunPage,
});
