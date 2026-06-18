import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { Effect } from "effect";
import { z } from "zod";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
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
import { Gateway, type SmithersWorkflow } from "@smithers-orchestrator/server/gateway";
import { corruptHeartbeat } from "../harness/corruptHeartbeat.ts";

const RUN_ID = "run-case03";
const WORKFLOW_NAME = "case03-workflow";
const APPROVAL_NODE_ID = "approve-deploy";
const RESULT_NODE_ID = "deploy";
const OPERATOR_TOKEN = "operator-token";

function makeDbPath(): string {
  return join(
    tmpdir(),
    `smithers-case03-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

function queryClient(db: unknown) {
  return (db as { $client?: unknown; session?: { client?: unknown } }).$client
    ?? (db as { session?: { client?: unknown } }).session?.client;
}

function outputTable(table: unknown): SQLiteTable {
  return table as SQLiteTable;
}

function createApprovalWorkflow(dbPath: string) {
  const api = createSmithers(
    {
      input: z.object({ value: z.number().optional() }),
      decision: approvalDecisionSchema,
      deploy: z.object({ value: z.number() }),
    },
    { dbPath },
  );
  const { smithers, outputs, db, tables } = api;
  const workflow = smithers((ctx) =>
    React.createElement(
      Workflow,
      { name: WORKFLOW_NAME },
      React.createElement(
        Sequence,
        null,
        React.createElement(Approval, {
          id: APPROVAL_NODE_ID,
          output: outputs.decision,
          request: { title: "Approve production deploy?" },
        }),
        React.createElement(Task, {
          id: RESULT_NODE_ID,
          output: outputs.deploy,
          children: { value: Number(ctx.input.value ?? 1) },
        }),
      ),
    ),
  );
  return { workflow, db, tables };
}

function getPort(server: { address(): unknown }): number {
  const addr = server.address();
  if (!addr || typeof addr === "string" || typeof (addr as { port?: unknown }).port !== "number") {
    throw new Error("Gateway server did not expose a port");
  }
  return (addr as { port: number }).port;
}

async function postRpc(
  port: number,
  method: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/v1/rpc/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${OPERATOR_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
}

async function waitForFinishedRun(adapter: SmithersDb, runId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const run = await adapter.getRun(runId);
    if (run?.status === "finished") {
      return;
    }
    if (run?.status === "failed" || run?.status === "cancelled") {
      throw new Error(`Run reached terminal status ${run.status}`);
    }
    await Bun.sleep(25);
  }
  throw new Error("Timed out waiting for resumed run to finish");
}

describe("case03 restart during waiting-approval", () => {
  const dbPaths: string[] = [];
  let gateway: Gateway | undefined;

  afterEach(async () => {
    if (gateway) {
      await gateway.close();
      gateway = undefined;
    }
    for (const dbPath of dbPaths) {
      rmSync(dbPath, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
      rmSync(`${dbPath}-wal`, { force: true });
    }
    dbPaths.length = 0;
  });

  test("real engine resume re-enters the workflow at the waiting node", async () => {
    const dbPath = makeDbPath();
    dbPaths.push(dbPath);
    const { workflow, db, tables } = createApprovalWorkflow(dbPath);
    ensureSmithersTables(db);
    const adapter = new SmithersDb(db);
    const sqlite = queryClient(db);
    if (!sqlite || typeof (sqlite as { query?: unknown }).query !== "function") {
      throw new Error("Expected createSmithers to expose a Bun SQLite client");
    }

    const first = await Effect.runPromise(
      runWorkflow(workflow, {
        runId: RUN_ID,
        input: { value: 7 },
      }),
    );
    expect(first.status).toBe("waiting-approval");

    const requested = await adapter.getApproval(RUN_ID, APPROVAL_NODE_ID, 0);
    expect(requested?.status).toBe("requested");
    await corruptHeartbeat(sqlite as Parameters<typeof corruptHeartbeat>[0], RUN_ID, "stale");

    gateway = new Gateway({
      auth: {
        mode: "token",
        tokens: {
          [OPERATOR_TOKEN]: {
            role: "operator",
            scopes: ["run:read", "approval:submit"],
            userId: "user:operator",
          },
        },
      },
    });
    gateway.register(WORKFLOW_NAME, workflow as SmithersWorkflow);
    const server = (await gateway.listen({ port: 0, host: "127.0.0.1" })) as { address(): unknown };
    const port = getPort(server);

    const approved = await postRpc(port, "submitApproval", {
      runId: RUN_ID,
      nodeId: APPROVAL_NODE_ID,
      iteration: 0,
      approved: true,
      note: "ship it",
    });
    expect(approved.status).toBe(200);

    await waitForFinishedRun(adapter, RUN_ID);

    const decisionRows = await db.select().from(outputTable(tables.decision));
    expect(decisionRows).toEqual([
      expect.objectContaining({
        runId: RUN_ID,
        nodeId: APPROVAL_NODE_ID,
        iteration: 0,
        approved: true,
        note: "ship it",
        decidedBy: "user:operator",
      }),
    ]);

    const deployRows = await db.select().from(outputTable(tables.deploy));
    expect(deployRows).toEqual([
      expect.objectContaining({
        runId: RUN_ID,
        nodeId: RESULT_NODE_ID,
        iteration: 0,
        value: 7,
      }),
    ]);
  });
});
