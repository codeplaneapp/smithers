import { create } from "zustand";

/**
 * The diff review surface's interactive state, keyed by diffId so several diffs
 * can coexist. We own file selection here (mirroring the old
 * `cardUiStore.diffActiveByKey` contract) plus the per-file expand/collapse and
 * pagination-reveal sets the canvas drives. Sets are stored as `string[]` of
 * file paths so the state stays JSON-stable, matching the vcs/cardUi idiom.
 *
 * Seed the expanded set with `initialExpanded(diff)` from `diffPaginate` at the
 * call site (the canvas) rather than here, so this store stays a pure container
 * with no diff knowledge.
 */
type DiffState = {
  /** Selected file index per diffId (reuses the old diffActiveByKey semantics). */
  activeByDiff: Record<string, number>;
  /** Expanded file paths per diffId. */
  expandedByDiff: Record<string, string[]>;
  /** File paths whose paginated tail has been fully revealed, per diffId. */
  revealedByDiff: Record<string, string[]>;
  selectFile: (diffId: string, index: number) => void;
  toggleExpanded: (diffId: string, path: string) => void;
  expandAll: (diffId: string, paths: string[]) => void;
  collapseAll: (diffId: string) => void;
  revealRemaining: (diffId: string, path: string) => void;
  resetReveal: (diffId: string, path: string) => void;
};

export const useDiffStore = create<DiffState>((set) => ({
  activeByDiff: {},
  expandedByDiff: {},
  revealedByDiff: {},

  selectFile: (diffId, index) =>
    set((state) => ({ activeByDiff: { ...state.activeByDiff, [diffId]: index } })),

  toggleExpanded: (diffId, path) =>
    set((state) => {
      const current = state.expandedByDiff[diffId] ?? [];
      const next = current.includes(path)
        ? current.filter((p) => p !== path)
        : [...current, path];
      return { expandedByDiff: { ...state.expandedByDiff, [diffId]: next } };
    }),

  expandAll: (diffId, paths) =>
    set((state) => ({ expandedByDiff: { ...state.expandedByDiff, [diffId]: [...paths] } })),

  collapseAll: (diffId) =>
    set((state) => ({ expandedByDiff: { ...state.expandedByDiff, [diffId]: [] } })),

  revealRemaining: (diffId, path) =>
    set((state) => {
      const current = state.revealedByDiff[diffId] ?? [];
      if (current.includes(path)) return {};
      return { revealedByDiff: { ...state.revealedByDiff, [diffId]: [...current, path] } };
    }),

  resetReveal: (diffId, path) =>
    set((state) => {
      const current = state.revealedByDiff[diffId] ?? [];
      if (!current.includes(path)) return {};
      return {
        revealedByDiff: {
          ...state.revealedByDiff,
          [diffId]: current.filter((p) => p !== path),
        },
      };
    }),
}));
