import { create } from "zustand";
import type { Toast } from "./Toast";
import { mockToasts } from "./mockToasts";

type ToastState = {
  toasts: Toast[];
  /** Push an ephemeral, non-run notice (auto-managed by callers). */
  notify: (message: string) => void;
  dismiss: (id: string) => void;
};

/**
 * The upper-right toast stack. SEAM: seeded from `mockToasts` (run toasts in
 * each state); the real Monitor agent reconciles run toasts frame-by-frame.
 * `notify` adds neutral ephemeral notices (e.g. the model-switch warning).
 *
 * Toasts do not auto-dismiss on a timer here — there is no useEffect/timer in
 * this mock pass (Engineering rule: no useEffect). Terminal/ephemeral linger is
 * a real-backend concern; the user can dismiss manually. TODO: drive linger from
 * the Monitor agent's frames rather than a client timer.
 */
export const useToastStore = create<ToastState>((set) => ({
  toasts: mockToasts,

  notify: (message) =>
    set((state) => ({
      toasts: [{ kind: "ephemeral", id: crypto.randomUUID(), message }, ...state.toasts],
    })),

  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
}));
