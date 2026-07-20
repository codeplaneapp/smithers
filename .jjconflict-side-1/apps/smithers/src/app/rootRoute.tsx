import { createRootRoute, retainSearchParams } from "@tanstack/react-router";
import { AppShell } from "./AppShell";

export type RootSearch = { project?: string; workspace?: string };

/**
 * The layout route. It renders the shell chrome (nav sidebar, toasts) and an
 * <Outlet/> for the active page. `workspace` is the local workspace root and is
 * retained across every navigation, which makes it a `url`-medium slice of the
 * route store.
 */
export const rootRoute = createRootRoute({
  validateSearch: (search: Record<string, unknown>): RootSearch => ({
    project: typeof search.project === "string" ? search.project : undefined,
    workspace: typeof search.workspace === "string" ? search.workspace : undefined,
  }),
  search: { middlewares: [retainSearchParams(["project", "workspace"])] },
  component: AppShell,
});
