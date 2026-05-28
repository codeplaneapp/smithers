import { create } from "zustand";

type TerminalTab = { id: string; title: string; createdAt: Date };

type ViewId = "terminal" | "issues" | "landings" | "workspaces";

function createTerminal(index: number): TerminalTab {
  return { id: crypto.randomUUID(), title: `Terminal ${index}`, createdAt: new Date() };
}

const firstTerminal: TerminalTab = {
  id: crypto.randomUUID(),
  title: "Terminal 1",
  createdAt: new Date(),
};

type StudioState = {
  // Terminal state
  tabs: TerminalTab[];
  activeTabId: string;

  // View state
  activeView: ViewId;

  // Command palette state
  paletteOpen: boolean;
  paletteQuery: string;
  selectedPaletteIndex: number;

  // Terminal actions
  openTerminal: () => void;
  closeTerminal: (tabId: string) => void;
  setActiveTabId: (id: string) => void;

  // View actions
  setActiveView: (view: ViewId) => void;

  // Palette actions
  openPalette: () => void;
  closePalette: () => void;
  setPaletteQuery: (query: string) => void;
  setSelectedPaletteIndex: (index: number | ((prev: number) => number)) => void;
};

export const useStudioStore = create<StudioState>((set, get) => ({
  tabs: [firstTerminal],
  activeTabId: firstTerminal.id,
  activeView: "terminal",
  paletteOpen: false,
  paletteQuery: "",
  selectedPaletteIndex: 0,

  openTerminal: () => {
    const { tabs } = get();
    const next = createTerminal(tabs.length + 1);
    set({
      tabs: [...tabs, next],
      activeTabId: next.id,
      activeView: "terminal",
      paletteOpen: false,
      paletteQuery: ""
    });
  },

  closeTerminal: (tabId: string) => {
    const { tabs, activeTabId } = get();
    if (tabs.length === 1) return;
    const nextTabs = tabs.filter((tab) => tab.id !== tabId);
    const nextActiveId = tabId === activeTabId ? (nextTabs.at(-1)?.id ?? nextTabs[0].id) : activeTabId;
    set({ tabs: nextTabs, activeTabId: nextActiveId });
  },

  setActiveTabId: (id: string) => set({ activeTabId: id }),

  setActiveView: (view: ViewId) => set({ activeView: view, paletteOpen: false }),

  openPalette: () => set({ paletteOpen: true }),

  closePalette: () => set({ paletteOpen: false, paletteQuery: "", selectedPaletteIndex: 0 }),

  setPaletteQuery: (query: string) => set({ paletteQuery: query, selectedPaletteIndex: 0 }),

  setSelectedPaletteIndex: (index) =>
    set((state) => ({
      selectedPaletteIndex: typeof index === "function" ? index(state.selectedPaletteIndex) : index,
    })),
}));
