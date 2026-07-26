import { assign, setup } from "xstate";

/**
 * Output table keys shared by the workflow, its UI, and its tests, so all three
 * fold the same durable rows.
 */
export const RELEASE_TRAIN_OUTPUTS = {
  research: "releaseResearch",
  approval: "releaseApproval",
  draft: "releaseDraft",
  wait: "releaseWait",
} as const;

/**
 * A release train: research, a human approval, then a drafting loop that
 * re-enters once per external REVISE signal until it times out.
 *
 * Defined at module scope on purpose — a machine recreated inside the component
 * body defeats the fold's prefix cache on every frame.
 */
export const releaseTrainMachine = setup({
  types: {
    context: {} as { revision: number },
    events: {} as
      | { type: "RESEARCH_READY" }
      | { type: "APPROVED"; note?: string }
      | { type: "REJECTED" }
      | { type: "DRAFT_READY" }
      | { type: "REVISE"; feedback?: string }
      | { type: "TIMEOUT" },
  },
}).createMachine({
  id: "releaseTrain",
  context: { revision: 0 },
  initial: "researching",
  states: {
    researching: { on: { RESEARCH_READY: "awaitingApproval" } },
    awaitingApproval: { on: { APPROVED: "drafting", REJECTED: "researching" } },
    // Re-enterable: every task identity here must be derived from context, or
    // the completed (nodeId, iteration) never re-executes and the run deadlocks.
    drafting: {
      meta: { smithersTaskId: ({ revision }: { revision: number }) => `draft-r${revision}` },
      on: { DRAFT_READY: "waitingForRevision" },
    },
    waitingForRevision: {
      meta: { smithersTaskId: ({ revision }: { revision: number }) => `revise-r${revision}` },
      on: {
        REVISE: { target: "drafting", actions: assign({ revision: ({ context }) => context.revision + 1 }) },
        TIMEOUT: "done",
      },
    },
    done: { type: "final" },
  },
});

/** Static chart topology, used by the UI to draw states it has not reached yet. */
export const releaseTrainStates = [
  "researching",
  "awaitingApproval",
  "drafting",
  "waitingForRevision",
  "done",
] as const;

export const releaseTrainTransitions = [
  ["researching", "RESEARCH_READY", "awaitingApproval"],
  ["awaitingApproval", "APPROVED", "drafting"],
  ["awaitingApproval", "REJECTED", "researching"],
  ["drafting", "DRAFT_READY", "waitingForRevision"],
  ["waitingForRevision", "REVISE", "drafting"],
  ["waitingForRevision", "TIMEOUT", "done"],
] as const;
