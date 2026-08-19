import React from "react";
import { z } from "zod";
import { Branch, Sequence, Task, Workflow, createSmithers } from "smthrs";
import type { ParityFixture } from "../ParityFixture.ts";
import { ledgerSideEffects, recordExecution } from "./ledger.ts";

/**
 * `<Branch>` resolves to one subtree.
 *
 * The unselected side must leave no node row, no attempt, and no output row.
 * That absence is a real part of the contract: an engine that materializes
 * the untaken branch as a skipped node instead of not materializing it at all
 * changes what every downstream projection and UI reports.
 */
export const branchSelectionFixture: ParityFixture = {
  id: "branch-selection",
  title: "a branch executes only the selected subtree",
  portsFaultCases: [],
  execution: "in-process",
  sideEffects: ledgerSideEffects,
  build: ({ dbPath, scratchDir }) => {
    const api = createSmithers(
      {
        input: z.object({ takeThen: z.boolean() }),
        taken: z.object({ path: z.string() }),
        untaken: z.object({ path: z.string() }),
      },
      { dbPath },
    );
    const { smithers, outputs, db, close } = api;
    const workflow = smithers((ctx) =>
      React.createElement(
        Workflow,
        { name: "parity-branch-selection" },
        React.createElement(
          Sequence,
          null,
          React.createElement(Branch, {
            if: ctx.input.takeThen,
            then: React.createElement(Task, {
              id: "taken",
              output: outputs.taken,
              children: async () => {
                recordExecution(scratchDir, "taken");
                return { path: "then" };
              },
            }),
            else: React.createElement(Task, {
              id: "untaken",
              output: outputs.untaken,
              children: async () => {
                recordExecution(scratchDir, "untaken");
                return { path: "else" };
              },
            }),
          }),
        ),
      ),
    );
    return { workflow, db, input: { takeThen: true }, close };
  },
};
