import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "../app/rootRoute";
import { TicketsCanvas } from "./TicketsCanvas";

/** The Tickets surface (`/tickets`). A top-level surface, not run-scoped. */
function TicketsPage() {
  return <TicketsCanvas />;
}

export const runTicketsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tickets",
  component: TicketsPage,
});
