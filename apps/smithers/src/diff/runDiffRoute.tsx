import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "../app/rootRoute";
import { DiffCanvas } from "./DiffCanvas";

/** The diff review surface (`/runs/$runId/diff/$diffId`). */
function RunDiffPage() {
  return <DiffCanvas />;
}

export const runDiffRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/runs/$runId/diff/$diffId",
  component: RunDiffPage,
});
