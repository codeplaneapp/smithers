import { OPENABLE_VIEWS, useChatStore } from "./chatStore";
import type { OpenableView } from "./chatStore";
import { useOverlayStore } from "./overlay/overlayStore";
import type { Overlay } from "./overlay/Overlay";
import { dashboardForView } from "./overlay/dashboard/dashboardForView";

/**
 * The "Views ▾" dropdown — the only manual navigator besides the slash palette
 * (the spaceship sidebar is gone). Lists openable surfaces (Runs, Memory,
 * Scores, Search, History, Settings); selecting one opens it in the
 * overlay/split host. The same surfaces are openable by the agent via a tool.
 */
export function ViewsMenu() {
  const viewsMenuOpen = useChatStore((s) => s.viewsMenuOpen);
  const setViewsMenuOpen = useChatStore((s) => s.setViewsMenuOpen);
  const openOverlay = useOverlayStore((s) => s.open);

  return (
    <div className="views-menu-anchor">
      <button
        aria-expanded={viewsMenuOpen}
        className="topbar-btn"
        data-testid="views-button"
        onClick={() => setViewsMenuOpen(!viewsMenuOpen)}
        type="button"
      >
        Views <span className="topbar-caret">▾</span>
      </button>
      {viewsMenuOpen && (
        <div className="views-menu" data-testid="views-menu" role="menu">
          {OPENABLE_VIEWS.map((view) => (
            <button
              className="views-menu-row"
              data-testid="views-menu-row"
              key={view.label}
              onClick={() => {
                openOverlay(overlayFor(view), "split");
                setViewsMenuOpen(false);
              }}
              role="menuitem"
              type="button"
            >
              {view.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Settings opens the dedicated settings overlay; DevTools opens the real debug
 * surface; the data surfaces (Runs, Memory, Scores, Search, History) open their
 * populated prototype dashboard so the Views menu never lands on a blank surface.
 */
function overlayFor(view: OpenableView): Overlay {
  if (view.kind === "settings") return { kind: "settings", title: view.label };
  if (view.kind === "devtools") return { kind: "surface", title: view.label, surface: view.id };
  const dashboard = dashboardForView(view.id);
  if (dashboard) return { kind: "dashboard", title: view.label, dashboard };
  return { kind: "surface", title: view.label, surface: view.id };
}
