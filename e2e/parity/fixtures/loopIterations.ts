import React from "react";
import { z } from "zod";
import { Loop, Sequence, Task, Workflow, createSmithers } from "smthrs";
import type { ParityFixture } from "../ParityFixture.ts";
import { ledgerSideEffects, recordExecution } from "./ledger.ts";

/**
 * A `<Loop>` whose `until` is derived from the rows its body has already
 * committed, so it stops after exactly three iterations.
 *
 * Iterations are the one place where a node id is not unique, and the
 * observation keys nodes and events by `nodeId::iteration` precisely so this
 * fixture pins that down: three node rows, three attempts, three output rows,
 * and one event trace per iteration.
 */
const TARGET_ITERATIONS = 3;

export const loopIterationsFixture: ParityFixture = {
  id: "loop-iterations",
  title: "a loop commits one node, attempt, and output row per iteration",
  portsFaultCases: [],
  execution: "in-process",
  sideEffects: ledgerSideEffects,
  build: ({ dbPath, scratchDir }) => {
    const api = createSmithers(
      {
        input: z.object({}),
        tick: z.object({ index: z.number() }),
      },
      { dbPath },
    );
    const { smithers, outputs, db, close } = api;
    const workflow = smithers((ctx) => {
      const ticks = (ctx.outputs.tick ?? []) as { index: number }[];
      return React.createElement(
        Workflow,
        { name: "parity-loop-iterations" },
        React.createElement(
          Loop,
          {
            id: "counter",
            until: ticks.length >= TARGET_ITERATIONS,
            maxIterations: TARGET_ITERATIONS,
            onMaxReached: "return-last",
          },
          React.createElement(
            Sequence,
            null,
            React.createElement(Task, {
              id: "tick",
              output: outputs.tick,
              children: async () => {
                recordExecution(scratchDir, "tick");
                return { index: ticks.length };
              },
            }),
          ),
        ),
      );
    });
    return { workflow, db, input: {}, close };
  },
};
