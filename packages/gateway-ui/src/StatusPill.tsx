import type { CSSProperties } from "react";
import { statusColor } from "./theme";

export type StatusPillProps = {
  /** A run/node status string, e.g. "running", "ok", "failed", "waiting". */
  status: string | undefined;
  /** Override the displayed label (defaults to the status, title-cased). */
  label?: string;
  className?: string;
  style?: CSSProperties;
};

function titleCase(value: string): string {
  return value
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * A small colored status badge. Pure — pass any run/node status string. Colors
 * come from the shared {@link statusColor} map (running = blue, ok = green,
 * failed = red, waiting/pending = amber, everything else = neutral).
 */
export function StatusPill({ status, label, className, style }: StatusPillProps) {
  const color = statusColor(status);
  const text = label ?? (status ? titleCase(status) : "Unknown");
  return (
    <span
      className={className}
      data-status={status}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "2px 8px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 600,
        color,
        background: `${color}1f`,
        border: `1px solid ${color}55`,
        ...style,
      }}
    >
      <span
        aria-hidden
        style={{ width: 6, height: 6, borderRadius: 999, background: color }}
      />
      {text}
    </span>
  );
}
