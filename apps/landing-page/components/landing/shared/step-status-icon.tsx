import type { StepStatus } from "@/lib/landing/types";
import { cn } from "@/lib/utils";
import { Check, Circle, Loader2, Pause, RotateCw, type LucideIcon } from "lucide-react";

const statusIcons: Record<
  StepStatus,
  { Icon: LucideIcon; className: string }
> = {
  pending: {
    Icon: Circle,
    className: "size-3.5 text-muted-foreground",
  },
  running: {
    Icon: Loader2,
    className: "size-3.5 text-foreground landing-spin",
  },
  retry: {
    Icon: RotateCw,
    className: "size-3.5 text-destructive landing-spin",
  },
  saved: {
    Icon: Check,
    className: "size-3.5 text-primary",
  },
  waiting: {
    Icon: Pause,
    className: "size-3.5 text-primary",
  },
  skipped: {
    Icon: Check,
    className: "size-3.5 text-muted-foreground",
  },
};

type StepStatusIconProps = {
  status: StepStatus;
  className?: string;
};

export function StepStatusIcon({ status, className }: StepStatusIconProps) {
  const { Icon, className: iconClassName } = statusIcons[status];

  return (
    <Icon
      className={cn("w-4 shrink-0", iconClassName, className)}
      aria-hidden
    />
  );
}
