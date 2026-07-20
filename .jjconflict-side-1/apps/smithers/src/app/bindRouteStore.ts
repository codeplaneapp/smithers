import type { AnyRouter } from "@tanstack/react-router";
import { deriveRoute } from "./deriveRoute";
import { useRouteStore } from "./routeStore";

/**
 * Wire the router into the route store: seed the initial state, then update it on
 * every resolved navigation. This subscription is the route store's only writer.
 * Called once from main, before the app renders, so the first paint already has
 * the right view.
 */
export function bindRouteStore(router: AnyRouter): void {
  const apply = (): void => {
    // `state.location` is the resolved location once the router has loaded;
    // `latestLocation` is always parsed and available for the pre-mount seed.
    const location = router.state.location ?? router.latestLocation;
    if (!location) {
      return;
    }
    useRouteStore.setState(
      deriveRoute(location.pathname, location.search as Record<string, unknown>),
    );
  };
  apply();
  router.subscribe("onResolved", apply);
}
