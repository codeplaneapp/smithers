import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "../app/rootRoute";
import { CronsCanvas } from "./CronsCanvas";

/** The Triggers / Crons surface (`/crons`). A top-level surface, not run-scoped. */
function CronsPage() {
  return <CronsCanvas />;
}

export const cronsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/crons",
  component: CronsPage,
});
