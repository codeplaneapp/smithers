/** @jsxImportSource react */
import { type ReactNode } from "react";
import { RowButton } from "smithers-orchestrator/ui";
import { type Tone } from "./monitorModel.ts";

export function RunRailRow({
  runId,
  name,
  title,
  shortId,
  tone,
  pulse,
  when,
  active,
  onSelect,
  badge,
}: {
  runId: string;
  name: string;
  title: string;
  shortId: string;
  tone: Tone;
  pulse: boolean;
  when: ReactNode;
  active: boolean;
  onSelect: (runId: string) => void;
  badge?: ReactNode;
}) {
  return (
    <RowButton
      active={active}
      className="mon-run-row"
      data-testid="monitor-run-row"
      data-run-id={runId}
      onClick={() => onSelect(runId)}
    >
      <span className={`mon-dot tone-${tone}${pulse ? " mon-dot-pulse" : ""}`} aria-hidden />
      <span className="mon-run-name" title={title}>
        {name}
      </span>
      {badge}
      <span className="mon-mono mon-dim">{shortId}</span>
      <span className="mon-run-when mon-dim">{when}</span>
    </RowButton>
  );
}
