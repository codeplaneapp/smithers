import { create } from "zustand";
import { useChatStore } from "../chat/chatStore";
import { useNotificationsStore } from "../notifications/notificationsStore";
import { DEFAULT_FILTERS, shortRunId, type AgeFilter, type RunStatusFilter, type RunSummary } from "./runsList";

/**
 * The runs-list store: the live run roster (pushed in by `RunsListBridge` from
 * the gateway `runs` collection) plus the header filters, search, the
 * Live/Polling badge flag, and a selected-row highlight the card and canvas
 * read.
 *
 * The roster is sourced from `useGatewayRuns()` via the bridge — NOT from any
 * in-app seed. The mutations below (rerun / approve / deny / resume) remain
 * demo echoes: they post a chat line + transient toast the way the vcs/issues
 * stores do. Real run-control (approve/deny/resume/cancel) belongs to the
 * inspector (`GatewayRunInspector`), which already wires the gateway RPCs; the
 * LIST surface only surfaces and navigates. The gateway summary row carries no
 * `blockedNodeLabel`, so the approve/deny status-flip guards naturally no-op on
 * live rows — kept as echoes, never fabricating or flipping a live row.
 */
export type StreamMode = "live" | "polling";
// Mirrors gateway-react's GatewayConnectionStatus. Restated locally because the
// UI architecture guard forbids this store importing gateway-react at all,
// type-only imports included.
type GatewayConnectionStatus = "idle" | "connecting" | "online" | "offline" | "unauthorized";

type RunsListState = {
  runs: RunSummary[];
  /** Initial collection synchronization is still in progress. */
  loading: boolean;
  /** The live collection could not be read; null after a successful read. */
  error: string | null;
  /** Real gateway transport state, mirrored by RunsListBridge. */
  connectionStatus: GatewayConnectionStatus;
  statusFilter: RunStatusFilter;
  workflowFilter: string | "all";
  ageFilter: AgeFilter;
  search: string;
  streamMode: StreamMode;
  selectedRunId: string | null;
  setStatusFilter: (status: RunStatusFilter) => void;
  setWorkflowFilter: (name: string | "all") => void;
  setAgeFilter: (bucket: AgeFilter) => void;
  setSearch: (value: string) => void;
  clearFilters: () => void;
  setStreamMode: (mode: StreamMode) => void;
  selectRun: (runId: string | null) => void;
  rerun: (runId: string) => void;
  approve: (runId: string) => void;
  deny: (runId: string) => void;
  resume: (runId: string) => void;
};

/** Echo a side effect to chat + the toast stack, the gateway-less PWA pattern. */
function echo(say: string, title: string, detail: string): void {
  useChatStore.getState().say(say);
  useNotificationsStore.getState().notify({
    title,
    detail,
    kind: "transient",
    command: "chat",
  });
}

export const useRunsListStore = create<RunsListState>((set, get) => ({
  // Sourced live from the gateway `runs` collection via `RunsListBridge`; starts
  // empty until the first collection push.
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

  rerun: (runId) => {
    const run = get().runs.find((r) => r.runId === runId);
    if (!run) return;
    const id = shortRunId(run.runId);
    // RunInspectView.startRerun: a demo acknowledgement, not a fabricated run.
    echo(`Triggering rerun of ${run.workflowName} (${id})…`, "Run rerun", id);
  },

  approve: (runId) => {
    const run = get().runs.find((r) => r.runId === runId);
    if (!run || run.status !== "waiting") return;
    set((state) => ({
      runs: state.runs.map((r) =>
        r.runId === runId ? { ...r, status: "running", lifecycleStatus: "running", blockedNodeLabel: undefined } : r,
      ),
    }));
    const id = shortRunId(run.runId);
    echo(
      `Approved \`${run.blockedNodeLabel ?? "gate"}\` on ${run.workflowName} (${id}). Resuming…`,
      "Approval granted",
      `${run.blockedNodeLabel ?? "gate"} · ${id}`,
    );
  },

  deny: (runId) => {
    const run = get().runs.find((r) => r.runId === runId);
    if (!run || run.status !== "waiting") return;
    set((state) => ({
      runs: state.runs.map((r) =>
        r.runId === runId
          ? {
              ...r,
              status: "failed",
              lifecycleStatus: "failed",
              blockedNodeLabel: undefined,
              errorText: `Denied at \`${run.blockedNodeLabel ?? "gate"}\`.`,
            }
          : r,
      ),
    }));
    const id = shortRunId(run.runId);
    echo(
      `Denied \`${run.blockedNodeLabel ?? "gate"}\` on ${run.workflowName} (${id}). Run failed.`,
      "Approval denied",
      `${run.blockedNodeLabel ?? "gate"} · ${id}`,
    );
  },

  resume: (runId) => {
    const run = get().runs.find((r) => r.runId === runId);
    if (!run || (run.status !== "failed" && run.status !== "cancelled")) return;
    set((state) => ({
      runs: state.runs.map((r) =>
        r.runId === runId ? { ...r, status: "running", lifecycleStatus: "running", errorText: undefined } : r,
      ),
    }));
    const id = shortRunId(run.runId);
    echo(`Resumed ${run.workflowName} (${id}).`, "Run resumed", id);
  },
}));
