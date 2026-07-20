import { goToView } from "../app/navigation";
import { useChatStore } from "../chat/chatStore";
import { useNotificationsStore } from "../notifications/notificationsStore";
import type { StoreWorkflow } from "./workflows";

/**
 * Open a workflow picked from the store: jump to its view, or drop into chat with
 * its starter prompt prefilled, then raise a transient toast. Drives stores
 * directly so the store grid needs no callback prop.
 */
export function openWorkflow(workflow: StoreWorkflow): void {
  if (workflow.command) {
    goToView(workflow.command === "chat" ? "home" : workflow.command);
  } else if (workflow.starter) {
    goToView("home");
    useChatStore.getState().fill(workflow.starter);
  }
  useNotificationsStore.getState().notify({
    title: workflow.name,
    detail: "Workflow opened",
    kind: "transient",
    command: workflow.command,
  });
}
