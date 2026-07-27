import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { Effect } from "effect";
import { z } from "zod";
import { Task, Workflow, createSmithers, defineTool, runWorkflow, type AgentLike } from "smithers-orchestrator";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";

const NODE_ID = "publish-pr-comment";
const TIMEOUT_MS = 20_000;

type ToolInvocation = string | null;
type ExecutableTool = {
  execute: (args: Record<string, never>) => Promise<unknown>;
};

function makeDbPath(name: string): string {
  return join(tmpdir(), `smithers-case24-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function removeDb(dbPath: string, sqlite?: Database): void {
  sqlite?.close();
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
}

function makeTool(name: string, idempotent: boolean, keyed: boolean, invocations: ToolInvocation[]) {
  if (keyed) {
    return defineTool({
      name,
      schema: z.object({}),
      sideEffect: true,
      idempotent,
      execute: async (_args, ctx) => {
        invocations.push(ctx.idempotencyKey);
        return "ok";
      },
    });
  }

  return defineTool({
    name,
    schema: z.object({}),
    sideEffect: true,
    idempotent,
    execute: async () => {
      invocations.push(null);
      return "ok";
    },
  });
}

function makeAgent(name: string, tool: unknown): AgentLike {
  let failedOnce = false;
  return {
    id: `case24-agent-${name}`,
    tools: { [name]: tool },
    async generate() {
      await (tool as ExecutableTool).execute({});
      if (!failedOnce) {
        failedOnce = true;
        throw new Error("interrupt after side effect");
      }
      return { output: { value: 2 } };
    },
  };
}

function createReplayWorkflow(name: string, idempotent: boolean, keyed: boolean) {
  const dbPath = makeDbPath(name);
  const invocations: ToolInvocation[] = [];
  const tool = makeTool(name, idempotent, keyed, invocations);
  const agent = makeAgent(name, tool);
  const api = createSmithers(
    {
      input: z.object({}),
      result: z.object({ value: z.number() }),
    },
    { dbPath },
  );
  const workflow = api.smithers(() =>
    React.createElement(
      Workflow,
      { name: `case24-${name}` },
      React.createElement(
        Task,
        {
          id: NODE_ID,
          output: api.outputs.result,
          agent,
          retries: 1,
          retryPolicy: { backoff: "fixed", initialDelayMs: 0 },
        },
        "Publish once.",
      ),
    ),
  );
  const sqlite = (api.db as { $client?: Database }).$client;
  if (!sqlite) {
    throw new Error("createSmithers did not expose its on-disk SQLite client");
  }
  return {
    dbPath,
    sqlite,
    invocations,
    workflow,
    adapter: new SmithersDb(api.db),
  };
}

describe("case 24: real engine replay safety", () => {
  test(
    "persists ReplayUnsafeApproval and pauses before replaying an unkeyed non-idempotent tool",
    async () => {
      const fixture = createReplayWorkflow("post-pr-comment", false, false);
      try {
        const result = await Effect.runPromise(
          runWorkflow(fixture.workflow, {
            runId: "run-case24-unsafe",
            input: {},
          }),
        );

        expect(result.status).toBe("waiting-approval");
        expect(fixture.invocations).toEqual([null]);

        const approval = await Effect.runPromise(fixture.adapter.getApproval(result.runId, NODE_ID, 0));
        expect(approval?.status).toBe("requested");
        expect(JSON.parse(approval?.requestJson ?? "{}")).toMatchObject({
          kind: "ReplayUnsafeApproval",
          runId: result.runId,
          nodeId: NODE_ID,
          iteration: 0,
          offending: [
            {
              toolName: "post-pr-comment",
              attempt: 1,
              seq: 1,
            },
          ],
        });
        expect((await Effect.runPromise(fixture.adapter.getRun(result.runId)))?.status).toBe("waiting-approval");
        expect(await Effect.runPromise(fixture.adapter.listToolCalls(result.runId, NODE_ID, 0))).toHaveLength(1);
      } finally {
        removeDb(fixture.dbPath, fixture.sqlite);
      }
    },
    TIMEOUT_MS,
  );

  test.each([
    ["idempotent-write", true, false],
    ["keyed-non-idempotent-write", false, true],
  ] as const)(
    "replays %s without approval",
    async (name, idempotent, keyed) => {
      const fixture = createReplayWorkflow(name, idempotent, keyed);
      try {
        const result = await Effect.runPromise(
          runWorkflow(fixture.workflow, {
            runId: `run-case24-${name}`,
            input: {},
          }),
        );

        expect(result.status).toBe("finished");
        expect(fixture.invocations).toHaveLength(2);
        if (keyed) {
          expect(fixture.invocations[0]).toBeTruthy();
          expect(fixture.invocations[1]).toBe(fixture.invocations[0]);
        }
        expect(await Effect.runPromise(fixture.adapter.getApproval(result.runId, NODE_ID, 0))).toBeUndefined();
      } finally {
        removeDb(fixture.dbPath, fixture.sqlite);
      }
    },
    TIMEOUT_MS,
  );
});
