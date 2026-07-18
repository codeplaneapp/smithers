/** @jsxImportSource react */
import { Countdown } from "./monitorShared.tsx";
import { shortRunId } from "./monitorModel.ts";
import { type AttentionItem } from "./monitorAttentionModel.ts";

// A workspace sweep can flag dozens of stale runs at once; keep the banner a
// glanceable strip (crit-first ordering means the cap drops the mildest items).
export const MAX_ATTENTION_ITEMS = 8;

export function AttentionBannerView({
  items,
  total,
  onSelectRun,
}: {
  items: AttentionItem[];
  total: number;
  onSelectRun: (id: string) => void;
}) {
  if (!items.length) return null;
  return (
    <section className="mon-attention" data-testid="monitor-attention" aria-label="Workspace attention">
      <h2 className="mon-kicker">
        Needs attention <span className="mon-count">{total}</span>
      </h2>
      {items.map((item) => (
        <button
          key={`${item.runId}:${item.kind}`}
          type="button"
          className={`tone-${item.tone}`}
          title={item.detail}
          onClick={() => onSelectRun(item.runId)}
        >
          <span className="mon-mono">{shortRunId(item.runId)}</span>{" "}
          {item.workflowKey ? `${item.workflowKey}: ` : ""}
          {item.headline} {item.resetAtMs ? <Countdown untilMs={item.resetAtMs} /> : null}
        </button>
      ))}
      {total > items.length ? <span>+{total - items.length} more</span> : null}
    </section>
  );
}
