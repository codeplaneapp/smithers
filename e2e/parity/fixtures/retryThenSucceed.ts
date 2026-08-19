import React from "react";
import { z } from "zod";
import { Sequence, Task, Workflow, createSmithers } from "smthrs";
import type { ParityFixture } from "../ParityFixture.ts";
import { ledgerSideEffects, readLedger, recordExecution } from "./ledger.ts";

/**
 * A task that throws on its first two bodies and succeeds on the third.
 *
 * The retry contract is observable three ways at once, and all three are in
 * the observation: the attempt rows (`failed`, `failed`, `finished`), the
 * per-node event trace (`NodeRetrying` between attempts), and the ledger,
 * which proves the body really ran three times rather than being replayed
 * from a cache.
 */
export const retryThenSucceedFixture: ParityFixture = {
  id: "retry-then-succeed",
  title: "a task that fails twice retries and commits one output row",
  portsFaultCases: [],
  execution: "in-process",
  sideEffects: ledgerSideEffects,
  build: ({ dbPath, scratchDir }) => {
    const api = createSmithers(
      {
        input: z.object({}),
        flaky: z.object({ attempts: z.number() }),
        downstream: z.object({ value: z.number() }),
      },
      { dbPath },
    );
    const { smithers, outputs, db, close } = api;
    const workflow = smithers(() =>
      React.createElement(
        Workflow,
        { name: "parity-retry-then-succeed" },
        React.createElement(
          Sequence,
          null,
          React.createElement(Task, {
            id: "flaky",
            output: outputs.flaky,
            retries: 3,
            retryPolicy: { backoff: "fixed", initialDelayMs: 1 },
            children: async () => {
              recordExecution(scratchDir, "flaky");
              const soFar = readLedger(scratchDir).filter((entry) => entry === "flaky").length;
              if (soFar < 3) throw new Error(`parity fixture: deliberate failure ${soFar}`);
              return { attempts: soFar };
            },
          }),
          React.createElement(Task, {
            id: "downstream",
            output: outputs.downstream,
            deps: { flaky: outputs.flaky },
            children: async (deps: { flaky: { attempts: number } }) => {
              recordExecution(scratchDir, "downstream");
              return { value: deps.flaky.attempts };
            },
          }),
        ),
      ),
    );
    return { workflow, db, input: {}, close };
  },
};
