import { create } from "zustand";
import type { VcsSnapshot } from "./vcsDomain";

type VcsState = {
  snapshot: VcsSnapshot | null;
  loading: boolean;
  error: string | null;
  load: () => Promise<void>;
  refresh: () => void;
  hydrate: (snapshot: VcsSnapshot) => void;
};

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function fetchLocalVcsSnapshot(): Promise<VcsSnapshot> {
  const response = await fetch("/__smithers/vcs", {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Local VCS status failed (${response.status})`);
  }
  return (await response.json()) as VcsSnapshot;
}

export const useVcsStore = create<VcsState>((set, get) => ({
  snapshot: null,
  loading: false,
  error: null,

  hydrate: (snapshot) => set({ snapshot, error: null, loading: false }),

  load: async () => {
    if (get().loading) return;
    set({ loading: true, error: null });
    try {
      set({ snapshot: await fetchLocalVcsSnapshot(), loading: false });
    } catch (error) {
      set({ error: errorMessage(error), loading: false });
    }
  },

  refresh: () => {
    void get().load();
  },
}));
