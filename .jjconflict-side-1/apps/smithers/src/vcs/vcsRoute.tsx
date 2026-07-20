import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "../app/rootRoute";
import { VcsCanvas } from "./VcsCanvas";

function VcsPage() {
  return <VcsCanvas />;
}

export const vcsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/vcs",
  component: VcsPage,
});
