/** @jsxImportSource react */
import type { ComponentProps } from "react";
import { Badge, type BadgeProps } from "./badge";
import { formatStatus, statusClass, type StatusClass } from "./status";

const STATUS_VARIANT: Record<StatusClass, NonNullable<BadgeProps["variant"]>> = {
  ok: "success",
  warn: "warning",
  bad: "destructive",
  muted: "muted",
  run: "default",
};

export type StatusPillProps = Omit<ComponentProps<"span">, "children"> & {
  /** A run/node status string, e.g. "running", "ok", "failed", "waiting". */
  status: string | undefined;
  /** Override the displayed label (defaults to the status, title-cased). */
  label?: string;
  /** Show the leading colored dot (default true); pass `false` to hide it. */
  withDot?: boolean;
};

/**
 * Status string in, correctly tinted Badge out: success for finished states,
 * warning for anything in flight, destructive for failures, muted for
 * cancelled/skipped/unknown. Carries `data-status` for tests and styling.
 */
export function StatusPill({ status, label, withDot = true, className, ...props }: StatusPillProps) {
  return (
    <Badge
      variant={STATUS_VARIANT[statusClass(status)]}
      data-status={status}
      className={className}
      {...props}
    >
      {withDot ? <span aria-hidden className="sui-status-dot" /> : null}
      {label ?? formatStatus(status)}
    </Badge>
  );
}
