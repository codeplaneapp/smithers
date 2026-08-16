/** @jsxImportSource smthrs */
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import { SmithersDb } from "@smthrs/db/adapter";
import { ensureSmithersTables } from "@smthrs/db/ensure";
import { CodexAgent } from "@smthrs/agents";
import { z } from "zod";
import { Task, Workflow, runWorkflow } from "smthrs";
import { EventBus } from "../src/events.js";
import { __engineInternals } from "../src/engine.js";
import { executeTaskBridge } from "../src/effect/workflow-bridge.js";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { outputSchemas } from "../../smithers/tests/schema.js";

const originalPath = process.env.PATH ?? "";
const originalGrace = process.env.SMITHERS_AGENT_WORKER_EXIT_GRACE_MS;

afterEach(() => {
  process.env.PATH = originalPath;
  if (originalGrace === undefined) delete process.env.SMITHERS_AGENT_WORKER_EXIT_GRACE_MS;
  else process.env.SMITHERS_AGENT_WORKER_EXIT_GRACE_MS = originalGrace;
});

class NoPreflightCodexAgent extends CodexAgent {
  async preflight() {}
}

/**
 * A real `codex` stand-in. In `dead` mode it leaks a detached grandchild that
 * inherits the capture pipes and then kills itself, so the worker is gone while
 * the engine's `close` event never arrives: exactly the silent worker death of
 * issue #1582. In `healthy` mode it answers normally.
 */
