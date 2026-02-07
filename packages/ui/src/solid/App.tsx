import { createSignal, onMount, onCleanup, type Component } from "solid-js";
import { appState, setAppState, pushToast } from "./stores/app-store";
import { ChatView } from "./views/ChatView";
import { RunsView } from "./views/RunsView";
import { WorkflowsView } from "./views/WorkflowsView";
import { NavRail } from "./components/NavRail";
import { Inspector } from "./components/Inspector";
import { ToastContainer } from "./components/ToastContainer";
import { SettingsDialog } from "./views/SettingsDialog";
import { Menubar } from "./components/Menubar";
import { WorkspaceDialog } from "./components/WorkspaceDialog";
import { RunDialog } from "./components/RunDialog";

const App: Component = () => {
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = createSignal(false);
  const [runDialogOpen, setRunDialogOpen] = createSignal(false);
  const [settingsDialogOpen, setSettingsDialogOpen] = createSignal(false);
  const [runDialogPreselect, setRunDialogPreselect] = createSignal<string | undefined>(undefined);

  const openRunDialog = (preselect?: string) => {
    setRunDialogPreselect(preselect);
    setRunDialogOpen(true);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "\\") {
      if (e.shiftKey) {
        document.body.classList.toggle("artifacts-hidden");
      } else {
        setAppState({ inspectorOpen: !appState.inspectorOpen, inspectorExpanded: false });
      }
      e.preventDefault();
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "r" && !e.shiftKey) {
      e.preventDefault();
      setRunDialogOpen(true);
    }
    if (e.key === "Escape") {
      if (workspaceDialogOpen()) setWorkspaceDialogOpen(false);
      else if (runDialogOpen()) setRunDialogOpen(false);
      else if (settingsDialogOpen()) setSettingsDialogOpen(false);
      else if (appState.inspectorExpanded) setAppState("inspectorExpanded", false);
      else if (appState.inspectorOpen) setAppState("inspectorOpen", false);
    }
  };

  onMount(() => {
    document.addEventListener("keydown", handleKeyDown);
  });
  onCleanup(() => {
    document.removeEventListener("keydown", handleKeyDown);
  });

  return (
    <div class="app flex flex-col h-screen overflow-hidden">
      <Menubar
        onOpenWorkspace={() => setWorkspaceDialogOpen(true)}
        onCloseWorkspace={() => {
          import("./index").then(({ getRpc }) => {
            getRpc().request.openWorkspace({ path: "" }).then(async () => {
              const ws = await getRpc().request.getWorkspaceState({});
              setAppState({ workspaceRoot: ws.root, workflows: ws.workflows });
            });
          });
        }}
        onRunWorkflow={() => openRunDialog()}
        onPreferences={() => setSettingsDialogOpen(true)}
        onDocs={() => pushToast("info", "smithers.sh")}
        onZoomIn={() => setAppState("graphZoom", (z) => z * 1.2)}
      />

      <div
        class="flex flex-1 min-h-0 overflow-hidden transition-all duration-300"
      >
        <NavRail />

        <main class="flex flex-col min-w-0 overflow-hidden flex-1">
          <div class="flex flex-col flex-1 min-h-0 overflow-hidden" style={{ display: appState.currentView === "chat" ? undefined : "none" }}>
            <ChatView onRunWorkflow={openRunDialog} />
          </div>
          <div class="flex flex-col flex-1 min-h-0 overflow-hidden" style={{ display: appState.currentView === "runs" ? undefined : "none" }}>
            <RunsView />
          </div>
          <div class="flex flex-col flex-1 min-h-0 overflow-hidden" style={{ display: appState.currentView === "workflows" ? undefined : "none" }}>
            <WorkflowsView onRunWorkflow={openRunDialog} />
          </div>
          {appState.currentView === "settings" && (
            <div class="flex flex-col flex-1 min-h-0 overflow-hidden">
              <SettingsDialog onClose={() => setAppState("currentView", "chat")} />
            </div>
          )}
        </main>

        <Inspector />
      </div>

      <WorkspaceDialog
        open={workspaceDialogOpen()}
        onClose={() => setWorkspaceDialogOpen(false)}
        browseDirectory={async () => {
          const { getRpc } = await import("./index");
          const result = await getRpc().request.browseDirectory({});
          return result.path;
        }}
      />
      <RunDialog open={runDialogOpen()} onClose={() => setRunDialogOpen(false)} preselect={runDialogPreselect()} />
      <SettingsDialog
        modal={true}
        open={settingsDialogOpen()}
        onClose={() => setSettingsDialogOpen(false)}
      />
      <ToastContainer />
    </div>
  );
};

export default App;
