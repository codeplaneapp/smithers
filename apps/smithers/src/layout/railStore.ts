import type { KeyboardEvent, PointerEvent } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Resize bounds for the chat rail, in pixels. A drag narrower than COLLAPSE_AT
 * snaps the rail shut; between COLLAPSE_AT and MIN the width holds at MIN, so
 * there's a small dead zone before it disappears (VS Code-style).
 */
export const RAIL_MIN = 260;
export const RAIL_MAX = 560;
export const RAIL_DEFAULT = 320;
export const COLLAPSE_AT = 170;
export const RAIL_KEYBOARD_STEP = 20;

type RailState = {
  /** Current expanded width in px (meaningless while `collapsed`). */
  width: number;
  /** Whether the rail is dragged fully shut. */
  collapsed: boolean;
  /** True while a drag is in flight — lets the shell lock the cursor. */
  resizing: boolean;
  /** Width to restore to when expanding, even if a drag clamped width to MIN. */
  lastOpenWidth: number;
  expand: () => void;
  collapse: () => void;
  resizeBy: (delta: number) => void;
  resizeTo: (width: number) => void;
  onResizeKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  onResizeStart: (event: PointerEvent<HTMLElement>) => void;
  onResizeMove: (event: PointerEvent<HTMLElement>) => void;
  onResizeEnd: (event: PointerEvent<HTMLElement>) => void;
};

function resizePatch(width: number): Pick<RailState, "width" | "lastOpenWidth" | "collapsed"> {
  const clamped = Math.min(RAIL_MAX, Math.max(RAIL_MIN, width));
  return { width: clamped, lastOpenWidth: clamped, collapsed: false };
}

/**
 * Drag-to-resize state for the sidebar chat rail on the `local` medium. The rail
 * hugs the viewport's left edge, so the pointer's clientX is the rail's width —
 * no measuring needed. Width and collapsed persist; `resizing`/`lastOpenWidth`
 * are transient (see `partialize`).
 */
export const useRailStore = create<RailState>()(
  persist(
    (set) => ({
      width: RAIL_DEFAULT,
      collapsed: false,
      resizing: false,
      lastOpenWidth: RAIL_DEFAULT,
      expand: () => set({ collapsed: false }),
      collapse: () => set({ collapsed: true }),
      resizeBy: (delta) =>
        set((state) => {
          if (state.collapsed) {
            return delta > 0 ? { collapsed: false } : {};
          }
          const next = state.width + delta;
          return next < COLLAPSE_AT ? { collapsed: true } : resizePatch(next);
        }),
      resizeTo: (width) => set(width < COLLAPSE_AT ? { collapsed: true } : resizePatch(width)),
      onResizeKeyDown: (event) => {
        let handled = true;
        const state = useRailStore.getState();
        switch (event.key) {
          case "ArrowLeft":
          case "ArrowDown":
            state.resizeBy(-RAIL_KEYBOARD_STEP);
            break;
          case "ArrowRight":
          case "ArrowUp":
            state.resizeBy(RAIL_KEYBOARD_STEP);
            break;
          case "Home":
            state.collapse();
            break;
          case "End":
            state.resizeTo(RAIL_MAX);
            break;
          case "Enter":
          case " ":
            if (state.collapsed) {
              state.expand();
            } else {
              state.collapse();
            }
            break;
          default:
            handled = false;
        }
        if (handled) {
          event.preventDefault();
          event.stopPropagation();
        }
      },
      onResizeStart: (event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        set({ resizing: true });
      },
      onResizeMove: (event) => {
        // Only react to the captured drag, not stray hover moves over the handle.
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
          return;
        }
        const next = event.clientX;
        if (next < COLLAPSE_AT) {
          set({ collapsed: true });
          return;
        }
        set(resizePatch(next));
      },
      onResizeEnd: (event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        set({ resizing: false });
      },
    }),
    {
      name: "smithers.rail",
      partialize: (state) => ({ width: state.width, collapsed: state.collapsed }),
    },
  ),
);
