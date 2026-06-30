import { createRoute } from "@tanstack/react-router";
import { usePreferencesStore } from "../app/preferencesStore";
import { rootRoute } from "../app/rootRoute";
import { RunInspector } from "./RunInspector";

/** The run inspector surface (`/runs/$runId`). */
function RunInspectorPage() {
  const { runId } = runInspectorRoute.useParams();
  const theme = usePreferencesStore((state) => state.theme);
  return <RunInspector runId={runId} theme={theme} />;
}

export const runInspectorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/runs/$runId",
  component: RunInspectorPage,
});
