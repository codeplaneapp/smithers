import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "../app/rootRoute";
import { LogsCanvas } from "../logs/LogsCanvas";

/** The run transcript surface (`/runs/$runId/logs`). */
function RunLogsPage() {
  return <LogsCanvas />;
}

export const runLogsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/runs/$runId/logs",
  component: RunLogsPage,
});
