import React from "react";
import { z } from "zod";
import { Sequence, Task, Workflow, createSmithers } from "smthrs";
import type { ParityFixture } from "../ParityFixture.ts";
import { ledgerSideEffects, recordExecution } from "./ledger.ts";

/**
 * A task that fails terminally on its first and only attempt (`noRetry`),
 * followed by a downstream task that must never run.
 *
 * Ports the observable half of `case13` (collapsed ancestor failure marker):
 * the failure has to be attributed to the node that raised it and it has to
 * stop the descendants, which is exactly what the node states, the terminal
 * verdict, and the absent downstream output row record.
 */
export const terminalFailureFixture: ParityFixture = {
  id: "terminal-failure",
  title: "an exhausted task fails the run and its descendant never executes",
  portsFaultCases: ["case13"],
  execution: "in-process",
  sideEffects: ledgerSideEffects,
  build: ({ dbPath, scratchDir }) => {
    const api = createSmithers(
      {
        input: z.object({}),
        doomed: z.object({ value: z.number() }),
        never: z.object({ value: z.number() }),
      },
      { dbPath },
    );
    const { smithers, outputs, db, close } = api;
    const workflow = smithers(() =>
      React.createElement(
        Workflow,
        { name: "parity-terminal-failure" },
        React.createElement(
          Sequence,
          null,
          React.createElement(Task, {
            id: "doomed",
            output: outputs.doomed,
            noRetry: true,
            children: async () => {
              recordExecution(scratchDir, "doomed");
              throw new Error("parity fixture: terminal failure");
            },
          }),
          React.createElement(Task, {
            id: "never",
            output: outputs.never,
            deps: { doomed: outputs.doomed },
            children: async () => {
              recordExecution(scratchDir, "never");
              return { value: 1 };
            },
          }),
        ),
      ),
    );
    return { workflow, db, input: {}, close };
  },
};
