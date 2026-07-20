import { goToView, openSurface } from "../app/navigation";
import { getApp } from "./appCatalog";
import type { AppId } from "./App";

/**
 * Focus an app by navigating to its target. The dock registration happens
 * through the route binding once navigation resolves, so opening and focusing an
 * app are the same call. Components dispatch this instead of touching the router.
 */
export function openApp(id: AppId): void {
  const app = getApp(id);
  if (!app) return;
  if (app.target.kind === "surface") {
    openSurface(app.target.surface);
    return;
  }
  goToView(app.target.view);
}
