import { Effect } from "effect";
import React from "react";
import { z } from "zod";
import { Sequence, Signal, Task, Workflow, createSmithers, signalRun } from "smthrs";
import type { SmithersDb } from "@smthrs/db/adapter";
import type { ParityFixture } from "../ParityFixture.ts";
import { ledgerSideEffects, recordExecution } from "./ledger.ts";

/**
 * A `<Signal>` node parks the run until a correlated signal is delivered.
 *
 * Ports the observable half of `case04`: the run parks in the waiting-event
 * state, the signal is inserted from a second connection the way
 * `smithers signal` and the gateway webhook do, and the resumed run commits
 * the signal payload as the node's output row before the descendant reads it.
 *
 * The oracle records NO events for the `release` node. That is the legacy
 * engine's actual behaviour, not a dropped projection: a signal park is
 * reported at run level (`RunStatusChanged`) and the node's own park and
 * release emit nothing. The node's `finished` state and its committed output
 * row are what pin the behaviour down here.
 */

const SIGNAL_NODE_ID = "release";
const POLL_INTERVAL_MS = 25;
const WAIT_TIMEOUT_MS = 30_000;

export const waitingEventFixture: ParityFixture = {
  id: "waiting-event",
  title: "a signal node parks and resumes with the delivered payload as its output",
  portsFaultCases: ["case04"],
  execution: "in-process",
  sideEffects: ledgerSideEffects,
  build: ({ dbPath, scratchDir }) => {
    const api = createSmithers(
      {
        input: z.object({}),
        release: z.object({ token: z.string() }),
        acted: z.object({ token: z.string() }),
      },
      { dbPath },
    );
    const { smithers, outputs, db, close } = api;
    const workflow = smithers(() =>
      React.createElement(
        Workflow,
        { name: "parity-waiting-event" },
        React.createElement(
          Sequence,
          null,
          React.createElement(Signal, {
            id: SIGNAL_NODE_ID,
            schema: outputs.release,
          }),
          React.createElement(Task, {
            id: "acted",
            output: outputs.acted,
            deps: { release: outputs.release },
            children: async (deps: { release: { token: string } }) => {
              recordExecution(scratchDir, "acted");
              return { token: deps.release.token };
            },
          }),
        ),
      ),
    );
    return { workflow, db, input: {}, close };
  },
  drive: async (context) => {
    const adapter = context.adapter as SmithersDb;
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const node = await adapter.getNode(context.runId, SIGNAL_NODE_ID, 0);
      const state = (node as { state?: string } | undefined)?.state;
      if (state === "waiting-event" || state === "waiting_event") {
        await Effect.runPromise(
          signalRun(adapter, context.runId, SIGNAL_NODE_ID, { token: "parity-token" }),
        );
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    throw new Error(`parity: signal node on ${context.runId} never parked in waiting-event`);
  },
};
