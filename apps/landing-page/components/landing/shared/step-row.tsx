"use client";

import type { StepStatus } from "@/lib/landing/types";
import { useStepDetailMinWidth } from "@/lib/landing/text-measure";
import { StepStatusIcon } from "@/components/landing/shared/step-status-icon";
import { cn } from "@/lib/utils";

const labelClass: Record<StepStatus, string> = {
  pending: "text-muted-foreground",
  running: "text-foreground",
  retry: "text-foreground",
  saved: "text-foreground",
  waiting: "text-primary",
  skipped: "text-muted-foreground",
};

type StepRowProps = {
  label: string;
  status: StepStatus;
  detail?: string;
  detailClassName?: string;
  detailColumn?: boolean;
  animate?: boolean;
  className?: string;
};

export function StepRow({
  label,
  status,
  detail,
  detailClassName,
  detailColumn = false,
  animate,
  className,
}: StepRowProps) {
  const detailMinWidth = useStepDetailMinWidth();
  const showDetailColumn = detailColumn || detail !== undefined;

  return (
    <div
      className={cn(
        "flex gap-2 rounded-md px-1.5 py-1.5 font-mono text-[11px] sm:gap-3 sm:px-2 sm:text-xs",
        detailColumn
          ? "flex-col items-stretch sm:flex-row sm:items-center sm:justify-between"
          : "items-center justify-between",
        status === "waiting" && "landing-pulse-ring bg-accent/30",
        status === "skipped" && "opacity-50",
        animate && status === "saved" && "landing-persist",
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <StepStatusIcon status={status} />
        <span className={cn("truncate", labelClass[status])}>{label}</span>
      </div>
      {showDetailColumn && (
        <span
          className={cn(
            "truncate text-muted-foreground transition-opacity duration-500 ease-out sm:max-w-[12rem] sm:shrink-0 sm:text-right",
            !detail && "opacity-0",
            detailClassName,
          )}
          style={{ minWidth: detailMinWidth }}
        >
          {detail ?? "\u00a0"}
        </span>
      )}
    </div>
  );
}
