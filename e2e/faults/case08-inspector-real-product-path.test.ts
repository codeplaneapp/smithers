import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
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
} from "smthrs";
import { SmithersDb } from "@smthrs/db/adapter";
import type { RunState } from "@smthrs/db/runState/RunState";
import { getDevToolsSnapshotRoute } from "@smthrs/server/gatewayRoutes/getDevToolsSnapshot";
import { assertNotIdle } from "./case08InspectorHelpers.ts";

const ACTIVE_RUN_ID = "run-case08-real-active";
const APPROVAL_RUN_ID = "run-case08-real-approval";
const FINISHED_RUN_ID = "run-case08-real-finished";
const ACTIVE_WORKFLOW_NAME = "case08-real-active-workflow";
const APPROVAL_WORKFLOW_NAME = "case08-real-approval-workflow";
const FINISHED_WORKFLOW_NAME = "case08-real-finished-workflow";
const APPROVAL_NODE_ID = "approve-deploy";
const RESULT_NODE_ID = "deploy";
const PERSISTENCE_TIMEOUT_MS = 5_000;

type WorkflowMode = "active" | "approval" | "finished";

type ActiveTaskControl = {
  started: Promise<void>;
  markStarted: () => void;
  waitForRelease: () => Promise<void>;
  release: () => void;
};

