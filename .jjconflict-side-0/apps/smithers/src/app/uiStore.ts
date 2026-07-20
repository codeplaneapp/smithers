import { create } from "zustand";
import { useChatStore } from "../chat/chatStore";
import { useNotificationsStore } from "../notifications/notificationsStore";
import { getSpeechRecognition } from "../speech/getSpeechRecognition";
import type { SpeechRecognitionLike } from "../speech/SpeechRecognitionLike";

export type NavDir = "back" | "forward";

/** Whether the browser exposes the Web Speech API, computed once at load. */
export const DICTATION_SUPPORTED = getSpeechRecognition() !== null;

// The live recognition instance during dictation. Not state: nothing renders it.
let recognition: SpeechRecognitionLike | null = null;

type UiState = {
  /**
   * The single open dropdown/menu, keyed by a stable id ("command", "project",
   * or `toast-<id>`). Only one menu is open at a time, so one global beats a
   * per-instance flag (the memory's rule).
   */
  openMenuId: string | null;
  /** Whether dictation is currently listening. */
  listening: boolean;
  /** Slide direction for the view transition (data-dir). */
  navDir: NavDir;
  setOpenMenu: (id: string | null) => void;
  toggleMenu: (id: string) => void;
  setNavDir: (navDir: NavDir) => void;
  toggleDictation: () => void;
};

/** Ephemeral cross-cutting UI: open menu, dictation, transition direction. */
export const useUiStore = create<UiState>((set, get) => ({
  openMenuId: null,
  listening: false,
  navDir: "forward",
  setOpenMenu: (openMenuId) => set({ openMenuId }),
  toggleMenu: (id) =>
    set((state) => ({ openMenuId: state.openMenuId === id ? null : id })),
  setNavDir: (navDir) => set({ navDir }),
  toggleDictation: () => {
    if (get().listening) {
      recognition?.stop();
      return;
    }
    const next = getSpeechRecognition();
    if (!next) {
      return;
    }
    next.lang = "en-US";
    next.interimResults = false;
    next.continuous = false;
    next.onresult = (event) => {
      const transcript = event.results[0]?.[0]?.transcript ?? "";
      if (transcript) {
        const chat = useChatStore.getState();
        chat.setQuery(chat.query ? `${chat.query} ${transcript}` : transcript);
      }
    };
    next.onerror = () => {
      set({ listening: false });
      useNotificationsStore.getState().notify({
        title: "Dictation stopped",
        detail: "The microphone hit an error.",
        kind: "transient",
      });
    };
    next.onend = () => set({ listening: false });
    recognition = next;
    next.start();
    set({ listening: true });
  },
}));
