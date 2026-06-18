import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import React from "react";
import { z } from "zod";
import { createSmithers } from "smithers-orchestrator";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { Gateway, type SmithersWorkflow } from "@smithers-orchestrator/server/gateway";

const WORKFLOW_KEY = "case14-workflow";
const RUN_ID = "case14-real-roundtrip";
const APPROVAL_NODE_ID = "approve-deploy";
const OPERATOR_TOKEN = "operator-token";
const VIEWER_TOKEN = "viewer-token";

type RpcBody = {
  ok: boolean;
  payload?: Record<string, unknown>;
  error?: { code: string; requiredScope?: string; message?: string };
};

function makeDbPath(): string {
  return join(
    tmpdir(),
    `smithers-case14-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

function createApprovalWorkflow(dbPath: string) {
  const { smithers, Workflow, Approval, outputs, db } = createSmithers(
    {
      input: z.object({ sha: z.string() }),
      approval: z.object({
        approved: z.boolean(),
        note: z.string().nullable(),
        decidedBy: z.string().nullable(),
        decidedAt: z.string().nullable(),
      }),
    },
    { dbPath },
  );
  const workflow = smithers(() =>
    React.createElement(
      Workflow,
      { name: WORKFLOW_KEY },
      React.createElement(Approval, {
        id: APPROVAL_NODE_ID,
        output: outputs.approval,
        request: { title: "Approve deploy", summary: "case14 real gateway roundtrip" },
      }),
    ),
  );
  return { workflow, db };
}

function getPort(server: { address(): unknown }): number {
  const address = server.address();
  if (!address || typeof address === "string" || typeof (address as { port?: unknown }).port !== "number") {
    throw new Error("Gateway server did not expose a port");
  }
  return (address as { port: number }).port;
}

async function postRpc(
  port: number,
  method: string,
  token: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: RpcBody }> {
  const response = await fetch(`http://127.0.0.1:${port}/v1/rpc/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as RpcBody };
}

async function waitFor<T>(
  read: () => Promise<T> | T,
  predicate: (value: T) => boolean,
  label: string,
): Promise<T> {
  const deadline = Date.now() + 10_000;
  let last: T;
  do {
    last = await read();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

describe("case 14: gateway authenticated RPC roundtrip", () => {
  let gateway: Gateway | undefined;
  let server: { address(): unknown } | undefined;
  let port = 0;
  let adapter: SmithersDb | undefined;
  const dbPaths: string[] = [];

  beforeEach(async () => {
    const dbPath = makeDbPath();
    dbPaths.push(dbPath);
    const { workflow, db } = createApprovalWorkflow(dbPath);
    ensureSmithersTables(db);
    adapter = new SmithersDb(db);

    gateway = new Gateway({
      auth: {
        mode: "token",
        tokens: {
          [OPERATOR_TOKEN]: {
            role: "operator",
            scopes: ["run:read", "run:write", "approval:submit"],
            userId: "user:operator",
          },
          [VIEWER_TOKEN]: {
            role: "viewer",
            scopes: ["run:read"],
            userId: "user:viewer",
          },
        },
      },
    });
    gateway.register(WORKFLOW_KEY, workflow as SmithersWorkflow);
    server = (await gateway.listen({ port: 0, host: "127.0.0.1" })) as { address(): unknown };
    port = getPort(server);
  });

  afterEach(async () => {
    if (gateway) {
      await gateway.close();
      gateway = undefined;
      server = undefined;
    }
    for (const dbPath of dbPaths) {
      rmSync(dbPath, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
      rmSync(`${dbPath}-wal`, { force: true });
    }
    dbPaths.length = 0;
  });

  test("real Gateway launchRun -> submitApproval -> finished round-trip", async () => {
    const launched = await postRpc(port, "launchRun", OPERATOR_TOKEN, {
      workflow: WORKFLOW_KEY,
      input: { sha: "abc123" },
      options: { runId: RUN_ID },
    });
    expect(launched.status).toBe(200);
    expect(launched.body.ok).toBe(true);
    expect(launched.body.payload?.runId).toBe(RUN_ID);
    expect(launched.body.payload?.workflow).toBe(WORKFLOW_KEY);

    const approval = await waitFor(
      () => Effect.runPromise(adapter!.getApproval(RUN_ID, APPROVAL_NODE_ID, 0)),
      (row) => row?.status === "requested",
      "approval request",
    );
    expect(approval?.runId).toBe(RUN_ID);

    const approved = await postRpc(port, "submitApproval", OPERATOR_TOKEN, {
      runId: RUN_ID,
      nodeId: APPROVAL_NODE_ID,
      iteration: 0,
      approved: true,
      decision: { approved: true, note: "ship it" },
    });
    expect(approved.status).toBe(200);
    expect(approved.body.ok).toBe(true);
    expect(approved.body.payload).toMatchObject({
      runId: RUN_ID,
      nodeId: APPROVAL_NODE_ID,
      iteration: 0,
      approved: true,
    });

    const finished = await waitFor(
      async () => (await postRpc(port, "getRun", OPERATOR_TOKEN, { runId: RUN_ID })).body,
      (body) => body.ok && body.payload?.status === "finished",
      "finished run",
    );
    expect(finished.payload?.workflowKey).toBe(WORKFLOW_KEY);

    const approvalAfter = await Effect.runPromise(adapter!.getApproval(RUN_ID, APPROVAL_NODE_ID, 0));
    expect(approvalAfter?.status).toBe("approved");
    expect(approvalAfter?.decidedBy).toBe("user:operator");
  });

  test("real Gateway rejects viewer-scoped launchRun before dispatch", async () => {
    const denied = await postRpc(port, "launchRun", VIEWER_TOKEN, {
      workflow: WORKFLOW_KEY,
      input: { sha: "abc123" },
    });
    expect(denied.status).toBe(403);
    expect(denied.body.ok).toBe(false);
    expect(denied.body.error?.code).toBe("FORBIDDEN");
    expect(denied.body.error?.requiredScope).toBe("run:write");
  });
});
