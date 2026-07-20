import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "../app/rootRoute";
import { PromptsCanvas } from "./PromptsCanvas";

/** The prompts EDITOR surface (`/prompts`). A top-level surface, not run-scoped. */
function PromptsPage() {
  return <PromptsCanvas />;
}

export const promptsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/prompts",
  component: PromptsPage,
});
