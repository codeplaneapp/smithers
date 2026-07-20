import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "../app/rootRoute";
import { FilesCanvas } from "./FilesCanvas";

function FilesPage() {
  return <FilesCanvas />;
}

export const filesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/files",
  component: FilesPage,
});
