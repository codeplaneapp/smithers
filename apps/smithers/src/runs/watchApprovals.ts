import { useChatStore } from "../chat/chatStore";
import { useNotificationsStore } from "../notifications/notificationsStore";
import { useRunsStore } from "./runsStore";

// The "approval waiting" toast id per run, kept until the gate resolves so the
// toast can be marked done (workflow toasts only auto-dismiss once done).
const pendingToast = new Map<string, string>();

/**
 * Bridge the run engine to the chat: when a run reaches the deploy gate, surface
 * the approval card and a toast, once per run; when the gate resolves, mark that
 * toast done so it dismisses instead of lingering as "1 approval waiting". A
 * module-load `store.subscribe` rather than an effect (the memory's pattern),
 * keeping the engine itself unaware of chat.
 */
export function startApprovalWatcher(): void {
  useRunsStore.subscribe((state) => {
    for (const run of state.runs) {
      if (run.gate === "pending" && !pendingToast.has(run.id)) {
        const chat = useChatStore.getState();
        chat.say("Tests passed. The next step deploys to production and is gated.");
        chat.postCard({ kind: "approval", runId: run.id });
        const toastId = useNotificationsStore.getState().notify({
          title: "1 approval waiting",
          detail: "deploy · 40s",
          kind: "workflow",
          command: "chat",
        });
        pendingToast.set(run.id, toastId);
      } else if (
        (run.gate === "approved" || run.gate === "denied" || run.canceled) &&
        pendingToast.has(run.id)
      ) {
        const toastId = pendingToast.get(run.id);
        pendingToast.delete(run.id);
        if (toastId) {
          useNotificationsStore.getState().update(toastId, { status: "done" });
        }
      }
    }
  });
}
