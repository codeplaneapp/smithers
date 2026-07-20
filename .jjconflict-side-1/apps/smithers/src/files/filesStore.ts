import { create } from "zustand";
import {
  fetchFile,
  fetchFileTree,
  saveFile,
  type FileReadResult,
  type FileTreeEntry,
} from "./filesApi";

type FilesState = {
  rootName: string;
  treeByPath: Record<string, FileTreeEntry[]>;
  expanded: Record<string, boolean>;
  selectedPath: string | null;
  file: FileReadResult | null;
  draft: string;
  saved: string;
  loadingTreePath: string | null;
  loadingFile: boolean;
  saving: boolean;
  treeError: string | null;
  fileError: string | null;
  saveError: string | null;

  loadTree: (path?: string) => Promise<void>;
  toggleDirectory: (path: string) => Promise<void>;
  selectFile: (path: string) => Promise<void>;
  editDraft: (draft: string) => void;
  saveSelected: () => Promise<void>;
  reset: () => void;
};

function parentPath(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

const initial = {
  rootName: "workspace",
  treeByPath: {},
  expanded: { "": true },
  selectedPath: null,
  file: null,
  draft: "",
  saved: "",
  loadingTreePath: null,
  loadingFile: false,
  saving: false,
  treeError: null,
  fileError: null,
  saveError: null,
};

export const useFilesStore = create<FilesState>((set, get) => ({
  ...initial,

  loadTree: async (path = "") => {
    set({ loadingTreePath: path, treeError: null });
    try {
      const tree = await fetchFileTree(path);
      set((state) => ({
        rootName: tree.root,
        treeByPath: { ...state.treeByPath, [tree.path]: tree.entries },
        expanded: { ...state.expanded, [tree.path]: true },
        loadingTreePath: null,
      }));
    } catch (err) {
      set({
        treeError: err instanceof Error ? err.message : String(err),
        loadingTreePath: null,
      });
    }
  },

  toggleDirectory: async (path) => {
    const state = get();
    if (state.expanded[path]) {
      set({ expanded: { ...state.expanded, [path]: false } });
      return;
    }
    set({ expanded: { ...state.expanded, [path]: true } });
    if (!state.treeByPath[path]) {
      await get().loadTree(path);
    }
  },

  selectFile: async (path) => {
    set({
      selectedPath: path,
      loadingFile: true,
      fileError: null,
      saveError: null,
    });
    try {
      const result = await fetchFile(path);
      const content = result.file.content ?? result.file.previewText ?? "";
      set({
        file: result.file,
        draft: content,
        saved: content,
        selectedPath: result.file.path,
        loadingFile: false,
      });
    } catch (err) {
      set({
        file: null,
        draft: "",
        saved: "",
        fileError: err instanceof Error ? err.message : String(err),
        loadingFile: false,
      });
    }
  },

  editDraft: (draft) => {
    const file = get().file;
    if (!file?.editable) return;
    set({ draft });
  },

  saveSelected: async () => {
    const state = get();
    if (
      !state.file?.editable ||
      state.selectedPath === null ||
      state.draft === state.saved
    )
      return;
    set({ saving: true, saveError: null });
    try {
      const result = await saveFile(state.selectedPath, state.draft);
      const content = result.file.content ?? result.file.previewText ?? "";
      set({
        file: result.file,
        draft: content,
        saved: content,
        selectedPath: result.file.path,
        saving: false,
      });
      await get().loadTree(parentPath(result.file.path));
    } catch (err) {
      set({
        saveError: err instanceof Error ? err.message : String(err),
        saving: false,
      });
    }
  },

  reset: () => set(initial),
}));

export function selectIsDirty(state: FilesState): boolean {
  return state.draft !== state.saved;
}
