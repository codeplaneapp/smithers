import { create } from "zustand";
import { useChatStore } from "../chat/chatStore";
import { dispatchDirective, type AgentDirective } from "./agentTools";
import { parseAgentDirectives } from "./parseAgentDirectives";

export type Controller = "user" | "agent";

/** A queued batch of agent actions awaiting the user's approval. */
export type PendingControl = {
  /** One short sentence describing what the agent wants to do. */
  reason: string;
  /** The concrete actions, replayed on grant and listed in the dialog. */
  actions: AgentDirective[];
};

type ControlState = {
  controller: Controller;
  pendingControl: PendingControl | null;
  /** Open the approval gate with a reason (and no pre-queued actions). */
  requestControl: (reason: string) => void;
  /** Approve: take the app over and replay the queued actions. */
  grantControl: () => void;
  /** Reject the request and drop the queue. */
  denyControl: () => void;
  /** Hand control back to the user (Stop button, or the agent itself). */
  releaseControl: () => void;
  /** Apply the directives lifted from a finished assistant reply. */
  processReply: (directives: AgentDirective[]) => void;
};

/**
 * Who is driving the app, and the approval gate between them. The user holds
 * control by default; the agent's first batch of actions queues here and only
 * runs once the user grants control. After that the ring shows and the agent's
 * actions apply directly until the user (or the agent) releases control.
 */
export const useControlStore = create<ControlState>((set, get) => ({
  controller: "user",
  pendingControl: null,

  requestControl: (reason) => {
    if (get().controller !== "agent") {
      set({ pendingControl: { reason, actions: [] } });
    }
  },

  grantControl: () => {
    const pending = get().pendingControl;
    set({ controller: "agent", pendingControl: null });
    pending?.actions.forEach(dispatchDirective);
  },

  denyControl: () => set({ pendingControl: null }),

  releaseControl: () => set({ controller: "user", pendingControl: null }),

  processReply: (directives) => {
    if (directives.length === 0) {
      return;
    }
    // Backgrounding a workflow IS the concierge's job — it must not require the
    // user to hand over control of the whole app. Launch directives execute
    // immediately, ungated; only app-UI-mutating actions go through the gate.
    const isWorkflowLaunch = (tool: string) => tool === "startWorkflow" || tool === "launchRun";
    for (const directive of directives) {
      if (isWorkflowLaunch(directive.tool)) {
        dispatchDirective(directive);
      }
    }
    // Already in control: apply the remaining actions now, honoring a self-release.
    if (get().controller === "agent") {
      for (const directive of directives) {
        if (isWorkflowLaunch(directive.tool)) continue;
        if (directive.tool === "releaseControl") {
          get().releaseControl();
          break;
        }
        if (directive.tool === "requestControl") {
          continue;
        }
        dispatchDirective(directive);
      }
      return;
    }
    // User still in control: queue the remaining UI actions behind the gate.
    const actions = directives.filter(
      (directive) =>
        !isWorkflowLaunch(directive.tool) && directive.tool !== "requestControl" && directive.tool !== "releaseControl",
    );
    if (actions.length === 0) {
      return;
    }
    const reason = directives.find((directive) => directive.tool === "requestControl")?.reason;
    set({ pendingControl: { reason: reason ?? "Make changes to the app", actions } });
  },
}));

// Ambient styling hook without an effect: reflect the controller on <html> so
// CSS can tint the shell while the agent drives (module-load store.subscribe).
if (typeof document !== "undefined") {
  document.documentElement.dataset.controller = useControlStore.getState().controller;
  useControlStore.subscribe((state) => {
    document.documentElement.dataset.controller = state.controller;
  });
}

// The bridge: when a reply finishes streaming, lift any action block out of the
// assistant bubble and process it. This rides chatStore's stream lifecycle so
// the streaming code never has to know control exists.
useChatStore.subscribe((state, previous) => {
  if (!(previous.streaming && !state.streaming)) {
    return;
  }
  const last = state.messages[state.messages.length - 1];
  if (!last || last.role !== "assistant") {
    return;
  }
  const { cleanedText, directives } = parseAgentDirectives(last.text);
  if (directives.length === 0) {
    return;
  }
  if (cleanedText !== last.text) {
    useChatStore.setState((chat) => ({
      messages: chat.messages.map((message) =>
        message.id === last.id ? { ...message, text: cleanedText || "On it." } : message,
      ),
    }));
  }
  useControlStore.getState().processReply(directives);
});
