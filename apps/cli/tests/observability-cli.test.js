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
        await adapter.recordRunTokenUsage({
          runId: "inspect-shape-run",
          nodeId: "build",
          iteration: 0,
          attempt: 1,
          model: "gpt-5.6-luna",
          agent: "codex",
          inputTokens: 1_000,
          freshInputTokens: 100,
          outputTokens: 200,
          cacheReadTokens: 850,
          cacheWriteTokens: 50,
          reasoningTokens: 40,
          costUsd: 0.0004,
          updatedAtMs: Date.now(),
        });
        // Same attempt, later cumulative sample: inspect must expose the
        // replacement row rather than summing both records (#1436).
        await adapter.recordRunTokenUsage({
          runId: "inspect-shape-run",
          nodeId: "build",
          iteration: 0,
          attempt: 1,
          model: "gpt-5.6-luna",
          agent: "codex",
          inputTokens: 1_200,
          freshInputTokens: 120,
          outputTokens: 240,
          cacheReadTokens: 1_020,
          cacheWriteTokens: 60,
          reasoningTokens: 45,
          costUsd: 0.0005,
          updatedAtMs: Date.now(),
        });
        const result = runSmithers(["inspect", "inspect-shape-run", "--pool"], {
          cwd: repo.dir,
          format: "json",
          timeoutMs: TIMEOUT_MS,
        });
        expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
        expect(result.json.nodes).toEqual([expect.objectContaining({ nodeId: "build" })]);
        expect(result.json.steps).toEqual([expect.objectContaining({ id: "build" })]);
        expect(result.json.tokenUsage).toEqual({
          runId: "inspect-shape-run",
          inputTokens: 1_200,
          freshInputTokens: 120,
          outputTokens: 240,
          cacheReadTokens: 1_020,
          cacheWriteTokens: 60,
          reasoningTokens: 45,
          totalTokens: 1_440,
          costUsd: 0.0005,
          pricedAttempts: 1,
          attempts: 1,
        });
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

  test(
    "inspect distinguishes every cancellation source in JSON and human output",
    async () => {
      const repo = createTempRepo();
      const { sqlite, adapter } = openRepoDb(repo);
      try {
        const scenarios = [
          {
            runId: "inspect-cancelled-signal",
            source: {
              kind: "signal",
              detail: "worker received SIGTERM",
              signal: "SIGTERM",
              clientPid: 4321,
            },
          },
          {
            runId: "inspect-cancelled-rpc",
            source: {
              kind: "rpc",
              detail: "http cancellation request",
              clientPid: 5432,
              requestId: "rpc-request",
              clientIdentity: "user:operator",
            },
          },
          {
            runId: "inspect-cancelled-cli",
            source: {
              kind: "cli",
              detail: "smithers cancel inspect-cancelled-cli",
              clientPid: 6543,
            },
          },
          {
            runId: "inspect-cancelled-engine",
            source: {
              kind: "engine",
              detail: "task heartbeat timed out",
            },
          },
        ];

        for (const { runId, source } of scenarios) {
          await insertFinishedRun(adapter, runId);
          await adapter.updateRun(runId, {
            status: "cancelled",
            cancelRequestSource: source.kind,
            cancelRequestDetail: source.detail ?? null,
            cancelRequestSignal: source.signal ?? null,
            cancelRequestClientPid: source.clientPid ?? null,
            cancelRequestId: source.requestId ?? null,
            cancelRequestClientIdentity: source.clientIdentity ?? null,
          });

          const structured = runSmithers(["inspect", runId], {
            cwd: repo.dir,
            format: "json",
            timeoutMs: TIMEOUT_MS,
          });
          expect(structured.exitCode, `${structured.stdout}\n${structured.stderr}`).toBe(0);
          expect(structured.json.run.cancellationSource).toEqual(source);

          const human = runSmithers(["inspect", runId], {
            cwd: repo.dir,
            format: null,
            timeoutMs: TIMEOUT_MS,
          });
          expect(human.exitCode, `${human.stdout}\n${human.stderr}`).toBe(0);
          expect(human.stdout).toContain("cancellationSource:");
          expect(human.stdout).toContain(`kind: ${source.kind}`);
          expect(human.stdout).toContain(source.detail);
        }
      } finally {
        sqlite.close();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "inspect reads the degraded outcome from RunFinished instead of node rows",
    async () => {
      const repo = createTempRepo();
      const { sqlite, adapter } = openRepoDb(repo);
      try {
        await insertFinishedRun(adapter, "inspect-degraded-run");
        await adapter.insertNode({
          runId: "inspect-degraded-run",
          nodeId: "currently-clean",
          iteration: 0,
          state: "finished",
          lastAttempt: 1,
          updatedAtMs: Date.now(),
          outputTable: "",
          label: "Currently clean",
        });
        await adapter.insertEventWithNextSeq({
          runId: "inspect-degraded-run",
          timestampMs: Date.now() - 1_000,
          type: "RunFinished",
          payloadJson: JSON.stringify({
            type: "RunFinished",
            runId: "inspect-degraded-run",
            failedChildren: 2,
            failedChildKeys: ["fanout::1", "fanout::4"],
          }),
        });

        const result = runSmithers(["inspect", "inspect-degraded-run"], {
          cwd: repo.dir,
          format: "json",
          timeoutMs: TIMEOUT_MS,
        });
        expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
        expect(result.json.failedChildren).toBe(2);
        expect(result.json.failedChildKeys).toEqual(["fanout::1", "fanout::4"]);
      } finally {
        sqlite.close();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "inspect preserves degraded outcomes for continued and pre-payload finished runs",
    async () => {
      const repo = createTempRepo();
      const { sqlite, adapter } = openRepoDb(repo);
      try {
        await insertFinishedRun(adapter, "inspect-continued-run");
        await adapter.updateRun("inspect-continued-run", { status: "continued" });
        await adapter.insertEventWithNextSeq({
          runId: "inspect-continued-run",
          timestampMs: Date.now(),
          type: "RunFinished",
          payloadJson: JSON.stringify({
            failedChildren: 1,
            failedChildKeys: ["masked::3"],
          }),
        });
        const continued = runSmithers(["inspect", "inspect-continued-run"], {
          cwd: repo.dir,
          format: "json",
          timeoutMs: TIMEOUT_MS,
        });
        expect(continued.exitCode, `${continued.stdout}\n${continued.stderr}`).toBe(0);
        expect(continued.json.failedChildren).toBe(1);
        expect(continued.json.failedChildKeys).toEqual(["masked::3"]);

        await insertFinishedRun(adapter, "inspect-legacy-run");
        await adapter.insertNode({
          runId: "inspect-legacy-run",
          nodeId: "legacy-masked",
          iteration: 2,
          state: "failed",
          lastAttempt: 1,
          updatedAtMs: Date.now(),
          outputTable: "",
          label: "Legacy masked failure",
        });
        const legacy = runSmithers(["inspect", "inspect-legacy-run"], {
          cwd: repo.dir,
          format: "json",
          timeoutMs: TIMEOUT_MS,
        });
        expect(legacy.exitCode, `${legacy.stdout}\n${legacy.stderr}`).toBe(0);
        expect(legacy.json.failedChildren).toBe(1);
        expect(legacy.json.failedChildKeys).toEqual(["legacy-masked::2"]);
      } finally {
        sqlite.close();
      }
    },
    TIMEOUT_MS,
  );
});
