import type { NodeStatus } from "../runs/Run";
import { statusLabel, statusTone } from "../runs/statusMeta";

/** The rounded state pill (dot + label) used on cards and surface headers. */
export function StatusPill({
  status,
  label,
}: {
  status: NodeStatus;
  label?: string;
}) {
  return (
    <span className={`status-pill tone-${statusTone(status)}`}>
      <span className="status-dot" />
      {label ?? statusLabel(status)}
    </span>
  );
}
