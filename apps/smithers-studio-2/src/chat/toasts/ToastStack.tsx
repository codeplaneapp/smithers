import { useToastStore } from "./toastStore";
import { useOverlayStore } from "../overlay/overlayStore";
import type { RunState } from "./Toast";

/**
 * Run-state token per state. COLOR = STATE only — no invented colors (DESIGN.md):
 * blue = running, green = succeeded, red = failed.
 */
const RUN_STATE_COLOR: Record<RunState, string> = {
  running: "var(--accent)",
  succeeded: "var(--success)",
  failed: "var(--danger)",
};

const RUN_STATE_LABEL: Record<RunState, string> = {
  running: "RUNNING",
  succeeded: "SUCCEEDED",
  failed: "FAILED",
};

/**
 * Upper-right toast stack, newest on top. Run toasts are colored by run state
 * and clickable into the run (mock: opens an overlay). Ephemeral toasts are
 * neutral notices and are not run-state colored.
 */
export function ToastStack() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);
  const openOverlay = useOverlayStore((s) => s.open);

  if (toasts.length === 0) return null;

  return (
    <div aria-live="polite" className="toast-stack" data-testid="toast-stack">
      {toasts.map((toast) => {
        if (toast.kind === "ephemeral") {
          return (
            <div className="toast toast--ephemeral" data-testid="toast-ephemeral" key={toast.id}>
              <span className="toast-message">{toast.message}</span>
              <button
                className="toast-dismiss"
                data-testid="toast-dismiss"
                onClick={() => dismiss(toast.id)}
                title="Dismiss"
                type="button"
              >
                ✕
              </button>
            </div>
          );
        }
        const color = RUN_STATE_COLOR[toast.state];
        return (
          <button
            className="toast toast--run"
            data-state={toast.state}
            data-testid="toast-run"
            key={toast.id}
            onClick={() => openOverlay(toast.overlay, "split")}
            style={{ ["--toast-color" as string]: color }}
            type="button"
          >
            <span className="toast-state" style={{ color }}>
              {toast.state === "running" && <span className="toast-pulse" />}
              {RUN_STATE_LABEL[toast.state]}
            </span>
            <span className="toast-workflow">{toast.workflow}</span>
            <span className="toast-status">{toast.status}</span>
            <span
              aria-label="Dismiss"
              className="toast-dismiss"
              data-testid="toast-dismiss"
              onClick={(event) => {
                event.stopPropagation();
                dismiss(toast.id);
              }}
              role="button"
              tabIndex={-1}
            >
              ✕
            </span>
          </button>
        );
      })}
    </div>
  );
}
