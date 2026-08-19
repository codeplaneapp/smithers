import React from "react";
import { z } from "zod";
import { Parallel, Sequence, Task, Workflow, createSmithers } from "smthrs";
import type { ParityFixture } from "../ParityFixture.ts";
import { ledgerSideEffects, recordExecution } from "./ledger.ts";

/**
 * Three independent compute tasks under `<Parallel>`, joined by a fourth that
 * reads all three.
 *
 * Interleaving is deliberately NOT part of the contract: the observation keys
 * events by node, so what is asserted is that every branch ran once, every
 * output row committed, and the join saw all three.
 */
export const parallelFanoutFixture: ParityFixture = {
  id: "parallel-fanout",
  title: "parallel branches each commit once and the join reads all of them",
  portsFaultCases: [],
  execution: "in-process",
  sideEffects: (scratchDir) => {
    const { executions } = ledgerSideEffects(scratchDir) as { executions: string[] };
    // Branch completion order is scheduler-dependent; only the multiset is a
    // parity contract.
    return { executions: [...executions].sort() };
  },
  build: ({ dbPath, scratchDir }) => {
    const api = createSmithers(
      {
        input: z.object({ seed: z.number() }),
        alpha: z.object({ value: z.number() }),
        beta: z.object({ value: z.number() }),
        gamma: z.object({ value: z.number() }),
        joined: z.object({ total: z.number() }),
      },
      { dbPath },
    );
    const { smithers, outputs, db, close } = api;
    const branch = (id: "alpha" | "beta" | "gamma", multiplier: number) =>
      React.createElement(Task, {
        id,
        output: outputs[id],
        children: async () => {
          recordExecution(scratchDir, id);
          return { value: multiplier };
        },
      });
    const workflow = smithers((ctx) =>
      React.createElement(
        Workflow,
        { name: "parity-parallel-fanout" },
        React.createElement(
          Sequence,
          null,
          React.createElement(
            Parallel,
            null,
            branch("alpha", ctx.input.seed * 1),
            branch("beta", ctx.input.seed * 2),
            branch("gamma", ctx.input.seed * 3),
          ),
          React.createElement(Task, {
            id: "joined",
            output: outputs.joined,
            deps: { alpha: outputs.alpha, beta: outputs.beta, gamma: outputs.gamma },
            children: async (deps: {
              alpha: { value: number };
              beta: { value: number };
              gamma: { value: number };
            }) => {
              recordExecution(scratchDir, "joined");
              return { total: deps.alpha.value + deps.beta.value + deps.gamma.value };
            },
          }),
        ),
      ),
    );
    return { workflow, db, input: { seed: 3 }, close };
  },
};
