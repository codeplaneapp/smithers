import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "../app/rootRoute";
import { RunsCanvas } from "./RunsCanvas";

/** The runs LIST surface (`/runs`). A top-level surface, not run-scoped. */
function RunsPage() {
  return <RunsCanvas />;
}

export const runsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/runs",
  component: RunsPage,
});
