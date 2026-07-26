import type { CSSProperties } from "react";
import { Outlet, useRouterState } from "@tanstack/react-router";
import { Dock } from "../apps/Dock";
import { ChatTranscript } from "../chat/ChatTranscript";
import { ComposingCard } from "../chat/ComposingCard";
import { useChatStore } from "../chat/chatStore";
import { PanelLeftIcon } from "../icons/PanelLeftIcon";
import { RAIL_MAX, RAIL_MIN, useRailStore } from "../layout/railStore";
import { Toasts } from "../notifications/Toasts";
import { ControlRing } from "../control/ControlRing";
import { ControlRequestDialog } from "../control/ControlRequestDialog";
import { ComposerBar } from "./ComposerBar";
import { CornerLogo } from "./CornerLogo";
import { WorkspacePicker } from "./WorkspacePicker";
import { deriveAppShellDecision } from "./appShellDecision";
import { usePreferencesStore } from "./preferencesStore";
import { useRouteStore } from "./routeStore";
import { useUiStore } from "./uiStore";
import { useWorkspaceStore } from "./workspaceStore";

/**
 * The application shell for the local UI. It gates the app on a usable local
 * workspace, then hosts the local gateway-backed surfaces and concierge chat.
 */
export function AppShell() {
  const layout = usePreferencesStore((state) => state.layout);
  const toggleLayout = usePreferencesStore((state) => state.toggleLayout);
  const view = useRouteStore((state) => state.view);
  const surface = useRouteStore((state) => state.surface);
  const messagesCount = useChatStore((state) => state.messages.length);
  const navDir = useUiStore((state) => state.navDir);
  const selectedWorkspaceRoot = useWorkspaceStore((state) => state.selectedWorkspaceRoot);
  const ready = useWorkspaceStore((state) => state.status === "ready");
  const clearSelectedWorkspace = useWorkspaceStore((state) => state.clearSelectedWorkspace);
  const rail = useRailStore();

  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const frame = deriveAppShellDecision({
    layout,
    view,
    surface,
    messagesCount,
    pathname,
    pairKeyPresent: false,
  });

  const { effectiveLayout, mode, showTranscript, canvasKey } = frame;

  if (!ready) {
    return <WorkspacePicker />;
  }

  return (
    <main className={rail.resizing ? "app-shell is-resizing" : "app-shell"} data-mode={mode}>
      <Toasts />
      <CornerLogo />
      <ControlRing />
      <ControlRequestDialog />
      <Dock />

      {effectiveLayout === "sidebar" ? (
        <>
          <aside
            className="chat-rail"
            hidden={rail.collapsed}
            style={{ "--rail-width": `${rail.width}px` } as CSSProperties}
          >
            <header className="rail-head">
              <span className="rail-brand">
                <span className="rail-dot" />
                Smithers
              </span>
              {surface === null ? (
                <button aria-label="Exit sidebar layout" className="nav-button" type="button" onClick={toggleLayout}>
                  <PanelLeftIcon />
                </button>
              ) : null}
            </header>
            {selectedWorkspaceRoot ? (
              <div className="nav-workspace" title={selectedWorkspaceRoot}>
                <span>Workspace</span>
                <strong>{selectedWorkspaceRoot}</strong>
                <button type="button" onClick={clearSelectedWorkspace}>
                  Change
                </button>
              </div>
            ) : null}
            <ChatTranscript />
            <div className="composer-dock">
              <ComposingCard />
              <ComposerBar />
            </div>
          </aside>
          <div
            aria-label="Resize chat panel"
            aria-orientation="vertical"
            aria-valuemax={rail.collapsed ? undefined : RAIL_MAX}
            aria-valuemin={rail.collapsed ? undefined : RAIL_MIN}
            aria-valuenow={rail.collapsed ? undefined : rail.width}
            aria-valuetext={rail.collapsed ? "Collapsed" : `${rail.width}px`}
            className="rail-resizer"
            role="separator"
            tabIndex={0}
            onKeyDown={rail.onResizeKeyDown}
            onPointerDown={rail.onResizeStart}
            onPointerMove={rail.onResizeMove}
            onPointerUp={rail.onResizeEnd}
            onPointerCancel={rail.onResizeEnd}
          />
          <section className="main-canvas" data-dir={navDir} key={canvasKey}>
            {rail.collapsed ? (
              <button
                aria-label="Show chat panel"
                className="nav-button rail-restore"
                type="button"
                onClick={rail.expand}
              >
                <PanelLeftIcon />
              </button>
            ) : null}
            <Outlet />
          </section>
        </>
      ) : (
        <>
          <div className="view" data-dir={navDir} key={view}>
            <Outlet />
            {showTranscript ? <ChatTranscript /> : null}
          </div>
          <div className="composer-dock">
            <ComposingCard />
            <ComposerBar />
          </div>
        </>
      )}
    </main>
  );
}
