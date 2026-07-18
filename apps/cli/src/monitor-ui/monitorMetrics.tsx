/** @jsxImportSource react */
import { useMemo } from "react";
import {
  formatElapsed,
  formatLatencyMs,
  histogramStats,
  metricValue,
  nonZeroErrorCounters,
  type Tone,
} from "./monitorModel.ts";
import { useMetricsScrape, useNowMs } from "./monitorShared.tsx";

// ---------------------------------------------------------------------------
// Metrics view: glanceable operator stats parsed from ONE Prometheus scrape
// (10s refresh) — agent latency percentiles per engine·model, run/RPC/
// connection counters, and any non-zero error counters. Text and the shared
// tone system; monospace numbers; no charting stack.
// ---------------------------------------------------------------------------

function MetricRow({ label, value, tone }: { label: string; value: string; tone?: Tone }) {
  return (
    <div className="mon-metric-row">
      <span className={`mon-metric-label${tone ? ` tone-${tone}` : ""}`}>{label}</span>
      <span className={`mon-mono mon-metric-value${tone ? ` tone-${tone}` : ""}`}>{value}</span>
    </div>
  );
}

export function MetricsPanel() {
  const now = useNowMs();
  const { scrape, failed, scrapedAtMs } = useMetricsScrape(true);
  const agentLatency = useMemo(
    () => (scrape ? histogramStats(scrape, "smithers_agent_duration_ms", ["engine", "model"]) : []),
    [scrape],
  );
  const rpcStats = useMemo(
    () => (scrape ? histogramStats(scrape, "smithers_gateway_rpc_duration_ms", ["method"]) : []),
    [scrape],
  );
  const rpcOverall = useMemo(
    () => (scrape ? histogramStats(scrape, "smithers_gateway_rpc_duration_ms", []) : []),
    [scrape],
  );
  const errors = useMemo(() => (scrape ? nonZeroErrorCounters(scrape) : []), [scrape]);
  if (!scrape) {
    return (
      <section className="mon-panel mon-metrics-panel" data-testid="monitor-metrics">
        <header className="mon-panel-head">
          <h2 className="mon-kicker">Metrics</h2>
        </header>
        <div className="mon-empty mon-dim">
          {failed ? (
            "Could not scrape /metrics — the gateway did not answer."
          ) : (
            <span className="mon-live-pending">
              <span className="mon-dot mon-dot-pulse" aria-hidden /> scraping /metrics…
            </span>
          )}
        </div>
      </section>
    );
  }
  const num = (value: number | undefined): string =>
    value === undefined ? "—" : String(Math.round(value));
  const uptime = metricValue(scrape, "smithers_process_uptime_seconds");
  return (
    <section className="mon-panel mon-metrics-panel" data-testid="monitor-metrics">
      <header className="mon-panel-head">
        <h2 className="mon-kicker">Metrics</h2>
        {failed ? <span className="mon-conn tone-failed">scrape failing — showing last data</span> : null}
        <span className="mon-dim mon-count-note">
          {scrapedAtMs ? `scraped ${Math.max(0, Math.round((now - scrapedAtMs) / 1000))}s ago` : ""}
          {uptime !== undefined ? ` · gateway up ${formatElapsed(now - uptime * 1000, now)}` : ""}
        </span>
      </header>

      <div className="mon-metrics-grid">
        <div className="mon-metrics-section" data-testid="monitor-metrics-agents">
          <h3 className="mon-kicker">Agent latency (this gateway process)</h3>
          {agentLatency.length === 0 ? (
            <div className="mon-empty mon-dim">
              No agent invocations recorded by this gateway process yet — engines attached elsewhere (e.g. `smithers
              up` in a terminal) report to their own process.
            </div>
          ) : (
            <div className="mon-metrics-table">
              <div className="mon-metric-row mon-metric-head">
                <span className="mon-metric-label">engine · model</span>
                <span className="mon-mono mon-metric-value">n · p50 · p95</span>
              </div>
              {agentLatency.map((stat) => (
                <MetricRow
                  key={stat.key}
                  label={stat.key || "(unlabeled)"}
                  value={`${stat.count} · ${formatLatencyMs(stat.p50)} · ${formatLatencyMs(stat.p95)}`}
                />
              ))}
            </div>
          )}
        </div>

        <div className="mon-metrics-section" data-testid="monitor-metrics-runs">
          <h3 className="mon-kicker">Runs & connections</h3>
          <div className="mon-metrics-table">
            <MetricRow label="runs started (this process)" value={num(metricValue(scrape, "smithers_gateway_runs_started_total"))} />
            <MetricRow label="runs completed" value={num(metricValue(scrape, "smithers_gateway_runs_completed_total"))} />
            <MetricRow label="connections active" value={num(metricValue(scrape, "smithers_gateway_connections_active"))} />
            <MetricRow label="connections opened" value={num(metricValue(scrape, "smithers_gateway_connections_total"))} />
            <MetricRow label="pending approvals" value={num(metricValue(scrape, "smithers_approval_pending"))} />
          </div>
        </div>

        <div className="mon-metrics-section" data-testid="monitor-metrics-rpc">
          <h3 className="mon-kicker">
            Gateway RPC{" "}
            {rpcOverall[0] ? (
              <span className="mon-dim">
                — p95 {formatLatencyMs(rpcOverall[0].p95)} over {rpcOverall[0].count} calls
              </span>
            ) : null}
          </h3>
          {rpcStats.length === 0 ? (
            <div className="mon-empty mon-dim">No RPC calls recorded yet.</div>
          ) : (
            <div className="mon-metrics-table">
              <div className="mon-metric-row mon-metric-head">
                <span className="mon-metric-label">method</span>
                <span className="mon-mono mon-metric-value">n · p50 · p95</span>
              </div>
              {rpcStats.slice(0, 10).map((stat) => (
                <MetricRow
                  key={stat.key}
                  label={stat.key || "(unlabeled)"}
                  value={`${stat.count} · ${formatLatencyMs(stat.p50)} · ${formatLatencyMs(stat.p95)}`}
                />
              ))}
            </div>
          )}
        </div>

        <div className="mon-metrics-section" data-testid="monitor-metrics-errors">
          <h3 className="mon-kicker">Errors</h3>
          {errors.length === 0 ? (
            <div className="mon-metric-row">
              <span className="mon-metric-label tone-ok">no non-zero error counters</span>
              <span className="mon-mono mon-metric-value tone-ok">0</span>
            </div>
          ) : (
            <div className="mon-metrics-table">
              {errors.map((sample, index) => (
                <MetricRow
                  key={`${sample.name}:${index}`}
                  label={`${sample.name}${Object.keys(sample.labels).length ? ` {${Object.entries(sample.labels).map(([k, v]) => `${k}=${v}`).join(", ")}}` : ""}`}
                  value={String(sample.value)}
                  tone="failed"
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
