import { useEffect } from "react";
import { useGatewayRuns } from "@smthrs/gateway-react";
import type { GatewayRunSummaryRow } from "@smthrs/gateway-client";
import type { RunSummary } from "./runsList.ts";
import { isQueuedRawStatus, runListStatusFromRaw } from "./runsList.ts";
import { captureRunsIdentityEpoch, setRunsListRows, setRunsListUnavailable } from "./runsListStore.ts";

/**
 * Bridge the live `runs` gateway collection into the runs list store.
 * Zustand stores can't call React hooks, so this null-rendering component —
 * mounted once near the app root — calls `useGatewayRuns()` and pushes the
 * mapped rows into the store on every change, mirroring multi's
 * `*Bridge` pattern (`RunsListBridge.tsx`, `01-packages.md`'s bridge layer).
 *
 * This is a deliberately NARROWED port of multi's `RunsListBridge.tsx`: multi
 * branches between a GATEWAY backend (dev) and a PLATFORM backend (plue REST,
 * production web), and filters system rows behind a flowchat debug toggle.
 * ui-core (and the TUI) only ever talk to the local gateway, so this bridge
 * keeps just the gateway-collection half — the platform/plue-REST branch
 * (`auth/authClient`, `smithersCloud/runs`, VCS repo-context polling) is a
 * multi-web-only integration that does not belong in a headless package.
 * multi keeps its own `PlatformRunsListBridge` half and composes both.
 */

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Format a completed run's wall-clock duration like RunsView ("2m14s", "9s").
 * A still-running run gets "—": the list never renders a ticking clock.
 * Ported from multi's `src/runs/platformRuns.ts`.
 */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const totalSec = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return minutes <= 0 ? `${seconds}s` : `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

/**
 * Recency bucket for a real epoch-ms timestamp, relative to `nowMs` (injected
 * so mappers stay pure/deterministic in tests). Unknown/unparseable → "older"
 * — never guess a run is fresh off missing data. Ported from multi's
 * `src/runs/platformRuns.ts`.
 */
export function ageBucketFromMs(createdAtMs: number | undefined, nowMs: number): RunSummary["ageBucket"] {
  if (createdAtMs === undefined || Number.isNaN(createdAtMs)) return "older";
  const ageMs = nowMs - createdAtMs;
  const day = 86_400_000;
  if (ageMs < day) return "today";
  if (ageMs < 7 * day) return "week";
  if (ageMs < 30 * day) return "month";
  return "older";
}

/**
 * Map a live `GatewayRunSummaryRow` onto the list's `RunSummary`. The row's
 * declared type is narrow (runId/workflowKey/status/createdAtMs), but the
 * gateway's `listRuns` RPC is `SELECT * FROM _smithers_runs`, so the WIRE
 * payload also carries `startedAtMs`/`finishedAtMs` — read defensively since
 * the type doesn't promise them (an older gateway simply omits them).
 * Per-node progress fields (`totalNodes`/`doneNodes`/`progress`) are NOT on
 * this row — a progress bar per list row would mean one `getRun` RPC per row
 * per poll — so those three stay 0, honestly matching `shouldShowProgress`'s
 * `totalNodes > 0` gate (no bar renders). Ported from multi's
 * `RunsListBridge.tsx` `toRunSummary`.
 *
 * `nowMs` defaults to `Date.now()` — kept a trailing OPTIONAL param (not
 * threaded through a bare `data.map(toRunSummary)`, which would pass the
 * array index as `nowMs`) so callers can inject a fixed clock in tests.
 */
export function toRunSummary(row: Record<string, unknown>, nowMs: number = Date.now()): RunSummary {
  const runId = asString(row.runId) ?? "";
  const workflowKey = asString(row.workflowKey);
  const hasKey = workflowKey !== undefined && workflowKey.trim() !== "";
  const workflowName = hasKey ? workflowKey : runId;
  const rawStatus = asString(row.status);
  const startedAtMs = asNumber(row.startedAtMs);
  const finishedAtMs = asNumber(row.finishedAtMs);
  const createdAtMs = asNumber(row.createdAtMs);
  return {
    id: runId,
    runId,
    workflowName,
    // Preserve the live row's workflow key so a list row can route to the
    // gateway run inspector. When the row carries no key, the caller can
    // fall back to the runId as the path segment.
    workflowKey: hasKey ? workflowKey : undefined,
    model: "",
    status: runListStatusFromRaw(rawStatus),
    // Queued/pending rows render as ACTIVE but carry the flag so a
    // worker-capacity gauge can split active workers from queue depth.
    ...(isQueuedRawStatus(rawStatus) ? { queued: true } : {}),
    totalNodes: 0,
    doneNodes: 0,
    failedNodes: 0,
    progress: 0,
    // Only a run with a known finish time gets a real duration — a running
    // row keeps "—" so the list never ticks.
    elapsedLabel:
      startedAtMs !== undefined && finishedAtMs !== undefined ? formatElapsed(finishedAtMs - startedAtMs) : "—",
    ageBucket: ageBucketFromMs(createdAtMs, nowMs),
  };
}

/**
 * Runs LIST for the gateway backend: the live `runs` collection over
 * `/v1/rpc`. Mount once near the app root; returns null.
 */
export function RunsListBridge(): null {
  const { data, loading, error } = useGatewayRuns({ filter: { limit: 100 } });
  const identityEpoch = captureRunsIdentityEpoch();

  useEffect(() => {
    if (loading || error || data === undefined) {
      setRunsListUnavailable(identityEpoch);
      return;
    }
    // NOT `data.map(toRunSummary)`: Array#map passes (element, INDEX, array),
    // and `toRunSummary`'s second param is `nowMs` — the classic
    // `["1","2"].map(parseInt)` footgun. Wrap it so only the row is forwarded.
    setRunsListRows(
      (data as GatewayRunSummaryRow[]).map((row) => toRunSummary(row)),
      identityEpoch,
    );
  }, [data, error, identityEpoch, loading]);

  return null;
}
