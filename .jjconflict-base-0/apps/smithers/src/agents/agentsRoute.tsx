import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "../app/rootRoute";
import { AgentsCanvas } from "./AgentsCanvas";

/** The Agents registry surface (`/agents`). A top-level surface, not run-scoped. */
function AgentsPage() {
  return <AgentsCanvas />;
}

export const agentsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/agents",
  component: AgentsPage,
});
