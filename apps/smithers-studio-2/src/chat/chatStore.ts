import { create } from "zustand";
import type { ViewId } from "../useStudioStore";

/**
 * Views the user can open manually from the TopBar "Views ▾" dropdown (and that
 * the agent can open via a tool). These map onto existing Studio surfaces shown
 * in the overlay/split host — a View is never a dead-end tab. `kind` selects the
 * overlay renderer: a plain Studio `surface`, the dedicated `settings` overlay,
 * or the `devtools` debug surface (Design spec §7 — DevTools is reachable from
 * the Views dropdown as well as the workflow Debug button).
 */
export type OpenableView = { id: ViewId; label: string; kind: "surface" | "settings" | "devtools" };

export const OPENABLE_VIEWS: OpenableView[] = [
  { id: "runs", label: "Runs", kind: "surface" },
  { id: "memory", label: "Memory", kind: "surface" },
  { id: "scores", label: "Scores", kind: "surface" },
  { id: "search", label: "Search", kind: "surface" },
  { id: "workflows", label: "History", kind: "surface" },
  { id: "devtools", label: "DevTools", kind: "devtools" },
  { id: "devtools", label: "Settings", kind: "settings" },
];

const FILTER_PARAM = "tags";

function readActiveTags(): string[] {
  if (typeof window === "undefined") return [];
  const raw = new URLSearchParams(window.location.search).get(FILTER_PARAM);
  if (!raw) return [];
  return raw.split(",").map((t) => t.trim()).filter(Boolean);
}

/**
 * Reflect the active tag filter into the URL so it is shareable and
 * Back/Forward navigable. URL-as-state for the *open view* is left as a TODO —
 * the overlay store owns which view is open and threading that into the URL is a
 * larger pass (it would need the overlay store to read/write the URL too).
 */
function writeActiveTags(tags: string[]): void {
  if (typeof window === "undefined" || !window.history) return;
  const params = new URLSearchParams(window.location.search);
  if (tags.length === 0) params.delete(FILTER_PARAM);
  else params.set(FILTER_PARAM, tags.join(","));
  const query = params.toString();
  const url = query ? `${window.location.pathname}?${query}` : window.location.pathname;
  window.history.replaceState(null, "", url);
}

type ChatState = {
  /**
   * Tag *labels* the chat stream is filtered by. Empty = show everything.
   * Tags are display + filter only — there is no edit/rename/delete; the user
   * changes tags by asking the agent (Product spec §4).
   */
  activeTagFilters: string[];
  /** Whether the TopBar Views dropdown is open. */
  viewsMenuOpen: boolean;

  toggleTagFilter: (label: string) => void;
  clearTagFilters: () => void;
  setViewsMenuOpen: (open: boolean) => void;
};

/**
 * Chat-shell UI state that isn't conversation content: the active tag filter and
 * the Views dropdown. Flux-style actions; components read via selectors. The tag
 * filter is mirrored into the URL on every change.
 */
export const useChatStore = create<ChatState>((set, get) => ({
  activeTagFilters: readActiveTags(),
  viewsMenuOpen: false,

  toggleTagFilter: (label) => {
    const current = get().activeTagFilters;
    const next = current.includes(label) ? current.filter((t) => t !== label) : [...current, label];
    writeActiveTags(next);
    set({ activeTagFilters: next });
  },

  clearTagFilters: () => {
    writeActiveTags([]);
    set({ activeTagFilters: [] });
  },

  setViewsMenuOpen: (open) => set({ viewsMenuOpen: open }),
}));
