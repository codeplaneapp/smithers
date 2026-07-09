import { RUN_ID } from "@/lib/landing/constants";
import { cn } from "@/lib/utils";

type RunShellProps = {
  children: React.ReactNode;
  className?: string;
  compact?: boolean;
  runId?: string;
  headerRight?: React.ReactNode;
  hideChrome?: boolean;
};

export function RunShell({
  children,
  className,
  compact = false,
  runId = RUN_ID,
  headerRight,
  hideChrome = false,
}: RunShellProps) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border border-border bg-card shadow-lg shadow-black/20",
        className,
      )}
    >
      {!hideChrome && (
        <div
          className={cn(
            "flex items-center justify-between border-b border-border bg-background/60",
            compact ? "px-3 py-2" : "px-4 py-2.5",
          )}
        >
          <div className="flex min-w-0 items-center gap-2 sm:gap-3">
            <div className="flex shrink-0 gap-1.5">
              <span className="size-2.5 rounded-full bg-border" />
              <span className="size-2.5 rounded-full bg-border" />
              <span className="size-2.5 rounded-full bg-border" />
            </div>
            <span className="truncate font-mono text-[10px] text-muted-foreground sm:text-xs">
              {runId}
            </span>
          </div>
          {headerRight}
        </div>
      )}
      <div className={cn(compact ? "p-3" : "p-3 sm:p-4 md:p-5")}>{children}</div>
    </div>
  );
}
