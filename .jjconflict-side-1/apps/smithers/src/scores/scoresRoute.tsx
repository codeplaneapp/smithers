import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "../app/rootRoute";
import { ScoresCanvas } from "./ScoresCanvas";

/** The scores surface (`/scores`). A top-level surface, not run-scoped. */
function ScoresPage() {
  return <ScoresCanvas />;
}

export const scoresRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/scores",
  component: ScoresPage,
});
