import { createRoute } from "@tanstack/react-router";
import { WorkflowStore } from "../store/WorkflowStore";
import { rootRoute } from "./rootRoute";

/**
 * The home page (`/`). The local UI's landing is the workflow launcher — the
 * live set of workflows registered on your gateway, ready to run. Every other
 * surface (runs, approvals, memory, …) is one click away in the nav sidebar.
 */
function HomePage() {
  return <WorkflowStore />;
}

export const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: HomePage,
});
