import React from "react";
import { z } from "zod";
import { Sequence, Task, Workflow, createSmithers } from "smthrs";
import type { ParityFixture } from "../ParityFixture.ts";
import { ledgerSideEffects, recordExecution } from "./ledger.ts";

/**
 * Baseline: three compute tasks in a `<Sequence>`, each reading the previous
 * node's committed output through `deps`.
 *
 * This is the floor of the parity contract — ordering, dependency delivery,
 * one output row per node, and a clean `finished` verdict.
 */
export const linearSequenceFixture: ParityFixture = {
  id: "linear-sequence",
  title: "sequence of compute tasks passes committed outputs downstream",
  portsFaultCases: [],
  execution: "in-process",
  sideEffects: ledgerSideEffects,
  build: ({ dbPath, scratchDir }) => {
    const api = createSmithers(
      {
        input: z.object({ seed: z.number() }),
        first: z.object({ value: z.number() }),
        second: z.object({ value: z.number() }),
        third: z.object({ value: z.number() }),
      },
      { dbPath },
    );
    const { smithers, outputs, db, close } = api;
    const workflow = smithers((ctx) =>
      React.createElement(
        Workflow,
        { name: "parity-linear-sequence" },
        React.createElement(
          Sequence,
          null,
          React.createElement(Task, {
            id: "first",
            output: outputs.first,
            children: async () => {
              recordExecution(scratchDir, "first");
              return { value: ctx.input.seed };
            },
          }),
          React.createElement(Task, {
            id: "second",
            output: outputs.second,
            deps: { first: outputs.first },
            children: async (deps: { first: { value: number } }) => {
              recordExecution(scratchDir, "second");
              return { value: deps.first.value * 2 };
            },
          }),
          React.createElement(Task, {
            id: "third",
            output: outputs.third,
            deps: { second: outputs.second },
            children: async (deps: { second: { value: number } }) => {
              recordExecution(scratchDir, "third");
              return { value: deps.second.value + 1 };
            },
          }),
        ),
      ),
    );
    return { workflow, db, input: { seed: 5 }, close };
  },
};
