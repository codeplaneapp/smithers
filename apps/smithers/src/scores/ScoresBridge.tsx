import { useEffect } from "react";
import { useGatewayRuns, useGatewayScores } from "@smithers-orchestrator/gateway-react";
import type { GatewayScoreRow } from "@smithers-orchestrator/gateway-client";
import { useLocalModeRefetch } from "../sync/useLocalModeRefetch";
import { resolveActiveRunId, type RunStatus, type ScoresRun } from "./scoreReport";
import { bindScoresActions, useScoresStore } from "./scoresStore";

/**
 * Bridge the LIVE gateway into the scores store (docs/p1b-plan.md §3.3). Two
 * sources feed the surface, both pull-only collections:
 *
 *   • the run roster comes from the existing `useGatewayRuns()` (the SAME
 *     collection the runs list uses) — the scores selector lists every run, and
 *   • the active run's scorer rows come from a NEW `useGatewayScores(runId)` over
 *     the `listScores` RPC (the `_smithers_scorers` table).
 *
 * The Zustand store can't call React hooks, so this component is mounted inside
 * `SmithersCollectionsProvider` in `main.tsx` next to
 * `<CronsBridge/>`/`<MemoryFactsBridge/>`. It maps both into the store on every
 * change and installs the `refetch` seam
 * (`bindScoresActions`) so the surface's Refresh button re-pulls live.
 *
 * `listScores` REQUIRES a `runId`, so the per-run fetch is split into a child
 * (`ActiveRunScores`) that is mounted ONLY once a run resolves — that way we
 * never fire an invalid empty-`runId` request before the roster loads.
 *
 * Per Path A (locked), NO per-run token/cost metrics exist on the wire: the
 * canvas computes the metrics tiles ON-DEMAND from these rows. This bridge only
 * moves rows; the aggregation lives in `scoreReport.metricsFromScores`.
 */

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Collapse the gateway's richer lifecycle vocabulary onto the three `RunStatus`
 * tones the scores selector label renders. Unknown → `running` so an in-flight
 * run still reads sensibly rather than vanishing.
 */
function toScoresStatus(status: string | undefined): RunStatus {
  switch (status) {
    case "succeeded":
    case "finished":
    case "completed":
    case "ok":
      return "completed";
    case "failed":
    case "errored":
    case "cancelled":
    case "canceled":
      return "failed";
    default:
      return "running";
  }
}

/**
 * Map a live run row (`listRuns` payload, loosely typed) onto the selector's
 * `ScoresRun`. `workflowKey → workflowName` (null when the run carries no key, so
 * the label falls back to `Run <short8>`); `status` is collapsed to the 3-tone
 * scale the label uses.
 */
export function toScoresRun(row: Record<string, unknown>): ScoresRun {
  const runId = asString(row.runId) ?? "";
  const workflowKey = asString(row.workflowKey);
  const workflowName = workflowKey !== undefined && workflowKey.trim() !== "" ? workflowKey : null;
  return { runId, workflowName, status: toScoresStatus(asString(row.status)) };
}

/**
 * Pull the active run's scorer rows and push them into the store. Mounted (with a
 * `key={runId}`) ONLY when a run is resolved, so `useGatewayScores` always gets a
 * real `runId` and a run switch re-subscribes cleanly.
 */
function ActiveRunScores({ runId, refetchRuns }: { runId: string; refetchRuns: () => Promise<void> | void }) {
  const { data: scoreRows, refetch: refetchScores } = useGatewayScores(runId);

  // The Refresh button re-pulls both the roster and this run's scores.
  useEffect(() => {
    bindScoresActions({
      refetch: () => {
        void refetchRuns();
        void refetchScores();
      },
    });
  }, [refetchRuns, refetchScores]);

  // LOCAL-MODE freshness: pull-only collection, so a score recorded after load is
  // never pushed here. Poll the small RPC (+ on focus/visibility). Local-mode
  // only; the cloud path streams via Electric (P5) and this poll is removed there.
  useLocalModeRefetch(refetchScores);

  useEffect(() => {
    useScoresStore.setState({ scoreRows: (scoreRows ?? []) as GatewayScoreRow[] });
  }, [scoreRows]);

  return null;
}

export function ScoresBridge() {
  const runsState = useGatewayRuns({ filter: { limit: 100 } });
  const runRows = runsState.data;
  const refetchRuns = runsState.refetch;

  useEffect(() => {
    const runs = (runRows ?? []).map(toScoresRun).filter((run) => run.runId.trim() !== "");
    useScoresStore.setState({ runs });
  }, [runRows]);

  // LOCAL-MODE freshness for the roster (mirrors the runs-list bridge).
  useLocalModeRefetch(refetchRuns);

  // Resolve the active run the SAME way the canvas does (stored selection, else
  // the first run) so the rows we pull match what renders.
  const runs = useScoresStore((state) => state.runs);
  const selectedRunId = useScoresStore((state) => state.selectedRunId);
  const activeRunId = resolveActiveRunId(runs, selectedRunId);

  // No run resolved yet → clear any stale rows and keep Refresh a roster-only
  // pull. Do NOT fetch `listScores` with an empty runId (the RPC requires one).
  useEffect(() => {
    if (activeRunId == null) {
      useScoresStore.setState({ scoreRows: [] });
      bindScoresActions({ refetch: () => void refetchRuns() });
    }
  }, [activeRunId, refetchRuns]);

  return activeRunId == null ? null : (
    <ActiveRunScores key={activeRunId} runId={activeRunId} refetchRuns={refetchRuns} />
  );
}
