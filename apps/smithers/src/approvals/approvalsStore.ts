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
   * failure (the store suppresses an `AlreadyDecided` reject as a benign no-op).
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
  /** Per-gate draft decision note, mirroring ApprovalCard's noteByRun. */
  noteById: Record<string, string>;
  nowMs: number;
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

/** True when an RPC reject is the idempotent "already decided" case to suppress. */
function isAlreadyDecided(error: unknown): boolean {
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
  noteById: {},
  nowMs: Date.now(),
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

    set({ actingId: id });
    const note = (noteById[id] ?? "").trim();

    void rpc
      .submit({
        runId: gate.runId,
        nodeId: gate.nodeId,
        iteration: gate.iteration ?? 0,
        decision: { approved: true, note: note === "" ? undefined : note },
      })
      .then(() => rpc.refetch())
      .catch((error: unknown) => {
        if (!isAlreadyDecided(error)) throw error;
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
        set({ gates: nextGates, decisions: nextDecisions, selectedId, actingId: null });

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
      .catch(() => {
        // A genuine RPC failure: clear the in-flight flag, leave the gate pending.
        set({ actingId: null });
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

    set({ actingId: id });
    const note = (noteById[id] ?? "").trim();

    void rpc
      .submit({
        runId: gate.runId,
        nodeId: gate.nodeId,
        iteration: gate.iteration ?? 0,
        decision: { approved: false, note: note === "" ? undefined : note },
      })
      .then(() => rpc.refetch())
      .catch((error: unknown) => {
        if (!isAlreadyDecided(error)) throw error;
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
      .catch(() => {
        set({ actingId: null, pendingDenyId: null });
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
