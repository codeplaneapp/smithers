import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import React from "react";
import { z } from "zod";
import { createSmithers } from "smithers-orchestrator";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { Gateway, type SmithersWorkflow } from "@smithers-orchestrator/server/gateway";
import { DevToolsRunStore } from "../packages/devtools/src/DevToolsRunStore.js";
import { createTempRepo, pinSqliteBackend, runSmithers } from "../packages/smithers/tests/e2e-helpers.js";

const WORKFLOW_KEY = "degraded-cross-surface";

type RpcBody = {
  ok: boolean;
  payload?: Record<string, unknown>;
  error?: { message?: string };
};

function getPort(server: { address(): unknown }): number {
  const address = server.address();
  if (!address || typeof address === "string" || typeof (address as { port?: unknown }).port !== "number") {
    throw new Error("Gateway server did not expose a port");
  }
  return (address as { port: number }).port;
}

async function rpc(port: number, method: string, params: Record<string, unknown>): Promise<RpcBody> {
  const response = await fetch(`http://127.0.0.1:${port}/v1/rpc/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  return (await response.json()) as RpcBody;
}

async function waitForFinishedRun(port: number, runId: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 10_000;
  let last: RpcBody | undefined;
  while (Date.now() < deadline) {
    last = await rpc(port, "getRun", { runId });
    if (last.ok && last.payload?.status === "finished") {
      return last.payload;
    }
    await Bun.sleep(25);
  }
  throw new Error(`Timed out waiting for ${runId}: ${JSON.stringify(last)}`);
}

function createCrossSurfaceWorkflow(dbPath: string) {
  const { smithers, Workflow, Task, outputs } = createSmithers(
    {
      input: z.object({ fail: z.boolean() }),
      result: z.object({ value: z.number() }),
    },
    { dbPath },
  );
  return smithers((ctx) =>
    React.createElement(
      Workflow,
      { name: WORKFLOW_KEY },
      React.createElement(Task, {
        id: "maybe-fail",
        output: outputs.result,
        continueOnFail: true,
        noRetry: true,
        children: () => {
          if (ctx.input.fail) {
            throw new Error("deliberate tolerated failure");
          }
          return { value: 1 };
        },
      }),
      React.createElement(Task, { id: "always-good", output: outputs.result, children: { value: 2 } }),
    ),
  );
}

describe("degraded run cross-surface contract", () => {
  test(
    "real tolerated failure satisfies ru-run-completed-but-failed across Gateway, CLI, and DevTools",
    async () => {
      const repo = createTempRepo();
      pinSqliteBackend(repo.dir);
      const workflow = createCrossSurfaceWorkflow(repo.path("smithers.db"));
      const adapter = new SmithersDb(workflow.db);
      const gateway = new Gateway({});
      gateway.register(WORKFLOW_KEY, workflow as SmithersWorkflow);
      const server = (await gateway.listen({ port: 0, host: "127.0.0.1" })) as { address(): unknown };
      const port = getPort(server);

      try {
        for (const [runId, fail] of [
          ["cross-surface-degraded", true],
          ["cross-surface-clean", false],
        ] as const) {
          const launched = await rpc(port, "launchRun", {
            workflow: WORKFLOW_KEY,
            input: { fail },
            options: { runId },
          });
          expect(launched.ok, JSON.stringify(launched.error)).toBe(true);
          const legacyRun = await waitForFinishedRun(port, runId);
          const namespacedRun = await rpc(port, "runs.get", { runId });
          expect(namespacedRun.ok).toBe(true);

          const finishedEvents = await adapter.listEventsByType(runId, "RunFinished");
          const persistedEvent = JSON.parse(String(finishedEvents.at(-1)?.payloadJson ?? "{}"));
          const devtools = new DevToolsRunStore();
          devtools.processEngineEvent(persistedEvent);

          const inspected = runSmithers(["inspect", runId], {
            cwd: repo.dir,
            format: "json",
            timeoutMs: 120_000,
          });
          expect(inspected.exitCode, `${inspected.stdout}\n${inspected.stderr}`).toBe(0);

          if (fail) {
            const degraded = {
              failedChildren: 1,
              failedChildKeys: ["maybe-fail::0"],
            };
            expect(persistedEvent).toMatchObject(degraded);
            expect(legacyRun).toMatchObject(degraded);
            expect(namespacedRun.payload).toMatchObject(degraded);
            expect(inspected.json).toMatchObject(degraded);
            expect(devtools.getRun(runId)).toMatchObject(degraded);
            expect(devtools.getRun(runId)?.tasks.size).toBe(0);
          } else {
            for (const surface of [persistedEvent, legacyRun, namespacedRun.payload, inspected.json, devtools.getRun(runId)]) {
              expect(surface).not.toHaveProperty("failedChildren");
              expect(surface).not.toHaveProperty("failedChildKeys");
            }
          }
        }

        const evalCases = readFileSync(resolve(import.meta.dir, "../evals/suites/real-usage/cases.jsonl"), "utf8")
          .trim()
          .split(/\r?\n/)
          .map((line) => JSON.parse(line))
          .filter((entry) => String(entry.id).startsWith("ru-run-completed-but-failed--"));
        expect(evalCases).toHaveLength(3);
        for (const evalCase of evalCases) {
          expect(evalCase.expected.status).toBe("finished");
          expect(evalCase.input.verify.rubric).toContain("completed status can mask failed children");
        }
        const operatorGuidance = readFileSync(resolve(import.meta.dir, "../docs/runtime/run-state.mdx"), "utf8");
        for (const requiredGuidance of [
          "Never trust top-level status alone",
          "smithers-orchestrator inspect",
          "smithers-orchestrator node",
          "smithers-orchestrator events",
          "smithers-orchestrator scores",
          "failedChildren > 0",
          "<Parallel maxConcurrency={N}>",
        ]) {
          expect(operatorGuidance).toContain(requiredGuidance);
        }
      } finally {
        await gateway.close();
      }
    },
    120_000,
  );
});
