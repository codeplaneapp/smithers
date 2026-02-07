import { type Component, For, createMemo, Show } from "solid-js";
import { appState, setAppState, type AppView } from "../stores/app-store";
import { shortenPath } from "../lib/format";

const navItems: Array<{ view: AppView; icon: string; label: string; id?: string }> = [
  { view: "chat", icon: "💬", label: "Chat", id: "tab-chat" },
  { view: "runs", icon: "▶", label: "Runs", id: "tab-runs" },
  { view: "workflows", icon: "⚡", label: "Workflows", id: "tab-workflows" },
  { view: "settings", icon: "⚙", label: "Settings" },
];

export const NavRail: Component = () => {
  const approvalCount = createMemo(() =>
    appState.runs.reduce((sum, r) => sum + (r.waitingApprovals ?? 0), 0)
  );

  return (
    <nav class="flex flex-col bg-[#07080A] border-r border-border w-14 flex-shrink-0 overflow-hidden py-2 z-10">
      <div class="flex items-center gap-2 px-3 pb-3 border-b border-border mb-2">
        <span class="text-lg text-accent flex-shrink-0 w-8 text-center">◆</span>
        <span class="text-xs font-semibold uppercase tracking-widest text-muted whitespace-nowrap overflow-hidden">
          Smithers
        </span>
      </div>

      <div class="px-2 mb-2">
        <select
          id="workspace-select"
          class="w-full bg-transparent border border-border text-foreground text-xs rounded-md px-1 py-1 cursor-pointer focus:border-accent focus:outline-none truncate"
          value={appState.workspaceRoot ?? ""}
          onChange={(e) => {
            const val = e.currentTarget.value;
            if (val === appState.workspaceRoot) return;
          }}
        >
          <Show when={appState.workspaceRoot}>
            <option value={appState.workspaceRoot!}>
              {shortenPath(appState.workspaceRoot!, 20)}
            </option>
          </Show>
          <option value="">No workspace</option>
        </select>
      </div>

      <div class="flex flex-col gap-0.5 px-2">
        <For each={navItems}>
          {(item) => (
            <button
              id={item.id}
              class="flex items-center gap-2.5 p-2 border-none bg-transparent text-muted cursor-pointer rounded-md text-[11px] font-medium uppercase tracking-wide whitespace-nowrap transition-colors duration-100 relative"
              classList={{
                "bg-accent/15 text-accent": appState.currentView === item.view,
                "hover:bg-panel-2 hover:text-foreground": appState.currentView !== item.view,
              }}
              onClick={() => setAppState("currentView", item.view)}
            >
              <span class="text-base w-6 text-center flex-shrink-0">{item.icon}</span>
              <span class="overflow-hidden text-ellipsis">{item.label}</span>
              <Show when={item.view === "runs" && approvalCount() > 0}>
                <span class="absolute top-1 right-1 bg-accent text-[#07080A] text-[9px] px-1 rounded-full font-semibold font-mono min-w-[14px] text-center leading-[14px]">
                  {approvalCount()}
                </span>
              </Show>
            </button>
          )}
        </For>
      </div>

      <div class="mt-auto pt-2 border-t border-border px-2">
        <div class="text-[9px] text-subtle text-center py-1 font-mono">v0.1.0</div>
      </div>
    </nav>
  );
};
