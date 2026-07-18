/** @jsxImportSource react */
import { useEffect, useMemo, useState } from "react";
import { StatCard } from "./monitorOps.tsx";
import { asNumber } from "./monitorModel.ts";
import { useJsonApi, useNowMs } from "./monitorShared.tsx";
import {
  burnRateTokensPerMin,
  costRowsOf,
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

export function RunCostCard({
  runId,
  active = true,
  progressRatio,
}: {
  runId: string;
  active?: boolean;
  progressRatio?: number;
}) {
  const api = useJsonApi(`/v1/api/runs/${encodeURIComponent(runId)}/token-usage`, active ? 10_000 : null);
  const now = useNowMs();
  const usage = useMemo(() => runTokenUsageOf(api.body), [api.body]);
  if (!api.loaded) {
    return (
      <div className="mon-stat" data-testid="monitor-run-cost">
        {api.failed ? "gateway did not answer" : "loading cost…"}
      </div>
    );
  }
  if (!usage) {
    return <div className="mon-stat" data-testid="monitor-run-cost">gateway did not answer</div>;
  }
  const costs = costRowsOf(api.body);
  const burn = burnRateTokensPerMin(usage.buckets, now);
  const projected = projectedRunTokens(usage.totals, progressRatio, active);
  return (
    <div className="mon-stat" data-testid="monitor-run-cost">
      <div className="mon-stat-value mon-mono">{costs.unpriced ? "unpriced" : formatUsd(costs.totalUsd)}</div>
      <div className="mon-stat-label">run cost</div>
      <div className="mon-stat-sub mon-dim">
        {formatTokensCompact(usage.totals.tokens)} tokens
        {burn === null ? "" : ` · ${formatTokensCompact(burn)}/min`}
        {projected === null ? "" : ` · ~${formatTokensCompact(projected)} projected`}
      </div>
      {costs.rows.map((row) => (
        <div
          className="mon-stat-sub mon-dim"
          key={`${row.engine}-${row.model}`}
          data-testid="monitor-run-cost-model"
        >
          {row.engine} · {row.model}: {formatTokensCompact(row.tokens)}
          {row.priced ? ` · ${formatUsd(row.costUsd)}` : " · unpriced"}
        </div>
      ))}
      {api.failed ? <div className="mon-stat-sub mon-dim">gateway did not answer</div> : null}
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
    ? `reset in ${Math.max(0, Math.round((reset - now) / 60_000))}m`
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
