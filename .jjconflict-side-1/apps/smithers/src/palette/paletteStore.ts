import { create } from "zustand";
import { closeSurface, setProject } from "../app/navigation";
import { launchRun, runSlash } from "../app/runSlash";
import { useChatStore } from "../chat/chatStore";
import { useNotificationsStore } from "../notifications/notificationsStore";
import {
  buildResults,
  PALETTE_COMMANDS,
  parseQuery,
  PROJECTS,
  RECENT_PATHS,
  SLASH_COMMANDS,
  WORKSPACE_FILES,
  sigilForMode,
  type FileEntry,
  type PaletteCommand,
  type PaletteItem,
  type PaletteMode,
  type SlashCommand,
  type Workspace,
} from "./palette";

/**
 * The palette store: the raw query plus the highlighted index, over immutable
 * seeded catalogs. The visible result list is derived (never stored) so it can't
 * drift from the query; selectedIndex is the only interactive cursor and is
 * clamped/reset by the actions. Mutations echo through chat + a transient toast,
 * the same gateway-less feedback shape vcs/issues use.
 */
type PaletteState = {
  query: string;
  selectedIndex: number;
  files: FileEntry[];
  workspaces: Workspace[];
  commands: PaletteCommand[];
  slashCommands: SlashCommand[];
  recentPaths: string[];
  setQuery: (query: string) => void;
  moveSelection: (delta: 1 | -1) => void;
  setSelectedIndex: (index: number) => void;
  setMode: (mode: PaletteMode) => void;
  tabComplete: () => void;
  execute: () => void;
  mentionFile: (path: string) => void;
  askAi: () => void;
  close: () => void;
};

/** The seeds the result builder reads, bundled from the immutable catalogs. */
function inputs(state: PaletteState) {
  return {
    files: state.files,
    recentPaths: state.recentPaths,
    workspaces: state.workspaces,
    commands: state.commands,
    slashCommands: state.slashCommands,
  };
}

/** Derive the current flat result list for a store snapshot. */
function results(state: PaletteState): PaletteItem[] {
  return buildResults(parseQuery(state.query), inputs(state));
}

export const usePaletteStore = create<PaletteState>((set, get) => ({
  query: "",
  selectedIndex: 0,
  files: WORKSPACE_FILES,
  workspaces: PROJECTS,
  commands: PALETTE_COMMANDS,
  slashCommands: SLASH_COMMANDS,
  recentPaths: RECENT_PATHS,

  setQuery: (query) => set({ query, selectedIndex: 0 }),

  moveSelection: (delta) => {
    const count = results(get()).length;
    if (count === 0) {
      set({ selectedIndex: 0 });
      return;
    }
    set((state) => ({
      selectedIndex: Math.max(0, Math.min(count - 1, state.selectedIndex + delta)),
    }));
  },

  setSelectedIndex: (index) => {
    const count = results(get()).length;
    if (count === 0) {
      set({ selectedIndex: 0 });
      return;
    }
    set({ selectedIndex: Math.max(0, Math.min(count - 1, index)) });
  },

  setMode: (mode) => {
    // Clicking a mode tab prepends the sigil, preserving any current search text.
    const sigil = sigilForMode(mode);
    const { searchText } = parseQuery(get().query);
    const next = sigil === "" ? searchText : searchText === "" ? sigil : `${sigil}${searchText}`;
    set({ query: next, selectedIndex: 0 });
  },

  tabComplete: () => {
    const list = results(get());
    const item = list[get().selectedIndex];
    if (!item || item.disabled) return;
    switch (item.kind) {
      case "file":
        set({ query: `@${item.value}`, selectedIndex: 0 });
        return;
      case "slash":
        set({ query: `/${item.value} `, selectedIndex: 0 });
        return;
      case "command":
        set({ query: item.title, selectedIndex: 0 });
        return;
      case "ask":
        set({ query: "?", selectedIndex: 0 });
        return;
      case "workspace":
        set({ query: item.value, selectedIndex: 0 });
        return;
    }
  },

  execute: () => {
    const state = get();
    const list = results(state);
    const item = list[state.selectedIndex];
    if (!item || item.disabled) return;
    const parsed = parseQuery(state.query);
    const chat = useChatStore.getState();
    const notify = useNotificationsStore.getState().notify;

    switch (item.kind) {
      case "file": {
        // In Files mode a file is a mention insert; in open-anything it opens.
        if (parsed.mode === "files") {
          get().mentionFile(item.value);
          return;
        }
        get().close();
        chat.say(`Opened \`${item.value}\` (would open in editor).`);
        notify({
          title: "Opened file",
          detail: item.value,
          kind: "transient",
          command: "chat",
        });
        return;
      }
      case "workspace": {
        get().close();
        setProject(item.value);
        chat.say(`Switched to the **${item.value}** workspace.`);
        notify({
          title: "Workspace switched",
          detail: item.value,
          kind: "transient",
          command: "chat",
        });
        return;
      }
      case "slash": {
        get().close();
        runSlash(item.value, "");
        return;
      }
      case "ask": {
        get().askAi();
        return;
      }
      case "command": {
        // Global Search stays in the palette (flips it into ask mode); every
        // other command closes the palette first, then runs its action.
        if (item.value === "global-search") {
          set({ query: "?", selectedIndex: 0 });
          return;
        }
        get().close();
        switch (item.value) {
          case "new-run":
            launchRun();
            return;
          case "close-surface":
            // Already closed by the close() above; nothing more to do.
            return;
          case "refresh":
            chat.say("Refreshed the active view.");
            notify({ title: "Refreshed", detail: "active view", kind: "transient", command: "chat" });
            return;
          case "shortcuts":
            chat.say(
              "Keyboard shortcuts: **Cmd+N** new run · **Cmd+R** refresh · " +
                "**Cmd+Shift+F** global search · **Cmd+/** this help.",
            );
            return;
        }
        return;
      }
    }
  },

  mentionFile: (path) => {
    // Append '@path ' to the composer query, then close — the core mention flow.
    const chat = useChatStore.getState();
    const existing = chat.query;
    const sep = existing === "" || existing.endsWith(" ") ? "" : " ";
    chat.fill(`${existing}${sep}@${path} `);
    get().close();
  },

  askAi: () => {
    const { searchText } = parseQuery(get().query);
    get().close();
    if (searchText === "") return;
    void useChatStore.getState().send(searchText);
  },

  close: () => {
    set({ query: "", selectedIndex: 0 });
    closeSurface();
  },
}));
