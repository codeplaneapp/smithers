import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "../app/rootRoute";
import { WorkflowEditorCanvas } from "./WorkflowEditorCanvas";
import { useWorkflowEditorStore } from "./workflowEditorStore";

/**
 * The workflow editor surface (`/workflow/$id`). A top-level surface keyed by the
 * workflow id. The route page reconciles the param into the store's selection via
 * `setRoute` (a no-op when already in sync) before rendering the canvas, keeping
 * the URL the source of truth without a useEffect. The page does not subscribe to
 * the editor store, so calling the setter here does not update-while-rendering.
 */
function WorkflowEditorPage() {
  const { id } = workflowEditorRoute.useParams();
  useWorkflowEditorStore.getState().setRoute(id);
  return <WorkflowEditorCanvas id={id} />;
}

export const workflowEditorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/workflow/$id",
  component: WorkflowEditorPage,
});
