import { useEffect, useRef, useState } from "react";
import type { Notification } from "./useNotifications";

/** Transient toasts vanish after this long; workflow toasts only after done. */
const TRANSIENT_MS = 4000;
const DONE_LINGER_MS = 4500;

function Toast({
  notification,
  onView,
  onDismiss,
}: {
  notification: Notification;
  onView: (notification: Notification) => void;
  onDismiss: (id: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const running = notification.status === "running";

  // Auto-dismiss: transient toasts on a timer, workflow toasts once they finish.
  useEffect(() => {
    const timed = notification.kind === "transient" || !running;
    if (!timed) {
      return;
    }
    const delay = running ? TRANSIENT_MS : DONE_LINGER_MS;
    const timer = window.setTimeout(() => onDismiss(notification.id), delay);
    return () => window.clearTimeout(timer);
  }, [notification.kind, notification.id, running, onDismiss]);

  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  return (
    <div className={`toast toast-${notification.status}`} ref={ref}>
      <button
        aria-expanded={menuOpen}
        aria-haspopup="menu"
        className="toast-main"
        type="button"
        onClick={() => setMenuOpen((open) => !open)}
      >
        {running ? (
          <span className="toast-spinner" aria-hidden="true" />
        ) : (
          <svg
            aria-hidden="true"
            className="toast-check"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle cx="12" cy="12" r="10" fill="#0f8f78" />
            <path
              d="m8 12 3 3 5-6"
              stroke="#ffffff"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
            />
          </svg>
        )}
        <span className="toast-text">
          <span className="toast-title">{notification.title}</span>
          {notification.detail ? (
            <span className="toast-detail" key={notification.detail}>
              {notification.detail}
            </span>
          ) : null}
        </span>
        <span className="toast-status">{running ? "Running" : "Done"}</span>
      </button>

      {menuOpen ? (
        <div className="toast-menu" role="menu">
          {notification.command ? (
            <button
              className="toast-action"
              role="menuitem"
              type="button"
              onClick={() => {
                onView(notification);
                setMenuOpen(false);
              }}
            >
              View workflow
            </button>
          ) : null}
          <button
            className="toast-action"
            role="menuitem"
            type="button"
            onClick={() => {
              onDismiss(notification.id);
              setMenuOpen(false);
            }}
          >
            Dismiss
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Corner stack of toasts for background/workflow runs. */
export function Toasts({
  notifications,
  onView,
  onDismiss,
}: {
  notifications: Notification[];
  onView: (notification: Notification) => void;
  onDismiss: (id: string) => void;
}) {
  if (notifications.length === 0) {
    return null;
  }
  return (
    <div className="toast-stack" aria-live="polite">
      {notifications.map((notification) => (
        <Toast
          key={notification.id}
          notification={notification}
          onView={onView}
          onDismiss={onDismiss}
        />
      ))}
    </div>
  );
}
