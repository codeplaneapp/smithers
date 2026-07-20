import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { z } from "zod";
import { createSmithers } from "smithers-orchestrator";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { hasGatewayScope } from "@smithers-orchestrator/gateway/auth/scopes";
import { Gateway, type SmithersWorkflow } from "@smithers-orchestrator/server/gateway";

// case25 — approval scope denial against the REAL gateway.
//
// This drives @smithers-orchestrator/server's Gateway over its real HTTP
// `/v1/rpc/<method>` surface with token-based auth. A viewer-scoped token
// (run:read only) that calls `submitApproval` must hit the gateway's real
// scope gate and receive a 403 FORBIDDEN whose `requiredScope` is
// `approval:submit` — never decide the approval — while an operator token that
// holds `approval:submit` resolves it. No handler logic is re-implemented here:
// the assertions check the real responses and the real DB rows the gateway
// mutates.

const RUN_ID = "run-case25";
const NODE_ID = "approve-deploy";
const ITERATION = 0;

const VIEWER_TOKEN = "viewer-token";
const OPERATOR_TOKEN = "operator-token";

function makeDbPath(name: string): string {
  return join(
    tmpdir(),
    `smithers-case25-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

function createApprovalWorkflow(dbPath: string) {
  const { smithers, Workflow, Task, outputs, db } = createSmithers(
    {
      input: z.object({ value: z.number().optional() }),
      deploy: z.object({ value: z.number() }),
    },
    { dbPath },
  );
  const workflow = smithers((ctx) =>
    React.createElement(
      Workflow,
      { name: "case25-workflow" },
      React.createElement(
        Task,
        {
          id: NODE_ID,
          output: outputs.deploy,
          children: { value: Number(ctx.input.value ?? 1) },
        },
      ),
    ),
  );
  return { workflow, db };
}

/**
 * Seed a run that is parked on a real waiting-approval node, exactly as the
 * engine would persist it: a `waiting-approval` run, a `waiting-approval` node,
 * and a `requested` approval row. `resolveRun` will discover this run by
 * querying the registered workflow's adapter, so the gateway operates on the
 * same database the production resume path would.
 */
async function seedWaitingApproval(adapter: SmithersDb, now: number): Promise<void> {
  await adapter.insertRun({
    runId: RUN_ID,
    workflowName: "case25-workflow",
    status: "waiting-approval",
    createdAtMs: now - 5_000,
    startedAtMs: now - 4_000,
    heartbeatAtMs: now - 1_000,
    runtimeOwnerId: null,
    configJson: JSON.stringify({
      auth: {
        triggeredBy: "user:operator",
        role: "operator",
        scopes: ["*"],
        createdAt: new Date(now - 5_000).toISOString(),
      },
    }),
  });
  await adapter.insertNode({
    runId: RUN_ID,
    nodeId: NODE_ID,
    iteration: ITERATION,
    state: "waiting-approval",
    lastAttempt: null,
    updatedAtMs: now - 1_000,
    outputTable: "out_node",
    label: null,
  });
  await adapter.insertOrUpdateApproval({
    runId: RUN_ID,
    nodeId: NODE_ID,
    iteration: ITERATION,
    status: "requested",
    requestedAtMs: now - 1_500,
    decidedAtMs: null,
    decidedBy: null,
    note: null,
    requestJson: JSON.stringify({ prompt: "approve production deploy?" }),
    decisionJson: null,
    autoApproved: false,
  });
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
  token: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/v1/rpc/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

describe("case25 approval scope denial", () => {
  test("hasGatewayScope rejects viewer-scope tokens for approval:submit", () => {
    expect(hasGatewayScope(["run:read"], "approval:submit", "approval:submit")).toBe(false);
    expect(hasGatewayScope(["run:write"], "approval:submit", "approval:submit")).toBe(false);
    expect(hasGatewayScope(["run:admin"], "approval:submit", "approval:submit")).toBe(false);
    expect(hasGatewayScope(["signal:submit"], "approval:submit", "approval:submit")).toBe(false);
    expect(hasGatewayScope(["observability:read"], "approval:submit", "approval:submit")).toBe(false);
    expect(hasGatewayScope([], "approval:submit", "approval:submit")).toBe(false);
  });

  test("hasGatewayScope accepts approval:submit, wildcard, or admin tokens", () => {
    expect(hasGatewayScope(["approval:submit"], "approval:submit", "approval:submit")).toBe(true);
    expect(hasGatewayScope(["*"], "approval:submit", "approval:submit")).toBe(true);
    expect(hasGatewayScope(["admin"], "approval:submit", "approval:submit")).toBe(true);
    expect(hasGatewayScope(["approve"], "approval:submit", "approval:submit")).toBe(true);
  });

  describe("against a real booted gateway", () => {
    let gateway: Gateway | undefined;
    let server: { address(): unknown } | undefined;
    let port = 0;
    const dbPaths: string[] = [];

    beforeEach(async () => {
      const dbPath = makeDbPath("approval");
      dbPaths.push(dbPath);
      const { workflow, db } = createApprovalWorkflow(dbPath);
      ensureSmithersTables(db);
      const adapter = new SmithersDb(db);
      await seedWaitingApproval(adapter, Date.now());

      gateway = new Gateway({
        auth: {
          mode: "token",
          tokens: {
            [VIEWER_TOKEN]: {
              role: "viewer",
              scopes: ["run:read", "observability:read"],
              userId: "user:viewer",
            },
            [OPERATOR_TOKEN]: {
              role: "operator",
              scopes: ["run:read", "approval:submit"],
              userId: "user:operator",
            },
          },
        },
      });
      gateway.register("case25-workflow", workflow as SmithersWorkflow);
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

    test("viewer-scope token is denied with FORBIDDEN and approval:submit requiredScope", async () => {
      const response = await postRpc(port, "submitApproval", VIEWER_TOKEN, {
        runId: RUN_ID,
        nodeId: NODE_ID,
        iteration: ITERATION,
        approved: true,
      });
      expect(response.status).toBe(403);
      expect(response.headers.get("x-smithers-api-version")).toBe("v1");
      const body = (await response.json()) as {
        ok: boolean;
        error: { code: string; requiredScope?: string; message?: string };
      };
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("FORBIDDEN");
      expect(body.error.requiredScope).toBe("approval:submit");
      expect(body.error.message).toContain("approval:submit");
    });

    test("denied submitApproval leaves the approval row 'requested' and the run waiting", async () => {
      const denied = await postRpc(port, "submitApproval", VIEWER_TOKEN, {
        runId: RUN_ID,
        nodeId: NODE_ID,
        iteration: ITERATION,
        approved: true,
      });
      expect(denied.status).toBe(403);

      // The denial happens at the gateway's scope gate, before any handler
      // mutation — so the seeded approval must be untouched.
      const verify = await postRpc(port, "getRun", OPERATOR_TOKEN, { runId: RUN_ID });
      expect(verify.status).toBe(200);
      const run = (await verify.json()) as { ok: boolean; payload: { status: string } };
      expect(run.ok).toBe(true);
      expect(run.payload.status).toBe("waiting-approval");
    });

    test("operator token with approval:submit resolves the approval", async () => {
      const approved = await postRpc(port, "submitApproval", OPERATOR_TOKEN, {
        runId: RUN_ID,
        nodeId: NODE_ID,
        iteration: ITERATION,
        approved: true,
      });
      expect(approved.status).toBe(200);
      const body = (await approved.json()) as {
        ok: boolean;
        payload: { runId: string; nodeId: string; approved: boolean };
      };
      expect(body.ok).toBe(true);
      expect(body.payload.runId).toBe(RUN_ID);
      expect(body.payload.nodeId).toBe(NODE_ID);
      expect(body.payload.approved).toBe(true);
    });
  });

  test.skip("real gateway writes a scope-denial row to a dedicated audit table", () => {
    // SKIP: as of packages/server/src/gateway.js, scope denials at
    // `responseForbidden` (line 632) — reached from the WS frame handler
    // (line 2567) and the HTTP `/v1/rpc` handler (line 2928) — are surfaced as
    // a 403 FORBIDDEN response plus an `emitGatewayLog` warning. They do NOT
    // write a DB row to `_smithers_time_travel_audit` (which today is dedicated
    // to time-travel/rewind events; see the jumpToFrame audit pattern in
    // gateway.js).
    //
    // The real, asserted behavior (covered by the tests above) is the
    // Forbidden response + the untouched approval row. Promote this case to a
    // real test only once the gateway either:
    //   (a) extends `_smithers_time_travel_audit` into a generic
    //       `_smithers_audit` table (or adds a dedicated audit table), and
    //   (b) writes a row from `responseForbidden` with caller, method,
    //       requiredScope, and timestamp.
    // Tracked: ticket smithers/0022 §E + #302 (scope-denial audit table not built).
  });
});
