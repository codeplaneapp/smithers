import { create } from "zustand";
import type { Surface } from "./Surface";

/** The top-level views. `home` is the dashboard landing at `/`. */
export type View = "home" | "store" | "notFound";

export type RouteState = {
  view: View;
  /** The focused canvas surface, when a `/runs/...` route is active. */
  surface: Surface | null;
  /** The selected project, carried as a root search param. */
  project: string | undefined;
};

/**
 * The `url` medium read surface. Its sole writer is the router subscription set
 * up by `bindRouteStore`; components read it like any store and never touch the
 * router directly. Navigation actions write the URL, the subscription writes
 * here, so there is no second source of truth and no loop.
 */
export const useRouteStore = create<RouteState>(() => ({
  view: "home",
  surface: null,
  project: undefined,
}));
