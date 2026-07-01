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
  useUiStore
    .getState()
    .setNavDir(ORDER[view] >= ORDER[current] ? "forward" : "back");
  void router.navigate({ to: view === "store" ? "/store" : "/" });
}

type SurfaceRoute =
  | { to: "/tickets"; params?: undefined }
  | { to: "/runs"; params?: undefined }
  | { to: "/approvals"; params?: undefined }
  | { to: "/agents"; params?: undefined }
  | { to: "/memory"; params?: undefined }
  | { to: "/files"; params?: undefined }
  | { to: "/prompts"; params?: undefined }
  | { to: "/scores"; params?: undefined }
  | { to: "/crons"; params?: undefined }
  | { to: "/vcs"; params?: undefined }
  | { to: "/workflow/$id"; params: { id: string } }
  | { to: "/palette"; params?: undefined }
  | { to: "/gw/$workflowKey/$runId"; params: { workflowKey: string; runId: string } }
  | { to: "/gw/$workflowKey/$runId/logs"; params: { workflowKey: string; runId: string } }
  | { to: "/gw/$workflowKey/$runId/diff/$diffId"; params: { workflowKey: string; runId: string; diffId: string } }
  | { to: "/gw/$workflowKey/$runId/tickets"; params: { workflowKey: string; runId: string } }
  | { to: "/gw/$workflowKey/$runId/timeline"; params: { workflowKey: string; runId: string } };

function fallbackWorkflowKey(runId: string): string {
  return runId;
}

function gatewayRunRoute(
  workflowKey: string,
  runId: string,
  view: Surface["kind"] | NonNullable<Extract<Surface, { kind: "gatewayRun" }>["view"]>,
  diffId?: string,
): SurfaceRoute {
  switch (view) {
    case "logs":
      return { to: "/gw/$workflowKey/$runId/logs", params: { workflowKey, runId } };
    case "diff":
      return {
        to: "/gw/$workflowKey/$runId/diff/$diffId",
        params: { workflowKey, runId, diffId: diffId ?? "root" },
      };
    case "tickets":
      return { to: "/gw/$workflowKey/$runId/tickets", params: { workflowKey, runId } };
    case "timeline":
      return { to: "/gw/$workflowKey/$runId/timeline", params: { workflowKey, runId } };
    default:
      return { to: "/gw/$workflowKey/$runId", params: { workflowKey, runId } };
  }
}

export function surfaceToRoute(surface: Surface): SurfaceRoute {
  switch (surface.kind) {
    case "inspector":
      return gatewayRunRoute(fallbackWorkflowKey(surface.runId), surface.runId, "inspector");
    case "logs":
      return gatewayRunRoute(fallbackWorkflowKey(surface.runId), surface.runId, "logs");
    case "diff":
      return gatewayRunRoute(fallbackWorkflowKey(surface.runId), surface.runId, "diff", surface.diffId);
    case "timeline":
      return gatewayRunRoute(fallbackWorkflowKey(surface.runId), surface.runId, "timeline");
    case "gatewayRun":
      return gatewayRunRoute(
        surface.workflowKey,
        surface.runId,
        surface.view ?? "inspector",
        surface.diffId,
      );
    case "tickets":
      return { to: "/tickets" };
    case "runs":
      return { to: "/runs" };
    case "approvals":
      return { to: "/approvals" };
    case "agents":
      return { to: "/agents" };
    case "memory":
      return { to: "/memory" };
    case "files":
      return { to: "/files" };
    case "prompts":
      return { to: "/prompts" };
    case "scores":
      return { to: "/scores" };
    case "crons":
      return { to: "/crons" };
    case "vcs":
      return { to: "/vcs" };
    case "workflowEditor":
      return { to: "/workflow/$id", params: { id: surface.id } };
    case "palette":
      return { to: "/palette" };
  }
}

/**
 * Open a canvas surface. The shell forces the sidebar layout whenever a surface
 * route is active, so this only navigates — it never mutates the layout
 * preference.
 */
export function openSurface(surface: Surface): void {
  void router.navigate(surfaceToRoute(surface));
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

/** Select a local workspace root, carried as a retained root search param. */
export function setWorkspaceRootSearchParam(workspaceRoot: string): void {
  const search = router.state.location.search as Record<string, unknown>;
  void router.navigate({
    to: ".",
    search: { ...search, workspace: workspaceRoot },
  });
}
