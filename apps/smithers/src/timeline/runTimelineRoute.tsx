import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "../app/rootRoute";
import { TimelineCanvas } from "./TimelineCanvas";

/** The time-travel surface (`/runs/$runId/timeline`). */
function RunTimelinePage() {
  const { runId } = runTimelineRoute.useParams();
  return <TimelineCanvas runId={runId} />;
}

export const runTimelineRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/runs/$runId/timeline",
  component: RunTimelinePage,
});
