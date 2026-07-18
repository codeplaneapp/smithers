/** @jsxImportSource react */
import { useEffect, useMemo, useState } from "react";
import { useGatewayRunTree } from "smithers-orchestrator/gateway-react";
import { StatCard } from "./monitorOps.tsx";
import { asNumber, buildTimeline, isTerminalStatus, nodeStateRowsOf } from "./monitorModel.ts";
import { estimateRun, etaRefreshMs, workloadExtent } from "./monitorEtaModel.ts";
import { EtaFactCells } from "./monitorEta.tsx";
import { FactCell, useJsonApi, useNowMs } from "./monitorShared.tsx";
import {
  burnRateTokensPerMin,
  costRowsOf,
  formatDurationCoarse,
  formatTokensCompact,
  formatUsd,
  projectedRunTokens,
  pushPercentSample,
  projectWindowRunout,
  runTokenUsageOf,
  runoutWarning,
  usageReportsOf,
  type PercentSample,
} from "./monitorUsageModel.ts";

/**
 * The run header's facts band: Cost · Tokens · ETA · Tasks · Elapsed as one
 * grid of aligned numerics. Per-model cost rows fold into a "by model"
 * disclosure beneath the band instead of stacking inside a floating card.
 */
export function RunFactsBand({
  runId,
  runStatus,
  active = true,
  progressRatio,
  startedAtMs,
  finishedAtMs,
}: {
  runId: string;
  runStatus?: string;
  active?: boolean;
  progressRatio?: number;
  startedAtMs?: number;
  finishedAtMs?: number;
}) {
  const api = useJsonApi(`/v1/api/runs/${encodeURIComponent(runId)}/token-usage`, active ? 10_000 : null);
  const nodeStates = useJsonApi(`/v1/api/runs/${encodeURIComponent(runId)}/node-states`, etaRefreshMs(runStatus));
  const tree = useGatewayRunTree(runId);
  const now = useNowMs();
  const usage = useMemo(() => runTokenUsageOf(api.body), [api.body]);
  const costs = costRowsOf(api.body);
  const burn = usage ? burnRateTokensPerMin(usage.buckets, now) : null;
  const projected = usage ? projectedRunTokens(usage.totals, progressRatio, active) : null;
  const costValue = !api.loaded
    ? api.failed ? "—" : "…"
    : !usage ? "—" : costs.unpriced ? "unpriced" : formatUsd(costs.totalUsd);
  const costSub = api.failed || (api.loaded && !usage)
    ? "gateway did not answer"
    : projected === null ? undefined : `~${formatTokensCompact(projected)} projected`;

  const rows = nodeStateRowsOf(nodeStates.body);
  // An empty collection is only a real zero once the tree query is ready.
  // Until then, omit the agent count instead of briefly claiming there are none.
  const nodes = tree.isLoading || tree.error ? undefined : tree.nodes;
  const extent = workloadExtent(rows, nodes, startedAtMs, finishedAtMs ?? now);
  const estimate = estimateRun(buildTimeline(rows, now), now, { openEnded: extent.atLeast });

  return (
    <div data-testid="monitor-run-facts">
      <div className="mon-facts">
        <FactCell value={costValue} label="run cost" sub={costSub} testId="monitor-run-cost" />
        {usage ? (
          <FactCell
            value={formatTokensCompact(usage.totals.tokens)}
            label="tokens"
            sub={burn === null ? undefined : `${formatTokensCompact(burn)}/min`}
            testId="monitor-fact-tokens"
          />
        ) : null}
        {nodeStates.loaded ? (
          <EtaFactCells estimate={estimate} extent={extent} showEstimate={!isTerminalStatus(runStatus)} />
        ) : null}
      </div>
      {costs.rows.length > 0 ? (
        <details className="mon-facts-models">
          <summary>
            <span className="mon-diff-caret" aria-hidden>▸</span> by model
          </summary>
          {costs.rows.map((row) => (
            <div className="mon-fact-model-row" key={`${row.engine}-${row.model}`} data-testid="monitor-run-cost-model">
              <span>{row.engine} · {row.model}</span>
              <span>
                {formatTokensCompact(row.tokens)}
                {row.priced ? ` · ${formatUsd(row.costUsd)}` : " · unpriced"}
              </span>
            </div>
          ))}
        </details>
      ) : null}
    </div>
  );
}

function AccountWindowCard({ report, window, now }: { report: Record<string, unknown>; window: Record<string, unknown>; now: number }) {
  const percent = asNumber(window.usedPercent ?? window.used_percent);
  const reset = Date.parse(String(window.resetsAt ?? window.resets_at));
  const [samples, setSamples] = useState<PercentSample[]>([]);
  useEffect(() => {
    if (percent !== undefined) setSamples((old) => pushPercentSample(old, percent, now));
  }, [percent, now]);
  const runout = Number.isFinite(reset) ? projectWindowRunout(samples, reset) : null;
  const warning = Number.isFinite(reset) ? runoutWarning(runout, reset) : null;
  const account = String(report.accountLabel ?? report.account_label ?? "account");
  const label = String(window.label ?? window.name ?? window.window ?? "quota");
  const resetLabel = Number.isFinite(reset)
    ? `resets in ${formatDurationCoarse(reset - now)}`
    : "reset unknown";
  return (
    <StatCard
      value={percent !== undefined ? `${Math.round(percent)}%` : "—"}
      label={`${account} · ${label}`}
      sub={`${resetLabel}${warning ? ` · ${warning}` : ""}${report.stale ? " · cached" : ""}`}
      tone={(percent ?? 0) >= 80 || warning ? "waiting" : undefined}
      testId="monitor-account-usage"
    />
  );
}

export function AccountUsageCards() {
  const api = useJsonApi("/v1/api/usage", 60_000);
  const now = useNowMs();
  const reports = usageReportsOf(api.body);
  if (!api.loaded) {
    return (
      <div className="mon-stat" data-testid="monitor-account-usage">
        {api.failed ? "gateway did not answer" : "loading subscription usage…"}
      </div>
    );
  }
  if (!reports.length) {
    return (
      <div className="mon-stat" data-testid="monitor-account-usage">
        {api.failed ? "gateway did not answer" : "no subscription usage reported"}
      </div>
    );
  }
  const cards = reports.flatMap((report) => {
    const windows = Array.isArray(report.windows) ? report.windows : [];
    return windows
      .filter((window): window is Record<string, unknown> => typeof window === "object" && window !== null)
      .map((window, index) => (
        <AccountWindowCard
          key={`${String(report.accountLabel ?? report.account_label)}-${index}`}
          report={report}
          window={window}
          now={now}
        />
      ));
  });
  if (!cards.length) {
    return <div className="mon-stat" data-testid="monitor-account-usage">no subscription windows reported</div>;
  }
  return <>{cards}</>;
}
