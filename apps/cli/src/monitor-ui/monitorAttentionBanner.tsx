/** @jsxImportSource react */
import { useGatewayApprovals } from "smithers-orchestrator/gateway-react";
import { Countdown, useNowMs } from "./monitorShared.tsx";
import { shortRunId, type RunRow } from "./monitorModel.ts";
import { workspaceAttention, type AttentionItem } from "./monitorAttentionModel.ts";

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

// A workspace sweep can flag dozens of stale runs at once; keep the banner a
// glanceable strip (crit-first ordering means the cap drops the mildest items).
const MAX_ATTENTION_ITEMS = 8;

export function AttentionBanner({ runs, onSelectRun }: { runs: RunRow[]; onSelectRun: (id: string) => void }) {
  const approvals = useGatewayApprovals().data ?? [];
  const attention = workspaceAttention(runs, approvals, useNowMs());
  return (
    <AttentionBannerView
      items={attention.items.slice(0, MAX_ATTENTION_ITEMS)}
      total={attention.total}
      onSelectRun={onSelectRun}
    />
  );
}
