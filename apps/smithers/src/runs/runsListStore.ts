import { create } from "zustand";
import {
  DEFAULT_FILTERS,
  runActionAvailability,
  type AgeFilter,
  type RunStatusFilter,
  type RunSummary,
} from "./runsList";

/**
 * The runs-list store: the live run roster (pushed in by `RunsListBridge` from
 * the gateway `runs` collection), filters, and real lifecycle-action state.
 * The bridge owns gateway hooks and installs an RPC seam; action success never
 * fabricates a local status transition because the collection is authoritative.
 */
export type StreamMode = "live" | "polling";
// Mirrors gateway-react's GatewayConnectionStatus. Restated locally because the
// UI architecture guard forbids this store importing gateway-react at all,
// type-only imports included.
type GatewayConnectionStatus = "idle" | "connecting" | "online" | "offline" | "unauthorized";
export type RunAction = "pause" | "resume" | "cancel" | "retry" | "health";

type RunActionsRpc = {
  pause: (runId: string) => Promise<unknown>;
  resume: (runId: string, forceRetry?: boolean) => Promise<unknown>;
  cancel: (runId: string) => Promise<unknown>;
  retry?: (runId: string) => Promise<unknown>;
  health: (runId: string) => Promise<string>;
  refetch: () => Promise<unknown> | void;
};

type RunsListState = {
  runs: RunSummary[];
  loading: boolean;
  error: string | null;
  connectionStatus: GatewayConnectionStatus;
  statusFilter: RunStatusFilter;
  workflowFilter: string | "all";
  ageFilter: AgeFilter;
  search: string;
  streamMode: StreamMode;
  selectedRunId: string | null;
  actingRunId: string | null;
  actingAction: RunAction | null;
  actionFeedback: { runId: string; kind: "success" | "error"; message: string } | null;
  rpc: RunActionsRpc | null;
  setStatusFilter: (status: RunStatusFilter) => void;
  setWorkflowFilter: (name: string | "all") => void;
  setAgeFilter: (bucket: AgeFilter) => void;
  setSearch: (value: string) => void;
  clearFilters: () => void;
  setStreamMode: (mode: StreamMode) => void;
  selectRun: (runId: string | null) => void;
  performAction: (runId: string, action: RunAction) => void;
};

const ACTION_LABEL: Record<RunAction, string> = {
  pause: "Pause",
  resume: "Resume",
  cancel: "Cancel",
  retry: "Retry",
  health: "Health check",
};

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function assertActionAccepted(action: RunAction, result: unknown): void {
  const status = asRecord(result).status;
  if (action === "resume" && status === "already_terminal") {
    throw new Error("run already reached a terminal state");
  }
  if (action === "cancel" && status === "already-terminal") {
    throw new Error("run already reached a terminal state");
  }
  if (action === "cancel" && status === "not-found") {
    throw new Error("run was not found");
  }
}

function actionSuccess(action: RunAction, runId: string, result: unknown): string {
  if (action === "health") {
    return `Health check for ${runId}: ${typeof result === "string" ? result : "available"}.`;
  }
  if (action === "retry") {
    const newRunId = asRecord(result).runId;
    return typeof newRunId === "string"
      ? `Retry launched for ${runId} as ${newRunId}.`
      : `Retry launched for ${runId}.`;
  }
  return `${ACTION_LABEL[action]} requested for ${runId}.`;
}

export const useRunsListStore = create<RunsListState>((set, get) => ({
  runs: [],
  loading: true,
  error: null,
  connectionStatus: "idle",
  statusFilter: DEFAULT_FILTERS.status,
  workflowFilter: DEFAULT_FILTERS.workflow,
  ageFilter: DEFAULT_FILTERS.age,
  search: DEFAULT_FILTERS.search,
  streamMode: "live",
  selectedRunId: null,
  actingRunId: null,
  actingAction: null,
  actionFeedback: null,
  rpc: null,

  setStatusFilter: (status) => set({ statusFilter: status }),
  setWorkflowFilter: (name) => set({ workflowFilter: name }),
  setAgeFilter: (bucket) => set({ ageFilter: bucket }),
  setSearch: (value) => set({ search: value }),
  clearFilters: () =>
    set({
      statusFilter: DEFAULT_FILTERS.status,
      workflowFilter: DEFAULT_FILTERS.workflow,
      ageFilter: DEFAULT_FILTERS.age,
      search: DEFAULT_FILTERS.search,
    }),
  setStreamMode: (mode) => set({ streamMode: mode }),
  selectRun: (runId) => set({ selectedRunId: runId }),

  performAction: (runId, action) => {
    const { rpc, actingRunId, runs, connectionStatus } = get();
    const run = runs.find((candidate) => candidate.runId === runId);
    if (!run || !rpc || actingRunId !== null || connectionStatus !== "online") return;
    if (action !== "health" && !runActionAvailability(run)[action]) return;
    set({ actingRunId: runId, actingAction: action, actionFeedback: null });

    const request =
      action === "pause"
        ? rpc.pause(runId)
        : action === "cancel"
          ? rpc.cancel(runId)
          : action === "resume"
            ? rpc.resume(runId)
            : action === "retry"
              ? rpc.retry
                ? rpc.retry(runId)
                : rpc.resume(runId, true)
              : rpc.health(runId);

    void request
      .then(async (result) => {
        assertActionAccepted(action, result);
        if (action !== "health") {
          try {
            await rpc.refetch();
          } catch {
            // The accepted lifecycle request remains authoritative.
          }
        }
        set({
          actingRunId: null,
          actingAction: null,
          actionFeedback: {
            runId,
            kind: "success",
            message: actionSuccess(action, runId, result),
          },
        });
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        set({
          actingRunId: null,
          actingAction: null,
          actionFeedback: {
            runId,
            kind: "error",
            message: `${ACTION_LABEL[action]} failed for ${runId}: ${message}. Try again.`,
          },
        });
      });
  },
}));

/** Install the real lifecycle RPC seam from the gateway-backed bridge. */
export function bindRunActions(rpc: RunActionsRpc): void {
  useRunsListStore.setState({ rpc });
}
