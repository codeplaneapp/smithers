import { create } from "zustand";
import { persist } from "zustand/middleware";

type LogsPrefsState = {
  follow: boolean;
  hideNoise: boolean;
  redact: boolean;
  toggleFollow: () => void;
  toggleHideNoise: () => void;
  toggleRedact: () => void;
};

/**
 * The logs toolbar toggles on the `local` medium. These survive reload, and
 * `redact` defaults on so secrets stay masked until the reader opts out — a
 * secrets-mask default belongs in a persisted, audited place, not in render.
 */
export const useLogsPrefsStore = create<LogsPrefsState>()(
  persist(
    (set) => ({
      follow: true,
      hideNoise: false,
      redact: true,
      toggleFollow: () => set((state) => ({ follow: !state.follow })),
      toggleHideNoise: () => set((state) => ({ hideNoise: !state.hideNoise })),
      toggleRedact: () => set((state) => ({ redact: !state.redact })),
    }),
    { name: "smithers.logs", version: 1 },
  ),
);
