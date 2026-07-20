import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { AppId } from "./App";

type DockState = {
  /** Open apps, in the order they were first opened. Persisted. */
  openAppIds: AppId[];
  /** Add an app to the dock if it is not already there (idempotent). Called by
   *  the route binding whenever an app becomes the active route. */
  registerActive: (id: AppId) => void;
  /** Remove an app from the dock. Post-close focus is the caller's job. */
  closeApp: (id: AppId) => void;
};

/**
 * The set of open apps shown in the right-edge dock, on the `local` medium. The
 * URL stays the source of truth for which app is *focused*; this store only
 * tracks which apps are *open*. Persisted so the dock survives a reload (see
 * `.smithers/specs/apps-and-workflows-dock.md`).
 */
export const useDockStore = create<DockState>()(
  persist(
    (set, get) => ({
      openAppIds: [],
      registerActive: (id) => {
        if (get().openAppIds.includes(id)) return;
        set((state) => ({ openAppIds: [...state.openAppIds, id] }));
      },
      closeApp: (id) =>
        set((state) => ({ openAppIds: state.openAppIds.filter((openId) => openId !== id) })),
    }),
    {
      name: "smithers.dock",
      partialize: (state) => ({ openAppIds: state.openAppIds }),
    },
  ),
);
