import { createRootRoute, retainSearchParams } from "@tanstack/react-router";
import { AppShell } from "./AppShell";

export type RootSearch = { project?: string };

/**
 * The layout route. It renders the shell chrome (nav sidebar, toasts) and an
 * <Outlet/> for the active page. `project` is validated here and retained across
 * every navigation, which makes it a `url`-medium slice of the route store.
 */
export const rootRoute = createRootRoute({
  validateSearch: (search: Record<string, unknown>): RootSearch => ({
    project: typeof search.project === "string" ? search.project : undefined,
  }),
  search: { middlewares: [retainSearchParams(["project"])] },
  component: AppShell,
});
