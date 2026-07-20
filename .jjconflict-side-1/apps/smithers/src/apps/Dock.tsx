import type { CSSProperties } from "react";
import { closeSurface } from "../app/navigation";
import { useRouteStore } from "../app/routeStore";
import { activeAppId, getApp } from "./appCatalog";
import type { App, AppId } from "./App";
import { useDockStore } from "./dockStore";
import { openApp } from "./openApp";
import "./dock.css";

/**
 * The bottom app dock: an icon tile per open app, macOS-style. It auto-hides and
 * slides up when the pointer reaches the bottom edge (the trigger strip) or a
 * tile takes keyboard focus. Clicking a tile focuses the app; the hover close
 * button removes it from the dock. The active app (derived from the URL) is
 * highlighted. Renders nothing until at least one app is open. See
 * `.smithers/specs/apps-and-workflows-dock.md`.
 */
export function Dock() {
  const openAppIds = useDockStore((state) => state.openAppIds);
  const closeApp = useDockStore((state) => state.closeApp);
  const view = useRouteStore((state) => state.view);
  const surface = useRouteStore((state) => state.surface);

  const active = activeAppId({ view, surface });
  // Skip ids that no longer resolve, so a catalog change can't strand a
  // persisted dock entry.
  const apps = openAppIds
    .map(getApp)
    .filter((app): app is App => app !== undefined);

  if (apps.length === 0) {
    return null;
  }

  const handleClose = (id: AppId): void => {
    const remaining = openAppIds.filter((openId) => openId !== id);
    closeApp(id);
    if (id !== active) {
      return;
    }
    // Closing the focused app: fall back to the most recent remaining app, or
    // home when the dock is now empty.
    const next = remaining[remaining.length - 1];
    if (next) {
      openApp(next);
    } else {
      closeSurface();
    }
  };

  return (
    <div className="app-dock-zone">
      {/* The thin bottom-edge hotzone that reveals the auto-hidden dock. */}
      <div className="app-dock-trigger" aria-hidden="true" />
      <div className="app-dock" role="toolbar" aria-orientation="horizontal" aria-label="Open apps">
        {apps.map((app) => (
          <div
            key={app.id}
            className="app-dock-item"
            data-active={app.id === active}
            style={{ "--app-color": app.color } as CSSProperties}
          >
            <button
              className="app-dock-tile"
              type="button"
              title={app.name}
              aria-label={app.name}
              aria-current={app.id === active ? "true" : undefined}
              onClick={() => openApp(app.id)}
            >
              <span aria-hidden="true">{app.icon}</span>
            </button>
            <button
              className="app-dock-close"
              type="button"
              aria-label={`Close ${app.name}`}
              onClick={() => handleClose(app.id)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
