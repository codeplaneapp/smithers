import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "../../../packages/db/src/adapter.js";
import { ensureSmithersTables } from "../../../packages/db/src/ensure.js";
import { createTempRepo, pinSqliteBackend, runSmithers } from "../../../packages/smithers/tests/e2e-helpers.js";

const TIMEOUT_MS = 120_000;

function openRepoDb(repo) {
  pinSqliteBackend(repo.dir);
  const sqlite = new Database(repo.path("smithers.db"));
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return { sqlite, adapter: new SmithersDb(db) };
}

async function insertFinishedRun(adapter, runId) {
  const now = Date.now();
  await adapter.insertRun({
    runId,
    workflowName: "observability-fixture",
    workflowPath: "workflow.tsx",
    status: "finished",
    createdAtMs: now - 10_000,
    startedAtMs: now - 9_000,
    finishedAtMs: now - 1_000,
    heartbeatAtMs: null,
  });
}

function parseNdjson(stdout) {
  return stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe("CLI observability", () => {
  test(
    "events defaults to lifecycle history while --raw includes chunks",
    async () => {
      const repo = createTempRepo();
      const { sqlite, adapter } = openRepoDb(repo);
      try {
        await insertFinishedRun(adapter, "events-default-run");
        await adapter.insertEventWithNextSeq({
          runId: "events-default-run",
          timestampMs: Date.now() - 2_000,
          type: "NodeStarted",
          payloadJson: JSON.stringify({ nodeId: "build" }),
        });
        await adapter.insertEventWithNextSeq({
          runId: "events-default-run",
          timestampMs: Date.now() - 1_000,
          type: "AgentEvent",
          payloadJson: JSON.stringify({ nodeId: "build", event: { type: "chunk", text: "noise" } }),
        });
        const lifecycle = runSmithers(["events", "events-default-run", "--json"], {
          cwd: repo.dir,
          format: null,
          timeoutMs: TIMEOUT_MS,
        });
        expect(lifecycle.exitCode, `${lifecycle.stdout}\n${lifecycle.stderr}`).toBe(0);
        expect(parseNdjson(lifecycle.stdout).map((event) => event.type)).toEqual(["NodeStarted"]);
        const raw = runSmithers(["events", "events-default-run", "--json", "--raw"], {
          cwd: repo.dir,
          format: null,
          timeoutMs: TIMEOUT_MS,
        });
        expect(raw.exitCode, `${raw.stdout}\n${raw.stderr}`).toBe(0);
        expect(parseNdjson(raw.stdout).map((event) => event.type)).toEqual(["NodeStarted", "AgentEvent"]);
      } finally {
        sqlite.close();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "inspect JSON exposes canonical nodes and engine/model pool tally",
    async () => {
      const repo = createTempRepo();
      const { sqlite, adapter } = openRepoDb(repo);
      try {
        await insertFinishedRun(adapter, "inspect-shape-run");
        await adapter.insertNode({
          runId: "inspect-shape-run",
          nodeId: "build",
          iteration: 0,
          state: "finished",
          lastAttempt: 3,
          updatedAtMs: Date.now(),
          outputTable: "",
          label: "Build",
        });
        for (const [attempt, engine, model] of [
          [1, "codex", "gpt-5.6-luna"],
          [2, "codex", "gpt-5.6-luna"],
          [3, "claude", "claude-sonnet-5"],
        ]) {
          await adapter.insertAttempt({
            runId: "inspect-shape-run",
            nodeId: "build",
            iteration: 0,
            attempt,
            state: "finished",
            startedAtMs: Date.now() - 1_000,
            finishedAtMs: Date.now(),
            metaJson: JSON.stringify({ agentEngine: engine, agentModel: model }),
          });
        }
        const result = runSmithers(["inspect", "inspect-shape-run", "--pool"], {
          cwd: repo.dir,
          format: "json",
          timeoutMs: TIMEOUT_MS,
        });
        expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
        expect(result.json.nodes).toEqual([expect.objectContaining({ nodeId: "build" })]);
        expect(result.json.steps).toEqual([expect.objectContaining({ id: "build" })]);
        expect(result.json.pool).toEqual({
          attempts: [
            { pool: "codex/gpt-5.6-luna", attempts: 2 },
            { pool: "claude/claude-sonnet-5", attempts: 1 },
          ],
          summary: "codex/gpt-5.6-luna x2, claude/claude-sonnet-5 x1",
        });
      } finally {
        sqlite.close();
      }
    },
    TIMEOUT_MS,
  );
});
