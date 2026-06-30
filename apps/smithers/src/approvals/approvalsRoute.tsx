import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "../app/rootRoute";
import { ApprovalsCanvas } from "./ApprovalsCanvas";

/** The Approvals surface (`/approvals`). A top-level surface, not run-scoped. */
function ApprovalsPage() {
  return <ApprovalsCanvas />;
}

export const approvalsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/approvals",
  component: ApprovalsPage,
});
