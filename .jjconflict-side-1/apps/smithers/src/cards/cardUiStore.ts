import { create } from "zustand";

export type InspectorView = "tree" | "graph";
export type InspectorTab = "Output" | "Tools" | "Logs" | "Diff" | "Props";

/**
 * Transient UI state for the feature cards and canvas surfaces, consolidated
 * into one ephemeral store (the memory's "single UI store" rule). State that can
 * have several cards on screen at once is keyed by a natural id (runId, diffId,
 * workflowId, event); single-surface state (the inspector, the crons/prompts
 * cards) is flat. Replaces the per-component useState.
 */
type CardUiState = {
  // Run inspector (one surface open at a time → flat).
  inspectorView: InspectorView;
  inspectorSelected: string;
  inspectorCollapsed: string[];
  inspectorTab: InspectorTab;
  /** Props-table value [expand]/[collapse], keyed by prop path (`node.id/key`). */
  propExpandedByPath: Record<string, boolean>;
  setInspectorView: (view: InspectorView) => void;
  selectNode: (id: string) => void;
  toggleCollapsed: (id: string) => void;
  setInspectorTab: (tab: InspectorTab) => void;
  togglePropExpanded: (path: string) => void;

  // Approval note draft, keyed by runId.
  noteByRun: Record<string, string>;
  setNote: (runId: string, note: string) => void;

  // Active diff file, keyed by a per-card/per-canvas key (runId or diffId).
  diffActiveByKey: Record<string, number>;
  setDiffActive: (key: string, index: number) => void;

  // Schedules card "new schedule" form.
  cronsAdding: boolean;
  setCronsAdding: (adding: boolean) => void;

  // Human task choice + signal delivery (keyed by event).
  humanPicked: string | null;
  pickHuman: (option: string) => void;
  deliveredByEvent: Record<string, boolean>;
  deliverSignal: (event: string) => void;

  // Launch form depth, keyed by workflowId.
  depthByWorkflow: Record<string, string>;
  setDepth: (workflowId: string, depth: string) => void;

  // Prompts picker selection.
  promptActiveId: string | null;
  setPromptActive: (id: string) => void;
};

export const useCardUiStore = create<CardUiState>((set) => ({
  inspectorView: "tree",
  inspectorSelected: "edit-files",
  inspectorCollapsed: [],
  inspectorTab: "Output",
  propExpandedByPath: {},
  setInspectorView: (inspectorView) => set({ inspectorView }),
  selectNode: (inspectorSelected) => set({ inspectorSelected }),
  toggleCollapsed: (id) =>
    set((state) => ({
      inspectorCollapsed: state.inspectorCollapsed.includes(id)
        ? state.inspectorCollapsed.filter((entry) => entry !== id)
        : [...state.inspectorCollapsed, id],
    })),
  setInspectorTab: (inspectorTab) => set({ inspectorTab }),
  togglePropExpanded: (path) =>
    set((state) => ({
      propExpandedByPath: {
        ...state.propExpandedByPath,
        [path]: !state.propExpandedByPath[path],
      },
    })),

  noteByRun: {},
  setNote: (runId, note) =>
    set((state) => ({ noteByRun: { ...state.noteByRun, [runId]: note } })),

  diffActiveByKey: {},
  setDiffActive: (key, index) =>
    set((state) => ({ diffActiveByKey: { ...state.diffActiveByKey, [key]: index } })),

  cronsAdding: false,
  setCronsAdding: (cronsAdding) => set({ cronsAdding }),

  humanPicked: null,
  pickHuman: (humanPicked) => set({ humanPicked }),
  deliveredByEvent: {},
  deliverSignal: (event) =>
    set((state) => ({ deliveredByEvent: { ...state.deliveredByEvent, [event]: true } })),

  depthByWorkflow: {},
  setDepth: (workflowId, depth) =>
    set((state) => ({ depthByWorkflow: { ...state.depthByWorkflow, [workflowId]: depth } })),

  promptActiveId: null,
  setPromptActive: (promptActiveId) => set({ promptActiveId }),
}));
