import { useEffect } from "react";
import { useGatewayRuns } from "@smithers-orchestrator/gateway-react";
import { useLocalModeRefetch } from "../sync/useLocalModeRefetch";
import { normalizeRunStatus, runStatusCategory, type RunSummary } from "./runsList";
import { useRunsListStore } from "./runsListStore";

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Bridge the live `runs` gateway collection into the runs LIST store (§3.A of
 * docs/p1a-plan.md). The Zustand store can't call React hooks, so this tiny
 * component mounted inside `SmithersCollectionsProvider` in `main.tsx` calls
 * `useGatewayRuns()` and pushes the mapped rows into the store on every change.
 *
 * The list surface (`RunsCard`/`RunsCanvas`) reads `useRunsListStore().runs`
 * unchanged; only the *source* moved from the retired `SEEDED_RUNS` to the live
 * collection. The collection auto-connects on first hook mount (no `connect()`).
 */

/**
 * Map a live `GatewayRunSummaryRow` onto the list's `RunSummary`. The hook types
 * the row as a loose `Record<string, unknown>` (the `listRuns` payload), so we
 * narrow `runId`/`workflowKey`/`status` defensively. The summary row carries
 * only `runId`/`workflowKey`/`status`/`createdAtMs`; the per-node progress
 * fields the canvas can draw (`totalNodes`/`doneNodes`/`progress`/…) are NOT on
 * the summary, so they default to 0/"—"/"today" — richer per-node data is a P2
 * concern via `useGatewayRun`/`useGatewayRunTree`.
 */
export function toRunSummary(row: Record<string, unknown>): RunSummary {
  const runId = asString(row.runId) ?? "";
  const workflowKey = asString(row.workflowKey);
  const lifecycleStatus = normalizeRunStatus(asString(row.status));
  const hasKey = workflowKey !== undefined && workflowKey.trim() !== "";
  const workflowName = hasKey ? workflowKey : runId;
  return {
    id: runId,
    runId,
    workflowName,
    // Preserve the live row's workflow key so a list row can route to the
    // gateway run inspector (`/gw/$workflowKey/$runId`). When the row carries
    // no key, the canvas falls back to the runId as the path segment so the
    // route still resolves to a working gateway inspector for the real run.
    workflowKey: hasKey ? workflowKey : undefined,
    model: "",
    status: runStatusCategory(lifecycleStatus),
    lifecycleStatus,
    totalNodes: 0,
    doneNodes: 0,
    failedNodes: 0,
    progress: 0,
    elapsedLabel: "—",
    ageBucket: "today",
  };
}

export function RunsListBridge() {
  const { data, refetch } = useGatewayRuns({ filter: { limit: 100 } });

  // LOCAL-MODE freshness: the `runs` collection is pull-only (no stream), so a
  // run launched/advanced after the initial pull is never pushed here. Poll the
  // small `listRuns` RPC on a modest interval (+ on focus/visibility) so `/runs`
  // reflects a mid-session launch within ~LOCAL_LIST_POLL_MS, no reload needed.
  // This is the local-mode path only; the cloud path streams via Electric (P5)
  // and this poll is removed there (see useLocalModeRefetch / LOCAL_LIST_POLL_MS).
  useLocalModeRefetch(refetch);

  useEffect(() => {
    useRunsListStore.setState({ runs: data ? data.map(toRunSummary) : [] });
  }, [data]);

  return null;
}
