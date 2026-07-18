/** @jsxImportSource react */
import { useMemo } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "smithers-orchestrator/ui";
import {
  accountRowsOf,
  cronRowsOf,
  dataRowsOf,
  formatLatencyMs,
  histogramStats,
  nextCron,
  openTicketCount,
  opsStats,
  type RunRow,
  type Tone,
} from "./monitorModel.ts";
import { Ago, Countdown, useJsonApi, useMetricsScrape, useNowMs } from "./monitorShared.tsx";

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

export function OpsStrip({ runs, loading }: { runs: RunRow[]; loading: boolean }) {
  const now = useNowMs();
  const metrics = useMetricsScrape(true);
  const cronsApi = useJsonApi("/v1/api/crons", 30_000);
  const accountsApi = useJsonApi("/v1/api/accounts", 60_000);
  const memoryApi = useJsonApi("/v1/api/memory-facts", 60_000);
  const ticketsApi = useJsonApi("/v1/api/tickets", 60_000);
  const stats = useMemo(() => opsStats(runs as Array<Record<string, unknown>>, now), [runs, now]);
  const crons = useMemo(() => cronRowsOf(cronsApi.body), [cronsApi.body]);
  const accounts = useMemo(() => accountRowsOf(accountsApi.body), [accountsApi.body]);
  const agentLatency = useMemo(
    () => (metrics.scrape ? histogramStats(metrics.scrape, "smithers_agent_duration_ms", ["engine", "model"]) : []),
    [metrics.scrape],
  );
  const upcoming = nextCron(crons);
  const accountsReady = accounts.filter((account) => account.ready).length;
  const memoryCount = memoryApi.loaded ? dataRowsOf(memoryApi.body).length : undefined;
  const ticketsOpen = ticketsApi.loaded ? openTicketCount(ticketsApi.body) : undefined;
  const pending = loading && runs.length === 0;
  const n = (value: number | undefined): string => (value === undefined || pending ? "…" : String(value));
  return (
    <div className="mon-ops-strip" data-testid="monitor-ops-strip">
      <StatCard
        value={n(stats.active)}
        label="active runs"
        sub={stats.attention > 0 ? `${stats.attention} need attention` : undefined}
        tone={stats.active > 0 ? "running" : undefined}
        testId="monitor-stat-active"
      />
      <StatCard
        value={n(stats.enginesLive)}
        label="engines live"
        sub="heartbeat < 60s"
        testId="monitor-stat-engines"
      />
      <StatCard
        value={n(stats.completedToday)}
        label="completed today"
        sub={stats.failedToday > 0 ? `${stats.failedToday} failed` : undefined}
        testId="monitor-stat-completed"
      />
      {agentLatency.slice(0, 2).map((stat) => (
        <StatCard
          key={stat.key}
          value={`${formatLatencyMs(stat.p50)} / ${formatLatencyMs(stat.p95)}`}
          label={`agent p50/p95 · ${stat.key}`}
          sub={`${stat.count} runs (this gateway)`}
          testId="monitor-stat-latency"
        />
      ))}
      {agentLatency.length === 0 ? (
        <StatCard
          value={metrics.scrape ? "—" : "…"}
          label="agent latency"
          sub={metrics.failed ? "metrics unreachable" : metrics.scrape ? "no samples this gateway yet" : "scraping…"}
          testId="monitor-stat-latency"
        />
      ) : null}
      <StatCard
        value={
          cronsApi.loaded
            ? upcoming?.nextRunAtMs !== undefined
              ? now >= upcoming.nextRunAtMs
                ? "due now"
                : `in ${Math.max(1, Math.round((upcoming.nextRunAtMs - now) / 60_000))}m`
              : "—"
            : "…"
        }
        label={upcoming ? `next cron · ${upcoming.workflow}` : "next cron"}
        sub={upcoming ? upcoming.pattern : cronsApi.loaded ? "none registered" : undefined}
        testId="monitor-stat-cron"
      />
      <StatCard
        value={accountsApi.loaded ? `${accountsReady}/${accounts.length}` : "…"}
        label="accounts ready"
        tone={accountsApi.loaded && accountsReady < accounts.length ? "waiting" : undefined}
        testId="monitor-stat-accounts"
      />
      <StatCard value={n(memoryCount)} label="memory facts" testId="monitor-stat-memory" />
      <StatCard value={n(ticketsOpen)} label="open tickets" testId="monitor-stat-tickets" />
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
