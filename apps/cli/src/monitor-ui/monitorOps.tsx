/** @jsxImportSource react */
import { useEffect, useMemo, useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "smithers-orchestrator/ui";
import {
  cronRowsOf,
  opsStats,
  type RunRow,
  type Tone,
} from "./monitorModel.ts";
import { Ago, Countdown, useJsonApi, useNowMs } from "./monitorShared.tsx";
import { AccountUsageCards } from "./monitorUsagePanels.tsx";
import { capCostFetchSet, foldWorkspaceCost, runIdOf, runsStartedTodayOf } from "./monitorOpsModel.ts";
import { formatUsd } from "./monitorUsageModel.ts";

// ---------------------------------------------------------------------------
// Workspace overview: the ops strip (one quiet row of stat cards above the
// runs table) and the crons panel below it. Numbers first, labels small and
// dim; every value is real gateway state or an honest placeholder.
// ---------------------------------------------------------------------------

export function StatCard({
  value,
  label,
  sub,
  tone,
  testId,
}: {
  value: string;
  label: string;
  sub?: string;
  tone?: Tone;
  testId?: string;
}) {
  return (
    <div className={`mon-stat${tone ? ` tone-${tone}` : ""}`} data-testid={testId ?? "monitor-stat"}>
      <div className="mon-stat-value mon-mono">{value}</div>
      <div className="mon-stat-label">{label}</div>
      {sub ? <div className="mon-stat-sub mon-dim">{sub}</div> : null}
    </div>
  );
}

export function WorkspaceCostCard({ runs, now }: { runs: RunRow[]; now: number }) {
  const todays = useMemo(() => runsStartedTodayOf(runs, now), [runs, now]);
  const capped = useMemo(
    () => capCostFetchSet(todays.map(runIdOf).filter((runId): runId is string => runId !== undefined)),
    [todays],
  );
  const fetchKey = `${capped.runIds.join(",")}:${capped.skippedCount}`;
  const [result, setResult] = useState<ReturnType<typeof foldWorkspaceCost> | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    // A live run can report more tokens without changing the landing run set.
    // Keep this deliberately aligned with subscription-window polling.
    const timer = setInterval(() => setRefresh((value) => value + 1), 60_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      const envelopes: Array<{ body?: unknown; failed?: boolean }> = [];
      for (let index = 0; index < capped.runIds.length; index += 4) {
        const batch = capped.runIds.slice(index, index + 4);
        const rows = await Promise.all(batch.map(async (runId) => {
          try {
            const response = await fetch(`/v1/api/runs/${encodeURIComponent(runId)}/token-usage`, { signal: controller.signal });
            return response.ok ? { body: await response.json() } : { failed: true };
          } catch { return { failed: true }; }
        }));
        envelopes.push(...rows);
      }
      if (!controller.signal.aborted) setResult(foldWorkspaceCost(envelopes, capped.skippedCount));
    };
    void load();
    return () => controller.abort();
  }, [fetchKey, refresh]);
  const omitted = (result?.skippedCount ?? capped.skippedCount) + (result?.failedRuns ?? 0);
  return <StatCard
    value={!result ? "…" : result.unpricedRuns ? "unpriced" : formatUsd(result.totalUsd)}
    label="workspace cost today"
    sub={!result ? "runs started today on this gateway" : `${result.fetchedCount} runs · runs started today on this gateway${omitted ? ` · +${omitted} not counted` : ""}`}
    testId="monitor-workspace-cost"
  />;
}

export function OpsStrip({ runs, loading, attentionTotal }: { runs: RunRow[]; loading: boolean; attentionTotal?: number }) {
  const now = useNowMs();
  const stats = useMemo(() => opsStats(runs as Array<Record<string, unknown>>, now), [runs, now]);
  const pending = loading && runs.length === 0;
  const n = (value: number | undefined): string => (value === undefined || pending ? "…" : String(value));
  return (
    <div className="mon-ops-strip" data-testid="monitor-ops-strip">
      <AccountUsageCards />
      <WorkspaceCostCard runs={runs} now={now} />
      <StatCard value={n(attentionTotal ?? stats.attention)} label="needs attention" testId="monitor-stat-attention" />
      <StatCard
        value={n(stats.enginesLive)}
        label="engines live"
        sub="heartbeat < 60s"
        testId="monitor-stat-engines"
      />
      <StatCard
        value={n(stats.active)}
        label="active runs"
        tone={stats.active > 0 ? "running" : undefined}
        testId="monitor-stat-active"
      />
    </div>
  );
}

export function CronsPanel() {
  const now = useNowMs();
  const cronsApi = useJsonApi("/v1/api/crons", 30_000);
  const crons = useMemo(() => cronRowsOf(cronsApi.body), [cronsApi.body]);
  return (
    <section className="mon-panel mon-crons-panel" data-testid="monitor-crons">
      <header className="mon-panel-head">
        <h2 className="mon-kicker">
          Crons <span className="mon-count">{cronsApi.loaded ? crons.length : ""}</span>
        </h2>
      </header>
      {!cronsApi.loaded ? (
        <div className="mon-empty mon-dim">
          {cronsApi.failed ? (
            "Could not load crons — the gateway did not answer."
          ) : (
            <span className="mon-live-pending">
              <span className="mon-dot mon-dot-pulse" aria-hidden /> loading crons…
            </span>
          )}
        </div>
      ) : crons.length === 0 ? (
        <div className="mon-empty mon-dim">
          No crons registered. Add one with <code>smithers cron add &lt;pattern&gt; &lt;workflow&gt;</code>.
        </div>
      ) : (
        <div className="mon-crons-scroll">
          <Table className="mon-runs-table mon-crons-table">
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Pattern</TableHead>
                <TableHead scope="col">Workflow</TableHead>
                <TableHead scope="col">Enabled</TableHead>
                <TableHead scope="col">Last run</TableHead>
                <TableHead scope="col">Next run</TableHead>
                <TableHead scope="col">Last error</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {crons.map((cron) => (
                <TableRow key={cron.cronId} data-cron-id={cron.cronId}>
                  <TableCell className="mon-mono">{cron.pattern}</TableCell>
                  <TableCell className="mon-table-workflow" title={cron.workflowPath ?? cron.workflow}>
                    {cron.workflow}
                  </TableCell>
                  <TableCell>
                    <span className={`mon-pill tone-${cron.enabled ? "ok" : "idle"}`}>
                      <span className="mon-dot" aria-hidden />
                      {cron.enabled ? "enabled" : "disabled"}
                    </span>
                  </TableCell>
                  <TableCell className="mon-dim">
                    <Ago ms={cron.lastRunAtMs} />
                  </TableCell>
                  <TableCell className="mon-mono">
                    {cron.nextRunAtMs === undefined ? (
                      <span className="mon-dim">—</span>
                    ) : now >= cron.nextRunAtMs ? (
                      "due now"
                    ) : (
                      <Countdown untilMs={cron.nextRunAtMs} />
                    )}
                  </TableCell>
                  <TableCell className={cron.error ? "tone-failed mon-cron-error" : "mon-dim"} title={cron.error}>
                    {cron.error ? cron.error.slice(0, 80) : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
