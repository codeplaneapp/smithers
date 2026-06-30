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

  if (!pending) {
    return null;
  }

  return (
    <div className="control-dialog-backdrop" role="presentation" onClick={denyControl}>
      <div
        className="control-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="control-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="control-dialog-title" id="control-dialog-title">
          Let Smithers control the app?
        </h2>
        <p className="control-dialog-reason">{pending.reason}</p>

        {pending.actions.length > 0 ? (
          <ul className="control-action-list">
            {pending.actions.map((action, index) => (
              <li key={index}>{describeDirective(action)}</li>
            ))}
          </ul>
        ) : null}

        <div className="control-dialog-actions">
          <button className="control-deny" type="button" onClick={denyControl}>
            Deny
          </button>
          <button className="control-allow" type="button" onClick={grantControl}>
            Allow
          </button>
        </div>
      </div>
    </div>
  );
}
