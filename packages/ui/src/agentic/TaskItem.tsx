/** @jsxImportSource react */
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../cn";
import { formatStatus, normalizeStatus, statusClass } from "../status";
import { useInjectUiCss } from "../styles";

export type TaskItemProps = Omit<ComponentProps<"div">, "children"> & {
  label: ReactNode;
  status: string;
  files?: readonly string[];
  elapsedSeconds?: number;
};

function formatDuration(n: number): string {
  if (n < 60) return `${Math.round(n)}s`;
  return `${Math.floor(n / 60)}m ${String(Math.round(n % 60)).padStart(2, "0")}s`;
}

/** A compact status-aware unit-of-work row for plans and standalone lists. */
export function TaskItem({
  label,
  status,
  files,
  elapsedSeconds,
  className,
  ...props
}: TaskItemProps) {
  useInjectUiCss();
  const normalized = normalizeStatus(status);
  const tone = statusClass(status);

  return (
    <div
      data-slot="task-item"
      data-status={normalized}
      className={cn("sui-taskitem", `sui-taskitem-${tone}`, className)}
      {...props}
    >
      <span className="sui-taskitem-dot" aria-hidden="true" />
      <span className="sui-sr-only">{formatStatus(status)}: </span>
      <span className="sui-taskitem-label">{label}</span>
      {files && files.length > 0 ? (
        <span data-slot="task-item-files" className="sui-taskitem-files">
          {files.map((file) => (
            <span className="sui-taskitem-file" key={file}>{file}</span>
          ))}
        </span>
      ) : null}
      {elapsedSeconds !== undefined ? (
        <span className="sui-taskitem-elapsed">{formatDuration(elapsedSeconds)}</span>
      ) : null}
    </div>
  );
}
