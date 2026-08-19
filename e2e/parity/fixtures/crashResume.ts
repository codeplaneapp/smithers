import { writeFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { z } from "zod";
import { Sequence, Task, Workflow, createSmithers } from "smthrs";
import type { ParityFixture } from "../ParityFixture.ts";
import { ledgerSideEffects, recordExecution } from "./ledger.ts";

/**
 * SIGKILL the engine process mid-node, then resume the same run id in a fresh
 * process.
 *
 * Ports `case01` and `case31` into the parity suite. The first node commits
 * its output before the kill and must NOT run again; the second is
 * interrupted in flight and must, committing exactly one output row when it
 * finally finishes. That at-least-once-execution / at-most-once-commit split
 * is the durability claim every engine has to reproduce, and it is visible in
 * three independent places in the observation: the execution ledger, the
 * attempt trace, and the output rows.
 */

export const COMMITTED_NODE_ID = "committed";
export const INTERRUPTED_NODE_ID = "interrupted";
export const KILL_MARKER = "interrupted.started";

/** Long enough that the parent always wins the race to SIGKILL. */
const INITIAL_STALL_MS = 60_000;

export const crashResumeFixture: ParityFixture = {
  id: "crash-resume",
  title: "a SIGKILLed run resumes and commits each node's output exactly once",
  portsFaultCases: ["case01", "case31"],
  execution: "crash-resume",
  killAfterMarker: KILL_MARKER,
  timeoutMs: 90_000,
  sideEffects: ledgerSideEffects,
  build: ({ dbPath, scratchDir, mode }) => {
    const api = createSmithers(
      {
        input: z.object({}),
        committed: z.object({ value: z.number() }),
        interrupted: z.object({ value: z.number() }),
      },
      { dbPath },
    );
    const { smithers, outputs, db, close } = api;
    const workflow = smithers(() =>
      React.createElement(
        Workflow,
        { name: "parity-crash-resume" },
        React.createElement(
          Sequence,
          null,
          React.createElement(Task, {
            id: COMMITTED_NODE_ID,
            output: outputs.committed,
            children: async () => {
              recordExecution(scratchDir, COMMITTED_NODE_ID);
              return { value: 10 };
            },
          }),
          React.createElement(Task, {
            id: INTERRUPTED_NODE_ID,
            output: outputs.interrupted,
            deps: { committed: outputs.committed },
            children: async (deps: { committed: { value: number } }) => {
              recordExecution(scratchDir, INTERRUPTED_NODE_ID);
              writeFileSync(join(scratchDir, KILL_MARKER), "started");
              if (mode === "initial") {
                // Stay in flight until the parent SIGKILLs this process. The
                // resumed process collapses this to a no-op so the run can
                // finish.
                await new Promise((resolve) => setTimeout(resolve, INITIAL_STALL_MS));
              }
              return { value: deps.committed.value * 2 };
            },
          }),
        ),
      ),
    );
    return { workflow, db, input: {}, close };
  },
};
