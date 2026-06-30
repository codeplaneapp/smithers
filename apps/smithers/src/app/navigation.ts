import { router } from "./router";
import { useRouteStore, type View } from "./routeStore";
import type { Surface } from "./Surface";
import { useUiStore } from "./uiStore";

/** Left-to-right order of the views, for the slide-direction hint. */
const ORDER: Record<View, number> = {
  home: 0,
  store: 1,
  notFound: 0,
};

/**
 * The typed write-path for `url`-medium state. These are the flux actions over
 * the router: components dispatch them, the router resolves, and the route store
 * updates through its subscription. No component calls `router.navigate` itself.
 */
export function goToView(view: View): void {
  const current = useRouteStore.getState().view;
  useUiStore.getState().setNavDir(ORDER[view] >= ORDER[current] ? "forward" : "back");
  void router.navigate({ to: view === "store" ? "/store" : "/" });
}

/**
 * Open a canvas surface. The shell forces the sidebar layout whenever a surface
 * route is active, so this only navigates — it never mutates the layout
 * preference.
 */
export function openSurface(surface: Surface): void {
  switch (surface.kind) {
    case "inspector":
      void router.navigate({ to: "/runs/$runId", params: { runId: surface.runId } });
      return;
    case "logs":
      void router.navigate({ to: "/runs/$runId/logs", params: { runId: surface.runId } });
      return;
    case "diff":
      void router.navigate({
        to: "/runs/$runId/diff/$diffId",
        params: { runId: surface.runId, diffId: surface.diffId },
      });
      return;
    case "timeline":
      void router.navigate({ to: "/runs/$runId/timeline", params: { runId: surface.runId } });
      return;
    case "tickets":
      void router.navigate({ to: "/tickets" });
      return;
    case "runs":
      void router.navigate({ to: "/runs" });
      return;
    case "approvals":
      void router.navigate({ to: "/approvals" });
      return;
    case "agents":
      void router.navigate({ to: "/agents" });
      return;
    case "memory":
      void router.navigate({ to: "/memory" });
      return;
    case "prompts":
      void router.navigate({ to: "/prompts" });
      return;
    case "scores":
      void router.navigate({ to: "/scores" });
      return;
    case "crons":
      void router.navigate({ to: "/crons" });
      return;
    case "workflowEditor":
      void router.navigate({ to: "/workflow/$id", params: { id: surface.id } });
      return;
    case "palette":
      void router.navigate({ to: "/palette" });
      return;
    case "gatewayRun":
      void router.navigate({
        to: "/gw/$workflowKey/$runId",
        params: { workflowKey: surface.workflowKey, runId: surface.runId },
      });
      return;
  }
}

/** Close the canvas surface, returning to the dashboard. */
export function closeSurface(): void {
  void router.navigate({ to: "/" });
}

/** Select a project, carried as a retained root search param. */
export function setProject(project: string): void {
  const search = router.state.location.search as Record<string, unknown>;
  void router.navigate({ to: ".", search: { ...search, project } });
}
