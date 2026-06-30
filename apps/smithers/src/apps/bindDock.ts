import { useRouteStore } from "../app/routeStore";
import { activeAppId } from "./appCatalog";
import { useDockStore } from "./dockStore";

/**
 * Wire the route store into the dock: whenever the active route resolves to an
 * app, register it so the dock auto-populates as the user navigates (by card,
 * slash, nav menu, or dock click). Called once from main, after bindRouteStore,
 * so the first resolved route already docks its app.
 */
export function bindDock(): void {
  const apply = (): void => {
    const id = activeAppId(useRouteStore.getState());
    if (id) {
      useDockStore.getState().registerActive(id);
    }
  };
  apply();
  useRouteStore.subscribe(apply);
}
