/** @jsxImportSource react */
import { useInsertionEffect, type CSSProperties } from "react";
import { ensureGatewayUiStyles, formatStatus, statusClass } from "./theme";

export type StatusPillProps = {
  /** A run/node status string, e.g. "running", "ok", "failed", "waiting". */
  status: string | undefined;
  /** Override the displayed label (defaults to the status, title-cased). */
  label?: string;
  className?: string;
  style?: CSSProperties;
};

/**
 * A small colored status badge. Pure — pass any run/node status string. Colors
 * come from the shared {@link statusColor} map (running = brand, ok = success,
 * waiting = warning, failed/cancelled = danger, everything else = neutral).
 */
export function StatusPill({ status, label, className, style }: StatusPillProps) {
  useInsertionEffect(ensureGatewayUiStyles, []);
  const tone = statusClass(status);
  const text = label ?? formatStatus(status);
  return (
    <span
      className={["gw-status-pill", "badge", tone, className].filter(Boolean).join(" ")}
      data-status={status}
      style={{
        ...style,
      }}
    >
      <span aria-hidden className="gw-status-pill-dot" />
      {text}
    </span>
  );
}
