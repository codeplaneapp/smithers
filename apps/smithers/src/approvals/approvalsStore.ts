import { create } from "zustand";
import { useChatStore } from "../chat/chatStore";
import { useNotificationsStore } from "../notifications/notificationsStore";
import {
  filterPending,
  gateLabel,
  orderHistory,
  shortRunId,
  type ApprovalDecision,
  type ApprovalGate,
  type ApprovalsTab,
} from "./approvals";

/**
 * The approvals store: the live pending gates (pushed in by `ApprovalsBridge`
 * from the gateway `approvals` collection), an OPTIMISTIC client-side decision
 * history, plus the segment, selection, deny-confirmation, and per-gate note
 * state the card and canvas read.
 *
 * Deciding a gate submits the real `submitApproval` RPC (wired in by the bridge
 * via `bindApprovalActions`), then refetches the live collection so the resolved
 * gate drops out of `gates`. The local `gate → decision` move is an OPTIMISTIC
 * History entry only.
 *
 * APPROVAL HISTORY GAP (accepted P1 gap — docs/p1a-plan.md §7 risk 4):
 * `listApprovals` streams ONLY pending gates and the gateway does not persist
 * APPROVED/REJECTED rows, so `decisions` is client-only and the History tab is
 * EMPTY after a reload. Full History parity needs gateway-side persistence
 * (deferred to P1b/P2).
 */

export type { ApprovalsTab };

/** The shape the bridge installs so store actions can hit the gateway RPC. */
type ApprovalRpc = {
  /**
   * Submit a real approval decision. Resolves on success; rejects on RPC
   * failure (the store distinguishes `AlreadyDecided` as a stale request).
   */
  submit: (vars: {
    runId: string;
    nodeId: string;
    iteration: number;
    decision: { approved: boolean; note?: string };
  }) => Promise<unknown>;
  /** Re-pull the live `approvals` collection after a decision lands. */
  refetch: () => Promise<unknown> | void;
};

type ApprovalsState = {
  tab: ApprovalsTab;
  gates: ApprovalGate[];
  decisions: ApprovalDecision[];
  selectedId: string | null;
  /** The gate awaiting deny confirmation; non-null reveals the inline confirm row. */
  pendingDenyId: string | null;
  /** The gate currently being approved/denied, for the in-flight row/button state. */
  actingId: string | null;
  /** Accessible result of the latest operator action. */
  actionFeedback: { kind: "success" | "error" | "stale"; message: string } | null;
  /** Per-gate draft decision note, mirroring ApprovalCard's noteByRun. */
  noteById: Record<string, string>;
  nowMs: number;
  /** Initial collection synchronization is still in progress. */
  loading: boolean;
  /** The live collection could not be read; null after a successful read. */
  error: string | null;
  /** The live gateway RPC seam, installed by `ApprovalsBridge` (null pre-mount). */
  rpc: ApprovalRpc | null;
  setTab: (tab: ApprovalsTab) => void;
  select: (id: string) => void;
  setNote: (id: string, note: string) => void;
  approve: (id: string) => void;
  requestDeny: (id: string) => void;
  cancelDeny: () => void;
  confirmDeny: (id: string) => void;
};

/** The ids visible in a given segment, in their displayed order. */
function visibleIds(state: { tab: ApprovalsTab; gates: ApprovalGate[]; decisions: ApprovalDecision[] }): string[] {
  return state.tab === "pending"
    ? filterPending(state.gates).map((gate) => gate.id)
    : orderHistory(state.decisions).map((decision) => decision.id);
}

/**
 * Reconcile the selection against the now-visible list, porting Swift
 * syncSelection(): keep the current selection when it is still visible; else
 * select the first visible row; clear to null when the list is empty. Exported
 * so `ApprovalsBridge` can re-run it whenever the live collection repopulates.
 */
export function syncSelection(state: {
  tab: ApprovalsTab;
  gates: ApprovalGate[];
  decisions: ApprovalDecision[];
  selectedId: string | null;
}): string | null {
  const ids = visibleIds(state);
  if (state.selectedId && ids.includes(state.selectedId)) return state.selectedId;
  return ids.length > 0 ? ids[0] : null;
}

