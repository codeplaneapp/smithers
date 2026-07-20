import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "../app/rootRoute";
import { MemoryCanvas } from "./MemoryCanvas";

/** The Memory surface (`/memory`). A top-level surface, not run-scoped. */
function MemoryPage() {
  return <MemoryCanvas />;
}

export const memoryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/memory",
  component: MemoryPage,
});
