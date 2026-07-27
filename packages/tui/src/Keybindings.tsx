import { createContext, useContext, type ReactNode } from "react";

export type KeymapEntry = {
  key: string;
  description: string;
};

export type Keymap = {
  entries: KeymapEntry[];
};

type KeybindingsContextValue = {
  keymap: Keymap;
};

const defaultKeymap: Keymap = {
  entries: [
    { key: "1", description: "Tree" },
    { key: "2", description: "Graph" },
    { key: "3", description: "Logs" },
    { key: "4", description: "Timeline" },
    { key: "5", description: "Hijack" },
    { key: "6", description: "Runs" },
    { key: "q", description: "Quit" },
    { key: "?", description: "Help" },
  ],
};

const KeybindingsContext = createContext<KeybindingsContextValue>({ keymap: defaultKeymap });

export function Keybindings({ keymap = defaultKeymap, children }: { keymap?: Keymap; children?: ReactNode }) {
  return <KeybindingsContext.Provider value={{ keymap }}>{children}</KeybindingsContext.Provider>;
}

export function useKeymap(): Keymap {
  return useContext(KeybindingsContext).keymap;
}