/** True when an RPC reject reports that another operator already resolved it. */
function isAlreadyDecided(error: unknown): boolean {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "AlreadyDecided"
  ) {
    return true;
  }
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /already.?decided/i.test(message);
}

export const useApprovalsStore = create<ApprovalsState>((set, get) => ({
  tab: "pending",
  gates: [],
  decisions: [],
  selectedId: null,
  pendingDenyId: null,
  actingId: null,
  actionFeedback: null,
  noteById: {},
  nowMs: Date.now(),
  loading: true,
  error: null,
  rpc: null,

  setTab: (tab) =>
    set((state) => {
      const selectedId = syncSelection({ ...state, tab });
      // Switching segments abandons any in-progress deny confirmation.
      return { tab, selectedId, pendingDenyId: null };
    }),

  select: (id) => set({ selectedId: id }),

  setNote: (id, note) => set((state) => ({ noteById: { ...state.noteById, [id]: note } })),

  approve: (id) => {
    const { gates, noteById, rpc } = get();
    const gate = gates.find((entry) => entry.id === id);
    if (!gate || gate.status !== "pending") return;
    if (!rpc) return;
    if (get().actingId !== null) return;

    set({ actingId: id, actionFeedback: null });
    const note = (noteById[id] ?? "").trim();

    void rpc
      .submit({
        runId: gate.runId,
        nodeId: gate.nodeId,
        iteration: gate.iteration ?? 0,
        decision: { approved: true, note: note === "" ? undefined : note },
      })
      .then(async () => {
        try {
          await rpc.refetch();
        } catch {
          // The decision was accepted. Keep it non-actionable even if the
          // pending-list refresh fails; polling can reconcile later.
        }
      })
      .then(() => {
        // Optimistic History move + chat/toast echo AFTER the RPC lands.
        const state = get();
        const stillGate = state.gates.find((entry) => entry.id === id);
        const resolvedAtMs = Date.now();
        const decision: ApprovalDecision = {
          id: gate.id,
          runId: gate.runId,
          nodeId: gate.nodeId,
          gate: gate.gate,
          workflowPath: gate.workflowPath,
          iteration: gate.iteration,
          source: gate.source,
          payload: gate.payload,
          action: "approved",
          requestedAtMs: gate.requestedAtMs,
          resolvedAtMs,
          resolvedBy: "you",
          note: note === "" ? undefined : note,
        };
        const nextGates = state.gates.filter((entry) => entry.id !== id);
        const nextDecisions = [decision, ...state.decisions];
        const selectedId = syncSelection({
          tab: state.tab,
          gates: nextGates,
          decisions: nextDecisions,
          selectedId: state.selectedId === id ? null : state.selectedId,
        });
        set({
          gates: nextGates,
          decisions: nextDecisions,
          selectedId,
          actingId: null,
          actionFeedback: {
            kind: "success",
            message: `Approved ${gateLabel(gate)} for run ${shortRunId(gate.runId)}.`,
          },
        });

        const label = gateLabel(gate);
        useChatStore
          .getState()
          .say(
            `Approved gate \`${label}\` on run \`${shortRunId(gate.runId)}\`. The waiting node will resume.` +
              (note === "" ? "" : `\n\n> ${note}`),
          );
        useNotificationsStore.getState().notify({
          title: "Approval granted",
          detail: `${label} · ${shortRunId(gate.runId)}`,
          kind: "transient",
          command: "chat",
        });
        void stillGate;
      })
      .catch(async (error: unknown) => {
        if (isAlreadyDecided(error)) {
          try {
            await rpc.refetch();
          } catch {
            // Remove the known-stale gate locally even when refresh is down.
          }
          set((state) => {
            const gates = state.gates.filter((entry) => entry.id !== id);
            const selectedId = syncSelection({
              ...state,
              gates,
              selectedId: state.selectedId === id ? null : state.selectedId,
            });
            return {
              gates,
              selectedId,
              actingId: null,
              pendingDenyId: null,
              actionFeedback: {
                kind: "stale",
                message: `${gateLabel(gate)} was already resolved elsewhere and was removed from the pending queue.`,
              },
            };
          });
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        set({
          actingId: null,
          actionFeedback: {
            kind: "error",
            message: `Could not approve ${gateLabel(gate)}: ${message}. Try again.`,
          },
        });
      });
  },

  requestDeny: (id) => set({ pendingDenyId: id }),

  cancelDeny: () => set({ pendingDenyId: null }),

  confirmDeny: (id) => {
    const { gates, noteById, rpc } = get();
    const gate = gates.find((entry) => entry.id === id);
    if (!gate || gate.status !== "pending") {
      set({ pendingDenyId: null });
      return;
    }
    if (!rpc) {
      set({ pendingDenyId: null });
      return;
    }
    if (get().actingId !== null) return;

    set({ actingId: id, actionFeedback: null });
    const note = (noteById[id] ?? "").trim();

    void rpc
      .submit({
        runId: gate.runId,
        nodeId: gate.nodeId,
        iteration: gate.iteration ?? 0,
        decision: { approved: false, note: note === "" ? undefined : note },
      })
      .then(async () => {
        try {
          await rpc.refetch();
        } catch {
          // The decision was accepted. Keep it non-actionable even if the
          // pending-list refresh fails; polling can reconcile later.
        }
      })
      .then(() => {
        const state = get();
        const resolvedAtMs = Date.now();
        const decision: ApprovalDecision = {
          id: gate.id,
          runId: gate.runId,
          nodeId: gate.nodeId,
          gate: gate.gate,
          workflowPath: gate.workflowPath,
          iteration: gate.iteration,
          source: gate.source,
          payload: gate.payload,
          action: "denied",
          requestedAtMs: gate.requestedAtMs,
          resolvedAtMs,
          resolvedBy: "you",
          note: note === "" ? undefined : note,
          reason: note === "" ? "Denied at the approval gate." : note,
        };
        const nextGates = state.gates.filter((entry) => entry.id !== id);
        const nextDecisions = [decision, ...state.decisions];
        const selectedId = syncSelection({
          tab: state.tab,
          gates: nextGates,
          decisions: nextDecisions,
          selectedId: state.selectedId === id ? null : state.selectedId,
        });
        set({
          gates: nextGates,
          decisions: nextDecisions,
          selectedId,
          actingId: null,
          pendingDenyId: null,
          actionFeedback: {
            kind: "success",
            message: `Denied ${gateLabel(gate)} for run ${shortRunId(gate.runId)}.`,
          },
        });

        const label = gateLabel(gate);
        useChatStore
          .getState()
          .say(
            `Denied gate \`${label}\` on run \`${shortRunId(gate.runId)}\`. The waiting gate was failed.` +
              (note === "" ? "" : `\n\n> ${note}`),
          );
        useNotificationsStore.getState().notify({
          title: "Approval denied",
          detail: `${label} · ${shortRunId(gate.runId)}`,
          kind: "transient",
          command: "chat",
        });
      })
      .catch(async (error: unknown) => {
        if (isAlreadyDecided(error)) {
          try {
            await rpc.refetch();
          } catch {
            // Remove the known-stale gate locally even when refresh is down.
          }
          set((state) => {
            const gates = state.gates.filter((entry) => entry.id !== id);
            const selectedId = syncSelection({
              ...state,
              gates,
              selectedId: state.selectedId === id ? null : state.selectedId,
            });
            return {
              gates,
              selectedId,
              actingId: null,
              pendingDenyId: null,
              actionFeedback: {
                kind: "stale",
                message: `${gateLabel(gate)} was already resolved elsewhere and was removed from the pending queue.`,
              },
            };
          });
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        set({
          actingId: null,
          pendingDenyId: null,
          actionFeedback: {
            kind: "error",
            message: `Could not deny ${gateLabel(gate)}: ${message}. Try again.`,
          },
        });
      });
  },
}));

/**
 * Install the live gateway RPC seam into the store. Called by `ApprovalsBridge`
 * (the only place that may hold the `submitApproval` mutation + collection
 * refetch). Keeps React hooks out of the Zustand store body while the store's
 * approve/deny still drive the REAL `submitApproval` RPC.
 */
export function bindApprovalActions(rpc: ApprovalRpc): void {
  useApprovalsStore.setState({ rpc });
}
