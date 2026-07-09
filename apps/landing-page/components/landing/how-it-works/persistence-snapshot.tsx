import { SqliteStrip } from "@/components/landing/how-it-works/sqlite-strip";
import { StepRow } from "@/components/landing/shared/step-row";
import { HOW_IT_WORKS } from "@/lib/landing/content";
import { RUN_ID } from "@/lib/landing/constants";

export function PersistenceSnapshot() {
  return (
    <div className="rounded-lg border border-border bg-background/40 p-4">
      <p className="mb-3 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
        {RUN_ID}
      </p>

      <div className="grid gap-4 md:grid-cols-[1fr_auto]">
        <div className="space-y-1">
          <StepRow label="Scan" status="saved" detail="saved" animate />
          <StepRow label="Triage" status="running" detail="in progress" />
          <StepRow label="Fix" status="pending" />
        </div>
        <SqliteStrip rowCount={2} />
      </div>

      <p className="mt-4 font-mono text-[10px] text-muted-foreground">
        {HOW_IT_WORKS.renderLoop}
      </p>
    </div>
  );
}
