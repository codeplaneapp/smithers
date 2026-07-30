/** @jsxImportSource react */
import { useInsertionEffect, type CSSProperties } from "react";
import { ensureGatewayUiStyles, formatStatus, statusClass, theme } from "./theme";

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
 * resolve through gateway-ui's own semantic token bridge (running = brand,
 * ok = success, waiting = warning, failed = danger, everything else = neutral).
 */
export function StatusPill({ status, label, className, style }: StatusPillProps) {
  useInsertionEffect(ensureGatewayUiStyles, []);
  const tone = statusClass(status);
  const text = label ?? formatStatus(status);
  const colors = {
    run: { color: theme.accent, background: theme.accentSoft, borderColor: theme.accentBorder },
    ok: { color: theme.success, background: theme.successSoft, borderColor: theme.successBorder },
    warn: { color: theme.warning, background: theme.warningSoft, borderColor: theme.warningBorder },
    bad: { color: theme.danger, background: theme.dangerSoft, borderColor: theme.dangerBorder },
    muted: { color: theme.textDim, background: theme.neutralSoft, borderColor: theme.neutralBorder },
  }[tone];
  return (
    <span
      className={["gw-status-pill", className].filter(Boolean).join(" ")}
      data-status={status}
      data-status-class={tone}
      style={{
        ...colors,
        ...style,
      }}
    >
      <span aria-hidden className="gw-status-pill-dot" />
      {text}
    </span>
  );
}
