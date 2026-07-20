import { create } from "zustand";
import { persist } from "zustand/middleware";

type WorkflowsState = {
  /**
   * Workflow ids the user has installed beyond the default pack. The default
   * pack is always installed (see `isWorkflowInstalled`), so only the extras
   * persist — that keeps the stored list small and implicit-defaults stable.
   */
  installed: string[];
  install: (id: string) => void;
};

/**
 * Installed workflow ids on the `local` medium. Mirrors the old
 * `useInstalledWorkflows` hook: the default pack is implicit, user installs
 * persist across reloads.
 */
export const useWorkflowsStore = create<WorkflowsState>()(
  persist(
    (set) => ({
      installed: [],
      install: (id) =>
        set((state) =>
          state.installed.includes(id)
            ? state
            : { installed: [...state.installed, id] },
        ),
    }),
    { name: "smithers.workflows" },
  ),
);
