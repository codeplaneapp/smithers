import { useEffect } from "react";
import {
  useGatewayActions,
  useGatewayConnectionStatus,
  useGatewayRuns,
  useSmithersCollections,
} from "@smthrs/gateway-react";
import { useLocalModeRefetch } from "../sync/useLocalModeRefetch";
import { normalizeRunStatus, runStatusCategory, type RunSummary } from "./runsList";
import { bindRunActions, useRunsListStore } from "./runsListStore";

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function gatewayHeaders(token: string | undefined): Record<string, string> {
  const headers = { "content-type": "application/json" };
  return token ? { ...headers, authorization: `Bearer ${token}` } : headers;
}

async function gatewayFetch(
  apiBaseUrl: string,
  token: string | undefined,
  path: string,
  init?: RequestInit,
): Promise<Record<string, unknown>> {
  const response = await fetch(new URL(path, `${apiBaseUrl.replace(/\/+$/, "")}/`), {
    ...init,
    headers: gatewayHeaders(token),
  });
  const body = asRecord(await response.json().catch(() => null));
  if (!response.ok || body.ok === false) {
    const error = asRecord(body.error);
    throw new Error(asString(error.message) ?? `Gateway request failed (${response.status})`);
  }
  return asRecord(body.data);
}

async function gatewayRpcFetch(
  apiBaseUrl: string,
  token: string | undefined,
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(new URL(`/v1/rpc/${encodeURIComponent(method)}`, `${apiBaseUrl.replace(/\/+$/, "")}/`), {
    method: "POST",
    headers: gatewayHeaders(token),
    body: JSON.stringify(params),
  });
  const body = asRecord(await response.json().catch(() => null));
  if (!response.ok || body.ok === false) {
    const error = asRecord(body.error);
    throw new Error(asString(error.message) ?? `Gateway request failed (${response.status})`);
  }
  return asRecord(body.payload);
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
  const { data, loading, error, refetch } = useGatewayRuns({ filter: { limit: 100 } });
  const connection = useGatewayConnectionStatus();
  const actions = useGatewayActions();
  const { client } = useSmithersCollections();
  const apiBaseUrl = client.mode.apiBaseUrl;
  const token = client.mode.token;

  useEffect(() => {
    bindRunActions({
      pause: (runId) =>
        gatewayFetch(apiBaseUrl, token, `/v1/api/runs/${encodeURIComponent(runId)}/pause`, {
          method: "POST",
          body: "{}",
        }),
      resume: (runId) => actions.resumeRun({ runId }),
      cancel: (runId) => actions.cancelRun({ runId }),
      retry: (runId) => gatewayRpcFetch(apiBaseUrl, token, "runs.rerun", { runId }),
      health: async (runId) => {
        const run = await gatewayFetch(apiBaseUrl, token, `/v1/api/runs/${encodeURIComponent(runId)}`);
        const runState = asRecord(run.runState);
        return asString(runState.state) ?? asString(run.status) ?? "available";
      },
      refetch,
    });
  }, [actions, apiBaseUrl, refetch, token]);

  // LOCAL-MODE freshness: the `runs` collection is pull-only (no stream), so a
  // run launched/advanced after the initial pull is never pushed here. Poll the
  // small `listRuns` RPC on a modest interval (+ on focus/visibility) so `/runs`
  // reflects a mid-session launch within ~LOCAL_LIST_POLL_MS, no reload needed.
  // This is the local-mode path only; the cloud path streams via Electric (P5)
  // and this poll is removed there (see useLocalModeRefetch / LOCAL_LIST_POLL_MS).
  useLocalModeRefetch(refetch);

  useEffect(() => {
    useRunsListStore.setState((state) => {
      // A transport failure must never replace the last successful roster
      // with the live query's temporary empty value.
      if (connection.status === "offline" || connection.status === "unauthorized") {
        return {
          loading: false,
          error: error ? error.message || "The runs service could not be reached." : state.error,
          connectionStatus: connection.status,
        };
      }
      if (error) {
        return {
          loading: false,
          error: error.message || "The runs service could not be reached.",
          connectionStatus: connection.status,
        };
      }
      if (loading && (data?.length ?? 0) === 0 && state.runs.length === 0) {
        return { loading: true, error: null, connectionStatus: connection.status };
      }
      return {
        runs: (data ?? []).map(toRunSummary),
        loading: false,
        error: null,
        connectionStatus: connection.status,
      };
    });
  }, [connection.status, data, error, loading]);

  return null;
}
