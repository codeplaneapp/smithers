import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { Effect } from "effect";
import { z } from "zod";
import {
  Approval,
  Sequence,
  Task,
  Workflow,
  approvalDecisionSchema,
  createSmithers,
  runWorkflow,
} from "smithers-orchestrator";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { computeRunStateFromRow } from "@smithers-orchestrator/db/runState";
import type { RunState } from "@smithers-orchestrator/db/runState";

const APPROVAL_RUN_ID = "run-case08-real-approval";
const FINISHED_RUN_ID = "run-case08-real-finished";
const APPROVAL_WORKFLOW_NAME = "case08-real-approval-workflow";
const FINISHED_WORKFLOW_NAME = "case08-real-finished-workflow";
const APPROVAL_NODE_ID = "approve-deploy";
const RESULT_NODE_ID = "deploy";

const ALLOWED_STATES: ReadonlySet<RunState> = new Set<RunState>([
  "running",
  "waiting-approval",
  "waiting-event",
  "waiting-timer",
  "waiting-quota",
  "paused",
  "recovering",
  "stale",
  "orphaned",
  "failed",
  "cancelled",
  "succeeded",
  "unknown",
]);

function makeDbPath(): string {
  return join(
    tmpdir(),
    `smithers-case08-real-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

function isIdleLike(state: string): boolean {
  const lowered = state.toLowerCase();
  return lowered === "idle" || lowered === "" || lowered === "unspecified";
}

function assertNotIdle(state: RunState, scenario: string): void {
  expect(state, `${scenario} produced idle-like state`).not.toBe(
    "idle" as unknown as RunState,
  );
  expect(isIdleLike(state), `${scenario} produced idle-like state`).toBe(false);
  expect(
    ALLOWED_STATES.has(state),
    `${scenario} produced state outside allowed enum: ${state}`,
  ).toBe(true);
}

function createCase08Workflow(dbPath: string, includeApproval: boolean) {
  const api = createSmithers(
    {
      input: z.object({ value: z.number().optional() }),
      decision: approvalDecisionSchema,
      deploy: z.object({ value: z.number() }),
    },
    { dbPath },
  );
  const { smithers, outputs, db } = api;
  const workflow = smithers((ctx) => {
    const deploy = React.createElement(
      Task,
      {
        id: RESULT_NODE_ID,
        output: outputs.deploy,
      },
      { value: Number(ctx.input.value ?? 1) },
    );

    return React.createElement(
      Workflow,
      { name: includeApproval ? APPROVAL_WORKFLOW_NAME : FINISHED_WORKFLOW_NAME },
      includeApproval
        ? React.createElement(
            Sequence,
            null,
            React.createElement(Approval, {
              id: APPROVAL_NODE_ID,
              output: outputs.decision,
              request: { title: "Approve production deploy?" },
            }),
            deploy,
          )
        : deploy,
    );
  });
  return { workflow, db };
}

describe("case 08: inspector real product path never shows idle", () => {
  const dbPaths: string[] = [];

  afterEach(() => {
    for (const dbPath of dbPaths) {
      rmSync(dbPath, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
      rmSync(`${dbPath}-wal`, { force: true });
    }
    dbPaths.length = 0;
  });

  test("gateway inspector read path reports waiting approval from the real db", async () => {
    const dbPath = makeDbPath();
    dbPaths.push(dbPath);
    const { workflow, db } = createCase08Workflow(dbPath, true);
    ensureSmithersTables(db);
    const adapter = new SmithersDb(db);

    const result = await Effect.runPromise(
      runWorkflow(workflow, {
        runId: APPROVAL_RUN_ID,
        input: { value: 7 },
      }),
    );
    expect(result.status).toBe("waiting-approval");

    const run = await adapter.getRun(APPROVAL_RUN_ID);
    expect(run).toBeDefined();
    const view = await computeRunStateFromRow(adapter, run);

    expect(view.state).toBe("waiting-approval");
    assertNotIdle(view.state, "waiting approval product path");
    expect(view.blocked).toMatchObject({
      kind: "approval",
      nodeId: APPROVAL_NODE_ID,
    });
    expect(typeof view.blocked?.requestedAt).toBe("string");
  }, 30_000);

  test("gateway inspector read path reports completed literal tasks as succeeded", async () => {
    const dbPath = makeDbPath();
    dbPaths.push(dbPath);
    const { workflow, db } = createCase08Workflow(dbPath, false);
    ensureSmithersTables(db);
    const adapter = new SmithersDb(db);

    const result = await Effect.runPromise(
      runWorkflow(workflow, {
        runId: FINISHED_RUN_ID,
        input: { value: 7 },
      }),
    );
    expect(result.status).toBe("finished");

    const run = await adapter.getRun(FINISHED_RUN_ID);
    expect(run).toBeDefined();
    const view = await computeRunStateFromRow(adapter, run);

    expect(view.state).toBe("succeeded");
    assertNotIdle(view.state, "finished literal task product path");
  }, 30_000);
});
