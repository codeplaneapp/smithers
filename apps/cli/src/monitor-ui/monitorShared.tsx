/** @jsxImportSource react */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useGatewayConnectionStatus } from "smithers-orchestrator/gateway-react";
import {
  connectionViewFor,
  formatElapsed,
  labelForStatus,
  parsePrometheusText,
  timeAgo,
  toneForStatus,
  type PromScrape,
} from "./monitorModel.ts";
import { ToneDot } from "./monitorShell.tsx";

// ---------------------------------------------------------------------------
// One shared 1-second clock. Only the small label components subscribe, so N
// ticking labels cost one timer and finished labels render static text.
// ---------------------------------------------------------------------------

let clockNowMs = Date.now();
const clockSubscribers = new Set<() => void>();
let clockTimer: ReturnType<typeof setInterval> | null = null;

export function subscribeClock(callback: () => void): () => void {
  clockSubscribers.add(callback);
  if (!clockTimer) {
    clockTimer = setInterval(() => {
      clockNowMs = Date.now();
      for (const subscriber of clockSubscribers) subscriber();
    }, 1000);
  }
  return () => {
    clockSubscribers.delete(callback);
    if (clockSubscribers.size === 0 && clockTimer) {
      clearInterval(clockTimer);
      clockTimer = null;
    }
  };
}

export function useNowMs(): number {
  return useSyncExternalStore(subscribeClock, () => clockNowMs, () => clockNowMs);
}

export function LiveElapsed({ startMs }: { startMs: number | undefined }) {
  const now = useNowMs();
  return <>{formatElapsed(startMs, now)}</>;
}

export function Elapsed({ startMs, endMs }: { startMs: number | undefined; endMs: number | undefined }) {
  if (endMs) return <>{formatElapsed(startMs, endMs)}</>;
  return <LiveElapsed startMs={startMs} />;
}

export function Ago({ ms }: { ms: number | undefined }) {
  const now = useNowMs();
  return <>{timeAgo(ms, now)}</>;
}

export function Countdown({ untilMs }: { untilMs: number }) {
  const now = useNowMs();
  const remaining = Math.max(0, untilMs - now);
  if (remaining === 0) return <>due now</>;
  const mins = Math.floor(remaining / 60_000);
  const secs = Math.floor((remaining % 60_000) / 1_000);
  return <>in {mins}m {String(secs).padStart(2, "0")}s</>;
}

// ---------------------------------------------------------------------------
// Shared atoms.
// ---------------------------------------------------------------------------

export function StatusTag({ status, label }: { status: string | undefined; label?: string }) {
  const tone = toneForStatus(status);
  return (
    <span className={`mon-pill tone-${tone}`} data-status={labelForStatus(status)}>
      <span className={`mon-dot${tone === "running" ? " mon-dot-pulse" : ""}`} aria-hidden />
      {label ?? labelForStatus(status)}
    </span>
  );
}

/**
 * Transport truth readout. "Live" only when the gateway link is really
 * streaming; every degraded state gets the same treatment — short label,
 * one-line guidance, and a manual recovery action where auto-retry alone
 * isn't enough. Copy lives in {@link connectionViewFor} so it stays testable.
 */
export function ConnectionBadge() {
  const { status } = useGatewayConnectionStatus();
  const view = connectionViewFor(status);
  return (
    <span className={`mon-conn tone-${view.tone}`} data-testid="monitor-conn" data-conn={status}>
      <ToneDot tone={view.tone} pulse={view.pulse} />
      {view.label}
      {view.hint ? (
        <span className="mon-conn-hint" data-testid="monitor-conn-hint">
          {view.hint}
        </span>
      ) : null}
      {view.action ? (
        <button
          type="button"
          className="mon-chip"
          data-testid="monitor-conn-action"
          title="Reload the Monitor page"
          onClick={() => location.reload()}
        >
          {view.action.label}
        </button>
      ) : null}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Small polling data hooks for the gateway's simple-read REST routes and the
// Prometheus /metrics text. Each keeps the last good payload on transient
// fetch failures (the readouts must not blank during a gateway hiccup) but
// reports `failed` so surfaces can say so.
// ---------------------------------------------------------------------------

export function useJsonApi(url: string | null, refreshMs: number | null): { body: unknown; loaded: boolean; failed: boolean } {
  const [state, setState] = useState<{ body: unknown; loaded: boolean; failed: boolean }>({
    body: null,
    loaded: false,
    failed: false,
  });
  // Only a URL change resets the data — a polling-cadence flip (a run going
  // live→settled) must not blank an already-loaded panel.
  const lastUrl = useRef(url);
  useEffect(() => {
    if (lastUrl.current !== url) {
      lastUrl.current = url;
      setState({ body: null, loaded: false, failed: false });
    }
    if (!url) return;
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`${url} ${response.status}`);
        const body: unknown = await response.json();
        if (!cancelled) setState({ body, loaded: true, failed: false });
      } catch {
        if (!cancelled) setState((prev) => ({ body: prev.body, loaded: prev.loaded, failed: true }));
      }
    };
    void load();
    const timer = refreshMs !== null ? setInterval(() => void load(), refreshMs) : null;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [url, refreshMs]);
  return state;
}

const METRICS_REFRESH_MS = 10_000;

export function useMetricsScrape(enabled: boolean): { scrape: PromScrape | null; failed: boolean; scrapedAtMs: number | null } {
  const [state, setState] = useState<{ scrape: PromScrape | null; failed: boolean; scrapedAtMs: number | null }>({
    scrape: null,
    failed: false,
    scrapedAtMs: null,
  });
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch("/metrics");
        if (!response.ok) throw new Error(`metrics ${response.status}`);
        const text = await response.text();
        if (!cancelled) setState({ scrape: parsePrometheusText(text), failed: false, scrapedAtMs: Date.now() });
      } catch {
        if (!cancelled) setState((prev) => ({ scrape: prev.scrape, failed: true, scrapedAtMs: prev.scrapedAtMs }));
      }
    };
    void load();
    const timer = setInterval(() => void load(), METRICS_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled]);
  return state;
}
