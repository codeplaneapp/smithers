/** @jsxImportSource react */
import { RowButton } from "smithers-orchestrator/ui";
import { Countdown } from "./monitorShared.tsx";
import { Chip } from "./monitorShell.tsx";
import { shortRunId } from "./monitorModel.ts";
import { groupAttention, type AttentionItem } from "./monitorAttentionModel.ts";

// A workspace sweep can flag dozens of stale runs at once; the digest groups
// them by (workflow, headline) and shows at most this many rows — crit-first
// ordering means the cap drops the mildest groups. "View all" hands the full
// set to the runs table via the status filter.
export const MAX_ATTENTION_GROUPS = 4;

export function AttentionBannerView({
  items,
  total,
  onSelectRun,
  onViewAll,
}: {
  items: AttentionItem[];
  total: number;
  onSelectRun: (id: string) => void;
  onViewAll?: () => void;
}) {
  if (!items.length) return null;
  const groups = groupAttention(items);
  const shown = groups.slice(0, MAX_ATTENTION_GROUPS);
  return (
    <section className="mon-attention" data-testid="monitor-attention" aria-label="Workspace attention">
      <div className="mon-attention-head">
        <h2 className="mon-kicker">
          Needs attention <span className="mon-count">{total}</span>
        </h2>
      </div>
      {shown.map((group) => (
        <RowButton
          key={group.key}
          className={`mon-attention-row tone-${group.tone}`}
          title={`${group.count} run${group.count === 1 ? "" : "s"}: ${group.headline}`}
          onClick={() => onSelectRun(group.runIds[0]!)}
        >
          <span className="mon-dot" aria-hidden />
          <span className="mon-badge">×{group.count}</span>
          <span className="mon-attention-headline">
            {group.workflowKey ? `${group.workflowKey} — ` : ""}
            {group.headline}
          </span>
          <span className="mon-attention-runs">
            {group.runIds.slice(0, 2).map((id) => (
              <span key={id} className="mon-mono mon-dim">{shortRunId(id)}</span>
            ))}
            {group.count > 2 ? <span className="mon-dim">+{group.count - 2}</span> : null}
            {group.resetAtMs ? <span className="mon-dim"><Countdown untilMs={group.resetAtMs} /></span> : null}
          </span>
        </RowButton>
      ))}
      {onViewAll ? (
        <Chip className="mon-attention-viewall" data-testid="monitor-attention-viewall" onClick={onViewAll}>
          View all {total} →
        </Chip>
      ) : null}
    </section>
  );
}
