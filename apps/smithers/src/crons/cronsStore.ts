import { create } from "zustand";
import { useChatStore } from "../chat/chatStore";
import { useNotificationsStore } from "../notifications/notificationsStore";
import { createCron, deleteCron, toggleCron, validateCreate, type Cron } from "./crons";

/**
 * The triggers store: the LIVE cron list (pushed in by `CronsBridge` from the
 * gateway `crons` collection), the selection, the inline create form, the
 * delete-confirm flag, and the dismissable action-error banner the card and
 * canvas read.
 *
 * Mutations drive the REAL gateway RPCs via the `rpc` seam (`bindCronActions`,
 * mirroring `bindApprovalActions`): create → `cronCreate`, delete → `cronDelete`,
 * and toggle → `cronCreate` (flipped `enabled`) FIRST, then a best-effort
 * `cronDelete` of the old id (the gateway has NO enable/disable RPC, so an
 * in-place toggle is a recreate-then-drop; create-first guarantees the schedule
 * is never lost if the delete or a network hiccup intervenes — see
 * docs/p1b-plan.md §3.1). Each action updates the list OPTIMISTICALLY, then the
 * bridge re-pulls `cronList` so the canonical server rows reconcile. Feedback
 * (chat line + transient toast) is posted the same way the issues/vcs stores do.
 */

/**
 * The shape `CronsBridge` installs so store actions can hit the gateway RPCs.
 * `create`/`remove`/`toggle` resolve on success and reject on RPC failure; the
 * store rolls the optimistic list back and raises the action-error banner on a
 * reject. `refetch` re-pulls the live `cronList` collection.
 */
type CronRpc = {
  /** `cronCreate` — registers/replaces a schedule for the workflow KEY. */
  create: (vars: { workflow: string; pattern: string; enabled: boolean }) => Promise<unknown>;
  /** `cronDelete` — removes the schedule by id. */
  remove: (vars: { cronId: string }) => Promise<unknown>;
  /** Re-pull the live `crons` collection after a mutation lands. */
  refetch: () => Promise<unknown> | void;
};

type CronsState = {
  crons: Cron[];
  selectedId: string | null;
  creating: boolean;
  draftPattern: string;
  draftWorkflowPath: string;
  /** The trigger awaiting delete confirmation; non-null reveals the confirm strip. */
  pendingDeleteId: string | null;
  /** The dismissable action-error banner text (the Swift actionErrorBanner seam). */
  actionError: string | null;
  /** The live gateway RPC seam, installed by `CronsBridge` (null pre-mount). */
  rpc: CronRpc | null;
  select: (id: string) => void;
  openCreate: () => void;
  cancelCreate: () => void;
  setDraftPattern: (value: string) => void;
  setDraftWorkflowPath: (value: string) => void;
  submitCreate: () => void;
  toggle: (id: string) => void;
  requestDelete: (id: string) => void;
  cancelDelete: () => void;
  confirmDelete: () => void;
  refresh: () => void;
  dismissActionError: () => void;
};

