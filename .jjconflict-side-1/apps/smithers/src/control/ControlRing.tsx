import { useControlStore } from "./controlStore";
import "./control.css";

/**
 * The agent-in-control indicator: a glowing ring around the whole viewport plus
 * a badge with a Stop button to take control back. Renders nothing while the
 * user holds control.
 */
export function ControlRing() {
  const controller = useControlStore((state) => state.controller);
  const releaseControl = useControlStore((state) => state.releaseControl);

  if (controller !== "agent") {
    return null;
  }

  return (
    <>
      <div className="control-ring" aria-hidden="true" />
      <div className="control-badge" role="status">
        <span className="control-badge-dot" aria-hidden="true" />
        <span className="control-badge-text">Smithers is controlling the app</span>
        <button className="control-stop" type="button" onClick={releaseControl}>
          Stop
        </button>
      </div>
    </>
  );
}
