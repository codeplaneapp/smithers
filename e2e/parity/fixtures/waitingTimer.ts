import React from "react";
import { z } from "zod";
import { Sequence, Task, Timer, Workflow, createSmithers } from "smthrs";
import type { ParityFixture } from "../ParityFixture.ts";
import { ledgerSideEffects, recordExecution } from "./ledger.ts";

/**
 * A `<Timer>` parks the run on the durable clock and wakes it on its own.
 *
 * Ports the observable half of `case05`. The duration is deliberately short:
 * what is being asserted is that the timer node parks, fires, and releases the
 * descendant exactly once, not how long it waited.
 */
export const waitingTimerFixture: ParityFixture = {
  id: "waiting-timer",
  title: "a timer node parks on the durable clock, fires, and releases its descendant",
  portsFaultCases: ["case05"],
  execution: "in-process",
  sideEffects: ledgerSideEffects,
  build: ({ dbPath, scratchDir }) => {
    const api = createSmithers(
      {
        input: z.object({}),
        after: z.object({ value: z.number() }),
      },
      { dbPath },
    );
    const { smithers, outputs, db, close } = api;
    const workflow = smithers(() =>
      React.createElement(
        Workflow,
        { name: "parity-waiting-timer" },
        React.createElement(
          Sequence,
          null,
          React.createElement(Timer, { id: "hold", duration: "250ms" }),
          React.createElement(Task, {
            id: "after",
            output: outputs.after,
            dependsOn: ["hold"],
            children: async () => {
              recordExecution(scratchDir, "after");
              return { value: 7 };
            },
          }),
        ),
      ),
    );
    return { workflow, db, input: {}, close };
  },
};
