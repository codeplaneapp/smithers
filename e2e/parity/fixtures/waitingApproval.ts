import { Effect } from "effect";
import React from "react";
import { z } from "zod";
import { Approval, Sequence, Task, Workflow, approvalDecisionSchema, createSmithers } from "smthrs";
import { approveNode, denyNode } from "@smthrs/engine";
import type { SmithersDb } from "@smthrs/db/adapter";
import type { ParityDriveContext, ParityFixture } from "../ParityFixture.ts";
import { ledgerSideEffects, recordExecution } from "./ledger.ts";

/**
 * `<Approval>` gates ported from the `e2e/faults` approval cases.
 *
 * The gate is decided from a SECOND database connection while the run is in
 * flight, which is the path `smithers approve` and the gateway's
 * `submitApproval` RPC take. What the parity contract covers is the durable
 * result: the waiting state the node parks in, the decision row that lands in
 * the approval output table, and whether the descendant runs.
 */

const APPROVAL_NODE_ID = "gate";
const DEPLOY_NODE_ID = "deploy";
const APPROVAL_POLL_INTERVAL_MS = 25;
const APPROVAL_WAIT_TIMEOUT_MS = 30_000;

function buildApprovalWorkflow(dbPath: string, scratchDir: string, workflowName: string, onDeny: "fail" | "skip") {
  const api = createSmithers(
    {
      input: z.object({ value: z.number() }),
      decision: approvalDecisionSchema,
      deploy: z.object({ value: z.number() }),
    },
    { dbPath },
  );
  const { smithers, outputs, db, close } = api;
  const workflow = smithers((ctx) =>
    React.createElement(
      Workflow,
      { name: workflowName },
      React.createElement(
        Sequence,
        null,
        React.createElement(Approval, {
          id: APPROVAL_NODE_ID,
          output: outputs.decision,
          onDeny,
          request: { title: "parity: approve the deploy?" },
        }),
        React.createElement(Task, {
          id: DEPLOY_NODE_ID,
          output: outputs.deploy,
          children: async () => {
            recordExecution(scratchDir, DEPLOY_NODE_ID);
            return { value: ctx.input.value };
          },
        }),
      ),
    ),
  );
  return { workflow, db, input: { value: 41 }, close };
}

/**
 * Wait until the gate node has durably parked in `waiting-approval`.
 *
 * The approval request row lands slightly before the node state does, and the
 * product refuses a decision on a node that is not parked yet, so polling the
 * node state (not the request row) is what an operator effectively waits on.
 */
async function waitForPendingApproval(context: ParityDriveContext): Promise<void> {
  const adapter = context.adapter as SmithersDb;
  const deadline = Date.now() + APPROVAL_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const node = await adapter.getNode(context.runId, APPROVAL_NODE_ID, 0);
    const state = (node as { state?: string } | undefined)?.state;
    if (state === "waiting-approval" || state === "waiting_approval") return;
    await new Promise((resolve) => setTimeout(resolve, APPROVAL_POLL_INTERVAL_MS));
  }
  throw new Error(`parity: approval gate on ${context.runId} never parked in waiting-approval`);
}

/**
 * Wait until the RUN — not just the gate node — has durably parked.
 *
 * The engine writes the park in two steps: the node state first, then the run
 * row (owner released, status `waiting-approval`) followed by the
 * `RunStatusChanged` event. A crash landing between those steps loses the run
 * park, so the resumed run replays a different event sequence than one that
 * parked cleanly. That makes the node-state poll the wrong kill signal for the
 * crash fixture: it resolves while the park is still half-written.
 *
 * Both durable writes are checked here, in the order the engine makes them, so
 * this resolves only once the whole park is on disk and the run is genuinely
 * ownerless.
 */
async function waitForParkedApprovalRun(context: ParityDriveContext): Promise<void> {
  const adapter = context.adapter as SmithersDb;
  const deadline = Date.now() + APPROVAL_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const run = await adapter.getRun(context.runId);
    const status = (run as { status?: string } | undefined)?.status;
    if (status === "waiting-approval" || status === "waiting_approval") {
      const parkEvents = await adapter.listEventsByType(context.runId, "RunStatusChanged");
      if (parkEvents.length > 0) return;
    }
    await new Promise((resolve) => setTimeout(resolve, APPROVAL_POLL_INTERVAL_MS));
  }
  throw new Error(`parity: run ${context.runId} never parked in waiting-approval`);
}

// `decidedAt` is a real wall-clock stamp on a real decision; the row's
// presence and the rest of its columns gate, the instant does not.
const REDACT_DECISION_TIMESTAMP = { decision: ["decided_at"] } as const;

export const waitingApprovalGrantedFixture: ParityFixture = {
  id: "waiting-approval-granted",
  title: "an approval gate parks, is granted out of band, and releases its descendant",
  portsFaultCases: ["case03", "case24"],
  execution: "in-process",
  redactOutputColumns: REDACT_DECISION_TIMESTAMP,
  sideEffects: ledgerSideEffects,
  build: ({ dbPath, scratchDir }) =>
    buildApprovalWorkflow(dbPath, scratchDir, "parity-waiting-approval-granted", "fail"),
  drive: async (context) => {
    await waitForPendingApproval(context);
    await Effect.runPromise(
      approveNode(
        context.adapter,
        context.runId,
        APPROVAL_NODE_ID,
        0,
        "parity fixture grant",
        "parity-operator",
      ),
    );
  },
};

/**
 * The restart case: the engine dies while the run is parked on the gate, the
 * gate is decided while nothing owns the run, and a fresh process picks the
 * run back up.
 *
 * This is `case03` end to end. Everything the granted-in-process fixture
 * asserts still has to hold across the process boundary — the decision row,
 * the descendant's single execution, and the terminal verdict.
 */
export const restartWaitingApprovalFixture: ParityFixture = {
  id: "restart-waiting-approval",
  title: "a run killed while parked on an approval resumes once the gate is decided",
  portsFaultCases: ["case03"],
  execution: "crash-resume",
  timeoutMs: 90_000,
  redactOutputColumns: REDACT_DECISION_TIMESTAMP,
  sideEffects: ledgerSideEffects,
  build: ({ dbPath, scratchDir }) =>
    buildApprovalWorkflow(dbPath, scratchDir, "parity-restart-waiting-approval", "fail"),
  killWhen: waitForParkedApprovalRun,
  drive: async (context) => {
    await Effect.runPromise(
      approveNode(
        context.adapter,
        context.runId,
        APPROVAL_NODE_ID,
        0,
        "parity fixture grant after restart",
        "parity-operator",
      ),
    );
  },
};

export const waitingApprovalDeniedFixture: ParityFixture = {
  id: "waiting-approval-denied",
  title: "a denied approval gate fails the run and its descendant never executes",
  portsFaultCases: ["case25"],
  execution: "in-process",
  redactOutputColumns: REDACT_DECISION_TIMESTAMP,
  sideEffects: ledgerSideEffects,
  build: ({ dbPath, scratchDir }) =>
    buildApprovalWorkflow(dbPath, scratchDir, "parity-waiting-approval-denied", "fail"),
  drive: async (context) => {
    await waitForPendingApproval(context);
    await Effect.runPromise(
      denyNode(
        context.adapter,
        context.runId,
        APPROVAL_NODE_ID,
        0,
        "parity fixture denial",
        "parity-operator",
      ),
    );
  },
};
