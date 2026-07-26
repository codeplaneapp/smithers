import { create } from "zustand";
import type { CommandId } from "../commands";
import type { ComposeRect } from "../chat/composeHandoffStore";

export type NotificationStatus = "running" | "done" | "failed";

export type Notification = {
  id: string;
  title: string;
  detail?: string;
  /** Workflows persist until `status` is "done"; transient toasts time out. */
  kind: "workflow" | "transient";
  status: NotificationStatus;
  /** The view the "View workflow" action reopens. */
  command?: CommandId;
  /** Real gateway workflow run this toast represents. */
  runId?: string;
  workflowKey?: string;
  /** Source geometry for the compose-card → toast FLIP handoff. */
  morphFrom?: ComposeRect;
};

export type NotificationInput = Omit<Notification, "id" | "status"> & {
  status?: NotificationStatus;
};

/** Transient toasts vanish after this long; workflow toasts only after done. */
const TRANSIENT_MS = 4000;
const DONE_LINGER_MS = 4500;

// Pending auto-dismiss timers, keyed by notification id. Kept out of state: a
// timer handle is not something a component renders.
const timers = new Map<string, ReturnType<typeof setTimeout>>();
let seq = 0;

type NotificationsState = {
  notifications: Notification[];
  notify: (input: NotificationInput) => string;
  update: (id: string, patch: Partial<Notification>) => void;
  dismiss: (id: string) => void;
};

/**
 * The corner toast stack on the `ephemeral` medium. Self-dismissing: timers live
 * in the store (the memory's "timers go in a store"), so the toast component is
 * pure render with no effect.
 */
export const useNotificationsStore = create<NotificationsState>((set, get) => {
  function schedule(id: string, delay: number): void {
    const existing = timers.get(id);
    if (existing) {
      clearTimeout(existing);
    }
    timers.set(
      id,
      setTimeout(() => get().dismiss(id), delay),
    );
  }

  return {
    notifications: [],
    notify: (input) => {
      seq += 1;
      const id = `n${seq}`;
      const status = input.status ?? "running";
      set((state) => ({
        notifications: [...state.notifications, { ...input, id, status }],
      }));
      // Transient toasts always time out; a workflow toast only times out once
      // it is no longer running (mirrors the old Toast effect's logic).
      if (input.kind === "transient" || status !== "running") {
        schedule(id, status === "running" ? TRANSIENT_MS : DONE_LINGER_MS);
      }
      return id;
    },
    update: (id, patch) => {
      set((state) => ({
        notifications: state.notifications.map((item) => (item.id === id ? { ...item, ...patch } : item)),
      }));
      if (patch.status === "done" || patch.status === "failed") {
        schedule(id, DONE_LINGER_MS);
      }
    },
    dismiss: (id) => {
      const timer = timers.get(id);
      if (timer) {
        clearTimeout(timer);
        timers.delete(id);
      }
      set((state) => ({
        notifications: state.notifications.filter((item) => item.id !== id),
      }));
    },
  };
});