async function makeFakeCodex() {
  const dir = await mkdtemp(join(tmpdir(), "smithers-dead-worker-"));
  const binPath = join(dir, "codex");
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const args = process.argv.slice(2);
if (process.env.FAKE_CODEX_MODE === "dead") {
  // Inherit stdout/stderr so the engine's capture pipe stays open after this
  // process dies, the way a leaked MCP server or tool child would.
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], {
    detached: true,
    stdio: ["ignore", "inherit", "inherit"],
  });
  holder.unref();
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "thread-dead-worker" }) + "\\n");
  process.kill(process.pid, "SIGKILL");
  setTimeout(() => {}, 60000);
} else {
  const outputIndex = args.indexOf("--output-last-message");
  if (outputIndex >= 0 && args[outputIndex + 1]) {
    fs.writeFileSync(args[outputIndex + 1], JSON.stringify({ value: 7 }), "utf8");
  }
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "thread-healthy" }) + "\\n");
  process.stdout.write(
    JSON.stringify({
      type: "item.completed",
      item: { id: "assistant-1", type: "agent_message", text: JSON.stringify({ value: 7 }) },
    }) + "\\n",
  );
  process.stdout.write(JSON.stringify({ type: "turn.completed", usage: {} }) + "\\n");
}
`;
  await writeFile(binPath, script, "utf8");
  await chmod(binPath, 0o755);
  return { dir, binPath };
}

/**
 * @param {string} dir
 * @param {"dead" | "healthy"} mode
 * @param {string} id
 */
function makeCodexAgent(dir, mode, id) {
  return new NoPreflightCodexAgent({
    id,
    model: "gpt-5.4-codex",
    skipGitRepoCheck: true,
    env: {
      PATH: `${dir}:${originalPath}`,
      FAKE_CODEX_MODE: mode,
    },
  });
}

describe("dead agent worker detection (#1582)", () => {
  test("engine fails the attempt and fails over when the spawned worker dies without a result", async () => {
    const fake = await makeFakeCodex();
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers(outputSchemas);
    const adapter = new SmithersDb(db);
    try {
      process.env.PATH = `${fake.dir}:${originalPath}`;
      process.env.SMITHERS_AGENT_WORKER_EXIT_GRACE_MS = "750";

      const deadLead = makeCodexAgent(fake.dir, "dead", "codex-dead-worker");
      const healthyFallback = makeCodexAgent(fake.dir, "healthy", "codex-healthy-fallback");

      const workflow = smithers(() => (
        <Workflow name="dead-agent-worker">
          {/* No heartbeatTimeoutMs: liveness must not depend on declaring one. */}
          <Task
            id="impl"
            output={outputs.outputA}
            agent={[deadLead, healthyFallback]}
            retries={1}
            heartbeatTimeoutMs={0}
          >
            Return the required value.
          </Task>
        </Workflow>
      ));

      const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
      expect(result.status).toBe("finished");

      const attempts = await adapter.listAttempts(result.runId, "impl", 0);
      expect(attempts.length).toBeGreaterThanOrEqual(2);

      const failed = attempts.find((attempt) => attempt.state === "failed");
      expect(failed).toBeDefined();
      const error = JSON.parse(failed.errorJson ?? "{}");
      expect(error.code).toBe("AGENT_WORKER_EXITED");
      expect(error.message).toContain("exited");
      expect(error.message).toContain("without completing the attempt");
      expect(error.details?.signal ?? error.details?.exitCode).toBeDefined();
      expect(typeof error.details?.attemptRunningForMs).toBe("number");
      expect(JSON.parse(failed.metaJson ?? "{}").agentId).toBe("codex-dead-worker");

      // The failure fed the normal failover chain: the next attempt ran the
      // fallback agent and produced the output row.
      const finished = attempts.find((attempt) => attempt.state === "finished");
      expect(finished).toBeDefined();
      expect(JSON.parse(finished.metaJson ?? "{}").agentId).toBe("codex-healthy-fallback");
      expect(db.select().from(tables.outputA).all()).toEqual([expect.objectContaining({ nodeId: "impl", value: 7 })]);
    } finally {
      cleanup();
    }
  }, 60_000);

  test("workflow bridge surfaces the dead-worker failure and retries the task", async () => {
    const fake = await makeFakeCodex();
    const schema = z.object({ value: z.number() });
    const { tables, db, cleanup } = createTestSmithers({ out: schema });
    try {
      ensureSmithersTables(db);
      process.env.PATH = `${fake.dir}:${originalPath}`;
      process.env.SMITHERS_AGENT_WORKER_EXIT_GRACE_MS = "750";

      const adapter = new SmithersDb(db);
      const runId = "bridge-dead-worker";
      await adapter.insertRun({
        runId,
        workflowName: runId,
        workflowHash: "workflow-hash",
        status: "running",
        createdAtMs: Date.now(),
      });

      const desc = {
        nodeId: "bridge-agent-task",
        ordinal: 0,
        iteration: 0,
        outputTable: tables.out,
        outputTableName: tables.out._?.name ?? "out",
        outputSchema: schema,
        needsApproval: false,
        skipIf: false,
        retries: 1,
        timeoutMs: null,
        heartbeatTimeoutMs: null,
        continueOnFail: false,
        prompt: "Return the required value.",
        agent: [
          makeCodexAgent(fake.dir, "dead", "codex-dead-worker"),
          makeCodexAgent(fake.dir, "healthy", "codex-bridge-fallback"),
        ],
      };

      const eventBus = new EventBus({ db: adapter });
      const eventTypes = [];
      eventBus.on("event", (event) => {
        eventTypes.push(event.type);
      });
      await executeTaskBridge(
        adapter,
        db,
        runId,
        desc,
        new Map([[desc.nodeId, desc]]),
        null,
        eventBus,
        {
          rootDir: process.cwd(),
          allowNetwork: false,
          maxOutputBytes: 1_000_000,
          maxAgentCheckpointBytes: 1_000_000,
          toolTimeoutMs: 30_000,
        },
        runId,
        false,
        undefined,
        undefined,
        undefined,
        undefined,
        __engineInternals.legacyExecuteTask,
      );

      const attempts = await adapter.listAttempts(runId, desc.nodeId, 0);
      const failed = attempts.find((attempt) => attempt.state === "failed");
      expect(failed).toBeDefined();
      const error = JSON.parse(failed.errorJson ?? "{}");
      expect(error.code).toBe("AGENT_WORKER_EXITED");
      expect(error.message).toContain("without completing the attempt");
      // The bridge treats it as an ordinary retryable attempt failure, so the
      // node is handed back to the retry / failover chain rather than parked.
      expect(JSON.parse(failed.metaJson ?? "{}").failureRetryable).not.toBe(false);
      expect(eventTypes).toContain("NodeFailed");
      expect(eventTypes).toContain("NodeRetrying");
    } finally {
      cleanup();
    }
  }, 60_000);
});
