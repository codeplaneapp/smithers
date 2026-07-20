import { create } from "zustand";

/** The two ways to view a gateway run: its own custom UI, or the native tree. */
export type GatewayRunView = "flow" | "inspector";

/**
 * Per-run inspector UI state (which view is active, which node is selected),
 * keyed by runId so several runs can be visited without leaking selection.
 * Replaces component `useState` per the app's zustand-only rule. The default
 * view is derived (custom UI when present), not stored, so it stays a pure
 * function of the run rather than a value to keep in sync.
 */
type GatewayInspectorState = {
  viewByRun: Record<string, GatewayRunView>;
  selectedNodeByRun: Record<string, string | undefined>;
  setView: (runId: string, view: GatewayRunView) => void;
  selectNode: (runId: string, nodeId: string) => void;
};

export const useGatewayInspectorStore = create<GatewayInspectorState>((set) => ({
  viewByRun: {},
  selectedNodeByRun: {},
  setView: (runId, view) =>
    set((state) => ({ viewByRun: { ...state.viewByRun, [runId]: view } })),
  selectNode: (runId, nodeId) =>
    set((state) => ({
      selectedNodeByRun: { ...state.selectedNodeByRun, [runId]: nodeId },
    })),
}));
