import { create } from "zustand";
import {
  factsInNamespace,
  normalizedRecallTopK,
  recall,
  validatedFilter,
  type MemoryFact,
  type RecallResult,
} from "./memoryFacts";

/**
 * The memory surface store: the seeded fact table plus the Facts/Recall mode,
 * the namespace filter, the open fact detail, and the recall query/results. The
 * card and the canvas read the same `facts` array, so both share one source of
 * truth (port loadFacts + the recall state machine). Zero useState / useEffect:
 * every interaction is a store action, every derived value is computed in the
 * render body from a selected slice.
 */
export type MemoryMode = "facts" | "recall";

type MemoryState = {
  /** The live fact store (hydrated by `MemoryFactsBridge`), held here so the card + canvas share one source. */
  facts: MemoryFact[];
  /** Facts table vs Recall query (port the toolbar mode pills). */
  mode: MemoryMode;
  /** Active namespace; null = All Namespaces, validated against the facts. */
  namespaceFilter: string | null;
  /** The open fact-detail row, or null for the table view (facts mode). */
  selectedFactId: string | null;
  recallQuery: string;
  /** Top-K, clamped to >= 1 via normalizedRecallTopK. */
  recallTopK: number;
  recallResults: RecallResult[];
  /** The header / Search pending affordance while a recall runs. */
  isRecalling: boolean;
  /** Toggles the pre/post-search empty copy in the Recall tab. */
  hasAttemptedRecall: boolean;
  /** A simulated recall failure message, or null. */
  recallError: string | null;

  setMode: (mode: MemoryMode) => void;
  setNamespaceFilter: (namespace: string | null) => void;
  selectFact: (id: string | null) => void;
  setRecallQuery: (query: string) => void;
  setRecallTopK: (topK: number) => void;
  runRecall: () => void;
};

export const useMemoryStore = create<MemoryState>((set, get) => ({
  // Hydrated live by `MemoryFactsBridge` from the `listMemoryFacts` gateway RPC
  // (docs/p1b-plan.md §3.2). Starts empty; the bridge replaces it on first pull.
  facts: [],
  mode: "facts",
  namespaceFilter: null,
  selectedFactId: null,
  recallQuery: "",
  recallTopK: 10,
  recallResults: [],
  isRecalling: false,
  hasAttemptedRecall: false,
  recallError: null,

  setMode: (mode) => {
    if (mode === get().mode) return;
    if (mode === "recall") {
      // Entering recall resets the query/results so it starts clean; the
      // selected fact + any list error are facts-mode concerns, cleared too.
      set({
        mode,
        selectedFactId: null,
        recallError: null,
        recallQuery: "",
        recallResults: [],
        hasAttemptedRecall: false,
        isRecalling: false,
      });
      return;
    }
    // Leaving recall for facts: drop the recall scratch state.
    set({ mode, selectedFactId: null, recallError: null, recallResults: [], isRecalling: false });
  },

  setNamespaceFilter: (namespace) => {
    const { facts, selectedFactId } = get();
    const next = validatedFilter(namespace, facts);
    // If the open fact is no longer in the filtered set, close its detail
    // (port the loadFacts selection-reconciliation).
    let selected = selectedFactId;
    if (selected !== null) {
      const visible = factsInNamespace(facts, next);
      if (!visible.some((fact) => fact.id === selected)) selected = null;
    }
    set({ namespaceFilter: next, selectedFactId: selected });
  },

  selectFact: (id) => set({ selectedFactId: id }),

  setRecallQuery: (query) => set({ recallQuery: query }),

  setRecallTopK: (topK) => set({ recallTopK: normalizedRecallTopK(topK) }),

  runRecall: () => {
    const { recallQuery, recallTopK, facts, namespaceFilter } = get();
    const query = recallQuery.trim();
    if (query === "") {
      // An empty query clears the results and the attempt flag.
      set({ recallResults: [], isRecalling: false, hasAttemptedRecall: false, recallError: null });
      return;
    }
    // Mock land resolves synchronously, but we still flip the pending flag so
    // the Search button / header can reflect the brief in-flight state (port the
    // Swift header spinner + doRecall generation-guard, simplified).
    set({ isRecalling: true, hasAttemptedRecall: true, recallError: null });
    const results = recall(query, facts, namespaceFilter, recallTopK);
    set({ recallResults: results, isRecalling: false });
  },
}));
