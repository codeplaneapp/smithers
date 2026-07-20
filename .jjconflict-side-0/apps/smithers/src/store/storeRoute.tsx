import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "../app/rootRoute";
import { WorkflowStore } from "./WorkflowStore";

/** The Store page (`/store`): the browsable workflow catalog. */
function StorePage() {
  return <WorkflowStore />;
}

export const storeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/store",
  component: StorePage,
});
