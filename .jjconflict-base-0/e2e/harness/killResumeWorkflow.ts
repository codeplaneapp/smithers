import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { z } from "zod";
import { Sequence, Task, Workflow, createSmithers } from "smithers-orchestrator";

/**
 * Shared workflow definition for the real engine kill/resume durability case
 * (case31). Both the test process and the spawned engine child import this so
 * they agree on the exact workflow shape, output schemas, and node ids.
 *
 * The workflow is two compute Tasks in a Sequence — NO agent CLI is involved,
 * so it runs on a clean CI box. Each compute function records a durable,
 * cross-process side effect:
 *
 *   - it appends the node id to an execution-counter file every time it runs;
 *   - it writes filesystem sidecar markers the parent test polls on.
 *
 * Node A is fast: it commits its output immediately. Node B writes a
 * `B.started` marker, then sleeps long enough for the parent to SIGKILL the
 * engine while B is mid-flight (before any output is committed). On resume the
 * sleep collapses to zero so the run can finish.
 *
 * The exactly-once invariant is read off the counter file after resume:
 *   - A must appear exactly once (committed before the kill -> never re-run);
 *   - B appears twice (interrupted, re-run on resume) but commits exactly one
 *     output row.
 */

export const A_NODE_ID = "node-a";
export const B_NODE_ID = "node-b";
export const A_VALUE = 10;
export const B_VALUE = 20;
export const WORKFLOW_NAME = "case31-kill-resume";

/** Filenames the engine child writes into the shared marker directory. */
export const MARKERS = {
  aDone: "A.done",
  bStarted: "B.started",
  bDone: "B.done",
} as const;

export type EngineChildMode = "initial" | "resume";

export interface BuildWorkflowOptions {
  /** On-disk sqlite db file. Must be a real file so a fresh process can reopen it. */
  readonly dbPath: string;
  /** Directory the compute functions write sidecar markers into. */
  readonly markerDir: string;
  /** Append-only file: one line per node execution (the exactly-once ledger). */
  readonly counterFile: string;
  /**
   * "initial": node B sleeps for `bSleepMs` so the engine can be killed mid-node.
   * "resume": node B does not sleep, so the resumed run finishes promptly.
   */
  readonly mode: EngineChildMode;
  /** How long node B sleeps on the initial run (ms). */
  readonly bSleepMs?: number;
}

function recordExecution(counterFile: string, nodeId: string): void {
  appendFileSync(counterFile, `${nodeId}\n`);
}

function writeMarker(markerDir: string, name: string): void {
  writeFileSync(join(markerDir, name), `${Date.now()}`);
}

/**
 * Build the durability workflow plus the live db/tables handles. The test and
 * the child both call this; the child runs the workflow, the test reopens the
 * same on-disk db afterwards to inspect committed output rows.
 */
export function buildKillResumeWorkflow(opts: BuildWorkflowOptions) {
  const { dbPath, markerDir, counterFile, mode } = opts;
  const bSleepMs = opts.bSleepMs ?? 60_000;

  const api = createSmithers(
    {
      a: z.object({ value: z.number() }),
      b: z.object({ value: z.number() }),
    },
    { dbPath },
  );
  const { smithers, outputs, db, tables } = api;

  const workflow = smithers(() =>
    React.createElement(
      Workflow,
      { name: WORKFLOW_NAME },
      React.createElement(
        Sequence,
        null,
        React.createElement(Task, {
          id: A_NODE_ID,
          output: outputs.a,
          children: async () => {
            recordExecution(counterFile, A_NODE_ID);
            writeMarker(markerDir, MARKERS.aDone);
            return { value: A_VALUE };
          },
        }),
        React.createElement(Task, {
          id: B_NODE_ID,
          output: outputs.b,
          children: async () => {
            recordExecution(counterFile, B_NODE_ID);
            writeMarker(markerDir, MARKERS.bStarted);
            if (mode === "initial" && bSleepMs > 0) {
              // Stay in-flight long enough for the parent to poll the
              // B.started marker and SIGKILL the engine before any output
              // row is committed. On resume this collapses to a no-op.
              await new Promise((resolve) => setTimeout(resolve, bSleepMs));
            }
            writeMarker(markerDir, MARKERS.bDone);
            return { value: B_VALUE };
          },
        }),
      ),
    ),
  );

  return { workflow, db, tables };
}