function makeDbPath(): string {
  return join(
    tmpdir(),
    `smithers-case08-real-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

function createActiveTaskControl(): ActiveTaskControl {
  let markStarted!: () => void;
  let releaseGate!: () => void;
  let released = false;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });

  return {
    started,
    markStarted,
    waitForRelease: () => gate,
    release: () => {
      if (released) return;
      released = true;
      releaseGate();
    },
  };
}

function createCase08Workflow(
  dbPath: string,
  mode: WorkflowMode,
  activeTask?: ActiveTaskControl,
) {
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
    const deploy =
      mode === "active"
        ? React.createElement(Task, {
            id: RESULT_NODE_ID,
            output: outputs.deploy,
            children: async () => {
              if (!activeTask) {
                throw new Error("Active case08 workflow requires a task control");
              }
              activeTask.markStarted();
              await activeTask.waitForRelease();
              return { value: Number(ctx.input.value ?? 1) };
            },
          })
        : React.createElement(Task, {
            id: RESULT_NODE_ID,
            output: outputs.deploy,
            children: { value: Number(ctx.input.value ?? 1) },
          });

    return React.createElement(
      Workflow,
      {
        name:
          mode === "active"
            ? ACTIVE_WORKFLOW_NAME
            : mode === "approval"
              ? APPROVAL_WORKFLOW_NAME
              : FINISHED_WORKFLOW_NAME,
      },
      mode === "approval"
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

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPersistedRun(
  adapter: SmithersDb,
  runId: string,
  expectedStatus: string,
) {
  let observedStatus = "missing";
  const deadline = Date.now() + PERSISTENCE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const run = await adapter.getRun(runId);
    if (run) {
      observedStatus = run.status;
      if (run.status === expectedStatus) return run;
    }
    await wait(25);
  }
  throw new Error(
    `Timed out waiting for ${runId} to persist as ${expectedStatus}; last status was ${observedStatus}`,
  );
}

async function readInspectorState(
  adapter: SmithersDb,
  runId: string,
  expectedStatus: string,
  expectedState: RunState,
) {
  const persisted = await waitForPersistedRun(adapter, runId, expectedStatus);
  const snapshot = await getDevToolsSnapshotRoute({ adapter, runId });
  const state = snapshot.runState;
  if (!state) {
    throw new Error(`Inspector snapshot for ${runId} omitted its derived run state`);
  }

  expect(snapshot.runId).toBe(runId);
  expect(persisted.status).toBe(expectedStatus);
  expect(state.state).toBe(expectedState);
  assertNotIdle(state.state, `${expectedState} product inspector path`);
  return { persisted, state };
}

describe("case 08: inspector real product path never shows idle", () => {
  const dbPaths: string[] = [];
  const sqliteClients: Database[] = [];

  afterEach(() => {
    for (const sqlite of sqliteClients.splice(0)) {
      sqlite.close();
    }
    for (const dbPath of dbPaths) {
      rmSync(dbPath, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
      rmSync(`${dbPath}-wal`, { force: true });
    }
    dbPaths.length = 0;
  });

  test("production inspector reports a persisted active workflow as running", async () => {
    const dbPath = makeDbPath();
    dbPaths.push(dbPath);
    const activeTask = createActiveTaskControl();
    const { workflow, db } = createCase08Workflow(dbPath, "active", activeTask);
    const productSqlite = (db as { $client?: Database }).$client;
    if (!productSqlite) {
      throw new Error("createSmithers did not expose its on-disk SQLite client");
    }
    sqliteClients.push(productSqlite);
    const inspectorSqlite = new Database(dbPath);
    sqliteClients.push(inspectorSqlite);
    const inspector = new SmithersDb(inspectorSqlite);
    const runPromise = Effect.runPromise(
      runWorkflow(workflow, {
        runId: ACTIVE_RUN_ID,
        input: { value: 7 },
      }),
    );

    try {
      await activeTask.started;
      const { persisted, state } = await readInspectorState(
        inspector,
        ACTIVE_RUN_ID,
        "running",
        "running",
      );
      expect(persisted.workflowName).toBe(ACTIVE_WORKFLOW_NAME);
      expect(state.blocked).toBeUndefined();
    } finally {
      activeTask.release();
      await runPromise;
    }
  }, 30_000);

  test("production inspector reports a persisted approval wait", async () => {
    const dbPath = makeDbPath();
    dbPaths.push(dbPath);
    const { workflow, db } = createCase08Workflow(dbPath, "approval");
    const productSqlite = (db as { $client?: Database }).$client;
    if (!productSqlite) {
      throw new Error("createSmithers did not expose its on-disk SQLite client");
    }
    sqliteClients.push(productSqlite);
    const inspectorSqlite = new Database(dbPath);
    sqliteClients.push(inspectorSqlite);
    const inspector = new SmithersDb(inspectorSqlite);

    const result = await Effect.runPromise(
      runWorkflow(workflow, {
        runId: APPROVAL_RUN_ID,
        input: { value: 7 },
      }),
    );
    expect(result.status).toBe("waiting-approval");

    const { persisted, state } = await readInspectorState(
      inspector,
      APPROVAL_RUN_ID,
      "waiting-approval",
      "waiting-approval",
    );
    expect(persisted.workflowName).toBe(APPROVAL_WORKFLOW_NAME);
    expect(state.blocked).toMatchObject({
      kind: "approval",
      nodeId: APPROVAL_NODE_ID,
    });
    if (state.blocked?.kind !== "approval") {
      throw new Error("Waiting-approval state did not include an approval blocker");
    }
    expect(typeof state.blocked.requestedAt).toBe("string");
  }, 30_000);

  test("production inspector reports a persisted terminal workflow as succeeded", async () => {
    const dbPath = makeDbPath();
    dbPaths.push(dbPath);
    const { workflow, db } = createCase08Workflow(dbPath, "finished");
    const productSqlite = (db as { $client?: Database }).$client;
    if (!productSqlite) {
      throw new Error("createSmithers did not expose its on-disk SQLite client");
    }
    sqliteClients.push(productSqlite);
    const inspectorSqlite = new Database(dbPath);
    sqliteClients.push(inspectorSqlite);
    const inspector = new SmithersDb(inspectorSqlite);

    const result = await Effect.runPromise(
      runWorkflow(workflow, {
        runId: FINISHED_RUN_ID,
        input: { value: 7 },
      }),
    );
    expect(result.status).toBe("finished");

    const { persisted } = await readInspectorState(
      inspector,
      FINISHED_RUN_ID,
      "finished",
      "succeeded",
    );
    expect(persisted.workflowName).toBe(FINISHED_WORKFLOW_NAME);
  }, 30_000);
});
