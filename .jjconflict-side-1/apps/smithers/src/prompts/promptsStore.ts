import { create } from "zustand";
import { useChatStore } from "../chat/chatStore";
import { useNotificationsStore } from "../notifications/notificationsStore";
import {
  defaultValues,
  discoverInputs,
  hasInputValueChanges,
  renderPreview,
  type Prompt,
} from "./promptsSource";

/** The four detail tabs, in order. Source/Inputs/Preview are 1:1 with the Swift
 *  DetailTab enum; Imports is the new scope tab listing the source's imports. */
export type PromptTab = "source" | "imports" | "inputs" | "preview";

/**
 * The prompts-editor store: the live prompt list (hydrated by `PromptsBridge`
 * from the `listPrompts` gateway RPC) plus all the editor state the canvas
 * reads — the active selection, per-prompt source drafts and last-saved
 * snapshots, typed input values, the active tab, the per-prompt last preview, the
 * debounced-render in-flight flag, and the pending-select id that drives the
 * unsaved-changes discard guard.
 *
 * Drafts and saved sources are absent-key-means-live-source: when `draftById[id]`
 * is missing the prompt's live `source` is both the draft and the saved value, so
 * `hasSourceChanges` collapses to `false` until the user types. Mutations echo
 * the same way vcsStore/issuesStore do — a chat line plus a transient toast —
 * since prompts are read-only on the wire (no write RPC).
 */
type PromptsState = {
  prompts: Prompt[];
  /** The selected prompt id, or "" when there is no prompt (empty/offline-empty list). */
  selectedId: string;
  /** Per-prompt working source. Absent ⇒ use the live source as draft + saved. */
  draftById: Record<string, string>;
  /** Per-prompt last-saved source. Absent ⇒ live source. */
  savedById: Record<string, string>;
  /** Per-prompt input name → typed value. */
  valuesById: Record<string, Record<string, string>>;
  tab: PromptTab;
  /** Per-prompt last rendered preview text. Absent/null ⇒ "No preview available". */
  previewById: Record<string, string | null>;
  /** The debounced render in-flight flag → the "Rendering…" row. */
  previewing: boolean;
  /** A prompt the user tried to switch to while dirty → the Discard/Cancel guard. */
  pendingSelectId: string | null;
  select: (id: string) => void;
  confirmDiscard: () => void;
  cancelDiscard: () => void;
  editSource: (id: string, text: string) => void;
  setValue: (id: string, name: string, value: string) => void;
  save: (id: string) => void;
  setTab: (tab: PromptTab) => void;
  renderNow: (id: string) => void;
};

/** The draft source for a prompt, falling back to its seed source. */
function draftOf(state: PromptsState, id: string): string {
  return state.draftById[id] ?? promptSource(state, id);
}

/** The last-saved source for a prompt, falling back to its seed source. */
function savedOf(state: PromptsState, id: string): string {
  return state.savedById[id] ?? promptSource(state, id);
}

/** The seed source for a prompt id (the immutable baseline). */
function promptSource(state: PromptsState, id: string): string {
  return state.prompts.find((prompt) => prompt.id === id)?.source ?? "";
}

/** Whether the prompt's draft diverges from its last-saved source. */
function hasSourceChanges(state: PromptsState, id: string): boolean {
  return draftOf(state, id) !== savedOf(state, id);
}

/** Whether the prompt is dirty — unsaved source OR diverged input values. */
function isDirty(state: PromptsState, id: string): boolean {
  if (hasSourceChanges(state, id)) return true;
  const inputs = discoverInputs(draftOf(state, id));
  return hasInputValueChanges(state.valuesById[id] ?? {}, inputs);
}

