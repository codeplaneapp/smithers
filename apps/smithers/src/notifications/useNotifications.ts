import { useCallback, useRef, useState } from "react";
import type { CommandId } from "../CommandMenu";

export type NotificationStatus = "running" | "done";

export type Notification = {
  id: string;
  title: string;
  detail?: string;
  /** Workflows persist until `status` is "done"; transient toasts time out. */
  kind: "workflow" | "transient";
  status: NotificationStatus;
  /** The view the "View workflow" action reopens. */
  command?: CommandId;
};

export type NotificationInput = Omit<Notification, "id" | "status"> & {
  status?: NotificationStatus;
};

export type NotificationsApi = {
  notifications: Notification[];
  notify: (input: NotificationInput) => string;
  update: (id: string, patch: Partial<Notification>) => void;
  dismiss: (id: string) => void;
};

/** A tiny in-app notification store backing the corner toast stack. */
export function useNotifications(): NotificationsApi {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const idRef = useRef(0);

  const notify = useCallback((input: NotificationInput) => {
    idRef.current += 1;
    const id = `n${idRef.current}`;
    setNotifications((prev) => [
      ...prev,
      { ...input, id, status: input.status ?? "running" },
    ]);
    return id;
  }, []);

  const update = useCallback((id: string, patch: Partial<Notification>) => {
    setNotifications((prev) =>
      prev.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  }, []);

  const dismiss = useCallback((id: string) => {
    setNotifications((prev) => prev.filter((item) => item.id !== id));
  }, []);

  return { notifications, notify, update, dismiss };
}
