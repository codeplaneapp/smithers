/** @jsxImportSource react */
import type { CSSProperties } from "react";
import { StatusPill as UiStatusPill } from "@smthrs/ui";

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
 * come from the shared status vocabulary (running = brand, ok = success,
 * waiting = warning, failed = danger, and cancelled/pending = neutral).
 */
export function StatusPill({ status, label, className, style }: StatusPillProps) {
  return <UiStatusPill status={status} label={label} className={className} style={style} />;
}