export const usePromptsStore = create<PromptsState>((set, get) => ({
  // Hydrated live by `PromptsBridge` from the `listPrompts` gateway RPC (P1b
  // §3.5). Starts empty with no selection; the bridge replaces it on first pull
  // and derives the selection from the first live row.
  prompts: [],
  selectedId: "",
  draftById: {},
  savedById: {},
  valuesById: {},
  tab: "source",
  previewById: {},
  previewing: false,
  pendingSelectId: null,

  // Switching prompts: if the current one is dirty, stash the target on
  // pendingSelectId and stop (the canvas reveals the Discard/Cancel guard);
  // otherwise apply the switch and reset the tab back to Source.
  select: (id) => {
    const state = get();
    if (id === state.selectedId) return;
    if (isDirty(state, state.selectedId)) {
      set({ pendingSelectId: id });
      return;
    }
    set({ selectedId: id, tab: "source", pendingSelectId: null });
  },

  // Discard the pending switch's intent for the CURRENT prompt, reset that
  // prompt's draft to its saved source and its values to defaults, then move to
  // the pending prompt (port selectPrompt's discard branch).
  confirmDiscard: () => {
    const state = get();
    const target = state.pendingSelectId;
    if (target == null) return;
    const current = state.selectedId;
    const draftById = { ...state.draftById };
    delete draftById[current];
    const valuesById = { ...state.valuesById };
    delete valuesById[current];
    const previewById = { ...state.previewById };
    delete previewById[current];
    set({
      selectedId: target,
      tab: "source",
      pendingSelectId: null,
      draftById,
      valuesById,
      previewById,
      previewing: false,
    });
  },

  cancelDiscard: () => set({ pendingSelectId: null }),

  // Editing the source re-discovers inputs (the canvas reads discoverInputs over
  // this draft) MERGING existing typed values, and schedules a debounced
  // preview. We model the 300ms debounce as a synchronous-with-pending mock:
  // flip previewing on, compute the render from the new draft + merged values,
  // write it, then flip previewing off — all in one set so render stays pure.
  editSource: (id, text) => {
    const state = get();
    const values = state.valuesById[id] ?? {};
    set({
      draftById: { ...state.draftById, [id]: text },
      previewing: true,
    });
    set((live) => ({
      previewById: { ...live.previewById, [id]: renderPreview(text, values) },
      previewing: false,
    }));
  },

  setValue: (id, name, value) =>
    set((state) => ({
      valuesById: {
        ...state.valuesById,
        [id]: { ...(state.valuesById[id] ?? {}), [name]: value },
      },
    })),

  // Commit the draft as the new saved source, clearing hasSourceChanges, and
  // echo it like vcsStore.runAction.
  save: (id) => {
    const state = get();
    const draft = draftOf(state, id);
    const prompt = state.prompts.find((entry) => entry.id === id);
    set({ savedById: { ...state.savedById, [id]: draft } });
    useChatStore.getState().say(`Saved prompt \`${prompt?.entryFile ?? id}\`.`);
    useNotificationsStore.getState().notify({
      title: "Prompt saved",
      detail: prompt?.entryFile ?? id,
      kind: "transient",
      command: "chat",
    });
  },

  setTab: (tab) => set({ tab }),

  // Force a render from the current draft + values and jump to the Preview tab
  // (the "Preview with values" / "Generate Preview" buttons).
  renderNow: (id) => {
    const state = get();
    const source = draftOf(state, id);
    const values = state.valuesById[id] ?? defaultValues(discoverInputs(source));
    set({
      previewById: { ...state.previewById, [id]: renderPreview(source, values) },
      previewing: false,
      tab: "preview",
    });
  },
}));

/** Selector: the active prompt's draft source (seed fallback). Read in the canvas. */
export function selectDraft(state: PromptsState): string {
  return draftOf(state, state.selectedId);
}

/** Selector: whether the active prompt's source diverges from its saved snapshot. */
export function selectHasSourceChanges(state: PromptsState): boolean {
  return hasSourceChanges(state, state.selectedId);
}

/** Selector: whether the active prompt's typed input values diverge from defaults. */
export function selectHasInputChanges(state: PromptsState): boolean {
  const inputs = discoverInputs(draftOf(state, state.selectedId));
  return hasInputValueChanges(state.valuesById[state.selectedId] ?? {}, inputs);
}
