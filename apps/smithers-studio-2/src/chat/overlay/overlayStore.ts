import { create } from "zustand";
import type { Overlay, OverlayPresentation } from "./Overlay";
import { clampSplitFraction, DEFAULT_SPLIT_FRACTION } from "./clampSplitFraction";

const SPLIT_PARAM = "split";

/** Read the persisted split fraction from the URL (shareable / Back-Forward). */
function readSplitFraction(): number {
  if (typeof window === "undefined") return DEFAULT_SPLIT_FRACTION;
  const raw = new URLSearchParams(window.location.search).get(SPLIT_PARAM);
  if (!raw) return DEFAULT_SPLIT_FRACTION;
  return clampSplitFraction(Number.parseFloat(raw));
}

/** Reflect the split fraction into the URL (Engineering spec §3: URL is state). */
function writeSplitFraction(fraction: number): void {
  if (typeof window === "undefined" || !window.history) return;
  const params = new URLSearchParams(window.location.search);
  params.set(SPLIT_PARAM, fraction.toFixed(3));
  const query = params.toString();
  window.history.replaceState(null, "", `${window.location.pathname}?${query}`);
}

type OverlayState = {
  /** At most one overlay is shown at a time. */
  overlay: Overlay | null;
  presentation: OverlayPresentation;
  /**
   * Chat-column fraction for the split divider (0.25–0.75). Persisted in the URL
   * so a split layout is shareable and Back/Forward navigable (Design spec §5,
   * Engineering spec §3).
   */
  splitFraction: number;
  open: (overlay: Overlay, presentation?: OverlayPresentation) => void;
  close: () => void;
  setPresentation: (presentation: OverlayPresentation) => void;
  setSplitFraction: (fraction: number) => void;
};

/**
 * The single overlay layered over — or split beside — the chat. Both the agent
 * (via feed items) and slash commands drive this store; `OverlayHost` renders
 * whatever is here. The draggable divider writes `splitFraction` through an
 * action; the store mirrors it into the URL (no effects).
 */
export const useOverlayStore = create<OverlayState>((set) => ({
  overlay: null,
  presentation: "split",
  splitFraction: readSplitFraction(),
  open: (overlay, presentation = "split") => set({ overlay, presentation }),
  close: () => set({ overlay: null }),
  setPresentation: (presentation) => set({ presentation }),
  setSplitFraction: (fraction) => {
    const next = clampSplitFraction(fraction);
    writeSplitFraction(next);
    set({ splitFraction: next });
  },
}));
