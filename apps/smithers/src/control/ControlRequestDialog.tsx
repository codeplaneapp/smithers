import { useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { describeDirective } from "./agentTools";
import { useControlStore } from "./controlStore";

/**
 * The approval gate. When the agent asks for control it queues its planned
 * actions; this lists them concretely so the user knows exactly what will happen
 * before allowing it. Clicking the backdrop denies. Renders nothing when idle.
 */
export function ControlRequestDialog() {
  const pending = useControlStore((state) => state.pendingControl);
  const grantControl = useControlStore((state) => state.grantControl);
  const denyControl = useControlStore((state) => state.denyControl);
  const denyButtonRef = useRef<HTMLButtonElement>(null);
  const allowButtonRef = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    if (!pending) {
      return;
    }

    const previouslyFocused = document.activeElement;
    denyButtonRef.current?.focus();

    return () => {
      if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) {
        previouslyFocused.focus();
      }
    };
  }, [pending]);

  if (!pending) {
    return null;
  }

  function trapFocus(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Tab") {
      return;
    }

    const first = denyButtonRef.current;
    const last = allowButtonRef.current;
    if (!first || !last) {
      return;
    }

    event.preventDefault();
    if (event.shiftKey) {
      (document.activeElement === first ? last : first).focus();
    } else {
      (document.activeElement === last ? first : last).focus();
    }
  }

  return (
    <div className="control-dialog-backdrop" role="presentation" onClick={denyControl}>
      <div
        className="control-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="control-dialog-title"
        aria-describedby="control-dialog-description"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={trapFocus}
      >
        <h2 className="control-dialog-title" id="control-dialog-title">
          Let Smithers control the app?
        </h2>
        <div id="control-dialog-description">
          <p className="control-dialog-reason">{pending.reason}</p>

          {pending.actions.length > 0 ? (
            <ul className="control-action-list">
              {pending.actions.map((action, index) => (
                <li key={index}>{describeDirective(action)}</li>
              ))}
            </ul>
          ) : null}
        </div>

        <div className="control-dialog-actions">
          <button className="control-deny" ref={denyButtonRef} type="button" onClick={denyControl}>
            Deny
          </button>
          <button className="control-allow" ref={allowButtonRef} type="button" onClick={grantControl}>
            Allow
          </button>
        </div>
      </div>
    </div>
  );
}