export const useCronsStore = create<CronsState>((set, get) => ({
  crons: [],
  selectedId: null,
  creating: false,
  draftPattern: "",
  draftWorkflowPath: "",
  pendingDeleteId: null,
  actionError: null,
  rpc: null,

  select: (id) => set({ selectedId: id }),

  openCreate: () => set({ creating: true, draftPattern: "", draftWorkflowPath: "", actionError: null }),

  cancelCreate: () => set({ creating: false, draftPattern: "", draftWorkflowPath: "" }),

  setDraftPattern: (value) => set({ draftPattern: value }),

  setDraftWorkflowPath: (value) => set({ draftWorkflowPath: value }),

  submitCreate: () => {
    const { crons, draftPattern, draftWorkflowPath, rpc } = get();
    // The button is gated on validateCreate already; re-check so the action is
    // safe to call directly (and so a stray Enter never builds an invalid row).
    if (validateCreate(draftPattern, draftWorkflowPath) !== null) return;
    if (!rpc) return;

    const { crons: next, created } = createCron(crons, {
      pattern: draftPattern,
      workflowPath: draftWorkflowPath,
    });
    // Optimistic prepend + close the form; the refetch reconciles the canonical
    // server id/path once `cronCreate` lands.
    set({
      crons: next,
      selectedId: created.id,
      creating: false,
      draftPattern: "",
      draftWorkflowPath: "",
    });

    void rpc
      // The gateway keys crons by registered workflow KEY, not a file path, so
      // `workflowPath` IS the key here (the bridge maps `workflow` → workflowPath).
      .create({ workflow: created.workflowPath, pattern: created.pattern, enabled: true })
      .then(() => rpc.refetch())
      .then(() => {
        useChatStore.getState().say(`Created trigger ${created.name} (\`${created.pattern}\`).`);
        useNotificationsStore.getState().notify({
          title: "Trigger created",
          detail: `${created.name} · ${created.nextHint}`,
          kind: "transient",
          command: "chat",
        });
      })
      .catch((error: unknown) => {
        // Roll the optimistic row back and surface the failure.
        set((state) => ({
          crons: state.crons.filter((cron) => cron.id !== created.id),
          selectedId: state.selectedId === created.id ? null : state.selectedId,
          actionError: `Could not create trigger: ${errorText(error)}`,
        }));
      });
  },

  toggle: (id) => {
    const { crons, rpc } = get();
    const target = crons.find((cron) => cron.id === id);
    if (!target || !rpc) return;
    const willEnable = !target.enabled;

    // Optimistic in-place flip; the gateway has no enable/disable RPC, so the
    // real change is a recreate (flipped `enabled`) then a drop of the old id.
    set({ crons: toggleCron(crons, id) });

    // CREATE-FIRST (data-loss safe): the gateway keys crons by a random `cronId`
    // (no upsert-by-workflow), so `cronCreate` APPENDS a NEW row with the flipped
    // `enabled` — leaving the old row intact until we delete it. If create throws
    // the old cron is untouched (no loss): roll the flip back, surface the error,
    // and refetch (the catch below). Only AFTER create resolves do we best-effort
    // delete the old id; a delete failure leaves a TRANSIENT duplicate (same
    // workflow+pattern, opposite enabled) — acceptable, NOT data loss — which the
    // refetch surfaces and the operator can resolve. The clean fix is a server
    // `cronSetEnabled`/`cronUpdate` RPC (future smithers work).
    void rpc
      .create({ workflow: target.workflowPath, pattern: target.pattern, enabled: willEnable })
      .then(() => {
        // Best-effort drop of the now-stale old row. Swallow failures: the
        // flipped cron already exists, so the toggle SUCCEEDED regardless, and
        // refetch reconciles any leftover duplicate.
        return Promise.resolve(rpc.remove({ cronId: target.id })).catch(() => undefined);
      })
      .then(() => rpc.refetch())
      .then(() => {
        const verb = willEnable ? "Enabled" : "Disabled";
        useChatStore.getState().say(`${verb} trigger ${target.name}.`);
        useNotificationsStore.getState().notify({
          title: willEnable ? "Trigger enabled" : "Trigger disabled",
          detail: `${target.name} · ${target.pattern}`,
          kind: "transient",
          command: "chat",
        });
      })
      .catch((error: unknown) => {
        // CREATE failed → the old cron is still intact (no data loss). Roll back
        // the optimistic flip and refetch to recover canonical state.
        set((state) => ({
          crons: toggleCron(state.crons, id),
          actionError: `Could not toggle trigger: ${errorText(error)}`,
        }));
        void rpc.refetch();
      });
  },

  requestDelete: (id) => set({ pendingDeleteId: id }),

  cancelDelete: () => set({ pendingDeleteId: null }),

  confirmDelete: () => {
    const { crons, pendingDeleteId, selectedId, rpc } = get();
    if (!pendingDeleteId || !rpc) return;
    const target = crons.find((cron) => cron.id === pendingDeleteId);
    if (!target) {
      set({ pendingDeleteId: null });
      return;
    }

    // Optimistic removal; refetch reconciles after `cronDelete` lands.
    set({
      crons: deleteCron(crons, pendingDeleteId),
      pendingDeleteId: null,
      selectedId: selectedId === pendingDeleteId ? null : selectedId,
    });

    void rpc
      .remove({ cronId: target.id })
      .then(() => rpc.refetch())
      .then(() => {
        useChatStore.getState().say(`Deleted trigger ${target.name}.`);
        useNotificationsStore.getState().notify({
          title: "Trigger deleted",
          detail: `${target.name} · ${target.pattern}`,
          kind: "transient",
          command: "chat",
        });
      })
      .catch((error: unknown) => {
        // Restore the row on failure and recover canonical state.
        set((state) => ({
          crons: [target, ...state.crons.filter((cron) => cron.id !== target.id)],
          actionError: `Could not delete trigger: ${errorText(error)}`,
        }));
        void rpc.refetch();
      });
  },

  refresh: () => {
    const { rpc } = get();
    set({ pendingDeleteId: null, actionError: null });
    if (rpc) void rpc.refetch();
    useChatStore.getState().say("Reloaded triggers.");
  },

  dismissActionError: () => set({ actionError: null }),
}));

/** Best-effort human text for an RPC failure surfaced in the action banner. */
function errorText(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== "") return error.message;
  if (typeof error === "string" && error.trim() !== "") return error;
  return "the gateway rejected the request";
}

/**
 * Install the live gateway RPC seam into the store. Called by `CronsBridge` (the
 * only place that may hold the `cronCreate`/`cronDelete` mutations + collection
 * refetch). Keeps React hooks out of the Zustand store body while the store's
 * create/delete/toggle still drive the REAL gateway RPCs.
 */
export function bindCronActions(rpc: CronRpc): void {
  useCronsStore.setState({ rpc });
}
