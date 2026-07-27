/** @jsxImportSource smithers-orchestrator */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { retryTask } from "../src/retry-task.js";
import { runWorkflow } from "../../engine/src/engine.js";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { outputSchemas } from "../../smithers/tests/schema.js";
import { Effect } from "effect";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTempRepo, pinSqliteBackend, runSmithers } from "../../smithers/tests/e2e-helpers.js";

setDefaultTimeout(120_000);
/**
 * @param {string} nodeId
 * @param {Record<string, number>} callCounts
 * @param {{ failFirst?: boolean }} [behavior]
 */
function makeAgent(nodeId, callCounts, behavior) {
  return {
    id: `agent-${nodeId}`,
    tools: {},
    async generate() {
      callCounts[nodeId] = (callCounts[nodeId] ?? 0) + 1;
      if (behavior?.failFirst && callCounts[nodeId] === 1) {
        throw new Error(`${nodeId} failed on first attempt`);
      }
      return {
        output: {
          value: callCounts[nodeId],
        },
      };
    },
  };
}
describe("retry-task e2e", () => {
  test("retry-task restarts at attempt 1 and failover rung 0", async () => {
    const { smithers, Workflow, Task, outputs, db, cleanup } = createTestSmithers(outputSchemas);
    const adapter = new SmithersDb(db);
    try {
      let recovered = false;
      let primaryCalls = 0;
      let fallbackCalls = 0;
      const primary = {
        id: "reset-primary",
        tools: {},
        async generate() {
          primaryCalls += 1;
          if (!recovered) throw new Error("primary unavailable");
          return { output: { value: 101 } };
        },
      };
      const fallback = {
        id: "reset-fallback",
        tools: {},
        async generate() {
          fallbackCalls += 1;
          throw new Error("fallback unavailable");
        },
      };
      const workflow = smithers(() => (
        <Workflow name="retry-attempt-one-rung-zero">
          <Task id="target" output={outputs.outputA} agent={[primary, fallback]} retries={2}>
            execute on the recovered primary
          </Task>
        </Workflow>
      ));
      const runId = "retry-attempt-one-rung-zero-run";

      const failed = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId }));
      expect(failed.status).toBe("failed");
      expect((await adapter.listAttempts(runId, "target", 0)).map((attempt) => attempt.attempt)).toEqual([3, 2, 1]);

      const resumeClaim = {
        claimOwnerId: "supervisor:retry-task:attempt-reset",
        claimHeartbeatAtMs: Date.now(),
      };
      const reset = await retryTask(adapter, /** @type {any} */ ({ runId, nodeId: "target", resumeClaim }));
      expect(reset.success).toBe(true);
      recovered = true;

      const resumed = await Effect.runPromise(
        runWorkflow(workflow, {
          input: {},
          runId,
          resume: true,
          resumeClaim,
        }),
      );
      expect(resumed.status).toBe("finished");
      expect(primaryCalls).toBe(2);
      expect(fallbackCalls).toBe(2);
      const attempts = await adapter.listAttempts(runId, "target", 0);
      expect(attempts.find((attempt) => attempt.state === "finished")?.attempt).toBe(1);
    } finally {
      cleanup();
    }
  });

  test("retry-task resets a failed task and resumes to completion", async () => {
    const { smithers, Workflow, Task, outputs, db, cleanup } = createTestSmithers(outputSchemas);
    const adapter = new SmithersDb(db);
    try {
      const callCounts = {};
      const workflow = smithers(() => (
        <Workflow name="retry-single-failed-task">
          <Task id="analyze" output={outputs.outputA} agent={makeAgent("analyze", callCounts)}>
            Analyze the problem.
          </Task>
          <Task
            id="implement"
            output={outputs.outputB}
            agent={makeAgent("implement", callCounts, { failFirst: true })}
            noRetry
            deps={{ analyze: outputs.outputA }}
          >
            {(deps) => `Implement using ${deps.analyze.value}`}
          </Task>
          <Task
            id="test"
            output={outputs.outputC}
            agent={makeAgent("test", callCounts)}
            deps={{ implement: outputs.outputB }}
          >
            {(deps) => `Test using ${deps.implement.value}`}
          </Task>
        </Workflow>
      ));
      const runId = "retry-single-failed-task-run";
      const failed = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId }));
      expect(failed.status).toBe("failed");
      expect(callCounts.analyze).toBe(1);
      expect(callCounts.implement).toBe(1);
      expect(callCounts.test ?? 0).toBe(0);
      const reset = await retryTask(adapter, { runId, nodeId: "implement" });
      expect(reset.success).toBe(true);
      expect(reset.resetNodes).toContain("implement");
      const resumed = await Effect.runPromise(
        runWorkflow(workflow, {
          input: {},
          runId,
          resume: true,
        }),
      );
      expect(resumed.status).toBe("finished");
      expect(callCounts.analyze).toBe(1);
      expect(callCounts.implement).toBe(2);
      expect(callCounts.test).toBe(1);
    } finally {
      cleanup();
    }
  });
  test("retry-task resets dependents by default", async () => {
    const { smithers, Workflow, Task, outputs, db, cleanup } = createTestSmithers(outputSchemas);
    const adapter = new SmithersDb(db);
    try {
      const callCounts = {};
      const workflow = smithers(() => (
        <Workflow name="retry-reset-dependents">
          <Task id="A" output={outputs.outputA} agent={makeAgent("A", callCounts)}>
            First
          </Task>
          <Task id="B" output={outputs.outputB} agent={makeAgent("B", callCounts)} deps={{ A: outputs.outputA }}>
            {(deps) => `Second ${deps.A.value}`}
          </Task>
          <Task id="C" output={outputs.outputC} agent={makeAgent("C", callCounts)} deps={{ B: outputs.outputB }}>
            {(deps) => `Third ${deps.B.value}`}
          </Task>
        </Workflow>
      ));
      const runId = "retry-reset-dependents-run";
      const finished = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId }));
      expect(finished.status).toBe("finished");
      expect(callCounts).toMatchObject({ A: 1, B: 1, C: 1 });
      const reset = await retryTask(adapter, { runId, nodeId: "A" });
      expect(reset.success).toBe(true);
      expect([...reset.resetNodes].sort()).toEqual(["A", "B", "C"]);
      const nodeA = await adapter.getNode(runId, "A", 0);
      const nodeB = await adapter.getNode(runId, "B", 0);
      const nodeC = await adapter.getNode(runId, "C", 0);
      expect(nodeA?.state).toBe("pending");
      expect(nodeB?.state).toBe("pending");
      expect(nodeC?.state).toBe("pending");
      const resumed = await Effect.runPromise(
        runWorkflow(workflow, {
          input: {},
          runId,
          resume: true,
        }),
      );
      expect(resumed.status).toBe("finished");
      expect(callCounts).toMatchObject({ A: 2, B: 2, C: 2 });
    } finally {
      cleanup();
    }
  });
  test("retry-task with noDeps only resets the target", async () => {
    const { smithers, Workflow, Task, outputs, db, cleanup } = createTestSmithers(outputSchemas);
    const adapter = new SmithersDb(db);
    try {
      const callCounts = {};
      const workflow = smithers(() => (
        <Workflow name="retry-no-deps">
          <Task id="A" output={outputs.outputA} agent={makeAgent("A", callCounts)}>
            First
          </Task>
          <Task id="B" output={outputs.outputB} agent={makeAgent("B", callCounts)} deps={{ A: outputs.outputA }}>
            {(deps) => `Second ${deps.A.value}`}
          </Task>
          <Task id="C" output={outputs.outputC} agent={makeAgent("C", callCounts)} deps={{ B: outputs.outputB }}>
            {(deps) => `Third ${deps.B.value}`}
          </Task>
        </Workflow>
      ));
      const runId = "retry-no-deps-run";
      const finished = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId }));
      expect(finished.status).toBe("finished");
      expect(callCounts).toMatchObject({ A: 1, B: 1, C: 1 });
      const reset = await retryTask(adapter, {
        runId,
        nodeId: "B",
        resetDependents: false,
      });
      expect(reset.success).toBe(true);
      expect(reset.resetNodes).toEqual(["B"]);
      const nodeA = await adapter.getNode(runId, "A", 0);
      const nodeB = await adapter.getNode(runId, "B", 0);
      const nodeC = await adapter.getNode(runId, "C", 0);
      expect(nodeA?.state).toBe("finished");
      expect(nodeB?.state).toBe("pending");
      expect(nodeC?.state).toBe("finished");
      const resumed = await Effect.runPromise(
        runWorkflow(workflow, {
          input: {},
          runId,
          resume: true,
        }),
      );
      expect(resumed.status).toBe("finished");
      expect(callCounts).toMatchObject({ A: 1, B: 2, C: 1 });
    } finally {
      cleanup();
    }
  });
  test("retry-task errors on non-existent node", async () => {
    const { smithers, Workflow, Task, outputs, db, cleanup } = createTestSmithers(outputSchemas);
    const adapter = new SmithersDb(db);
    try {
      const workflow = smithers(() => (
        <Workflow name="retry-missing-node">
          <Task id="existing" output={outputs.outputA}>
            {{ value: 1 }}
          </Task>
        </Workflow>
      ));
      const runId = "retry-missing-node-run";
      const finished = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId }));
      expect(finished.status).toBe("finished");
      const reset = await retryTask(adapter, {
        runId,
        nodeId: "nonexistent",
      });
      expect(reset.success).toBe(false);
      expect(reset.error).toContain("not found");
    } finally {
      cleanup();
    }
  });
  test("retry-task errors on active workflow unless force", async () => {
    const { smithers, Workflow, Task, outputs, db, cleanup } = createTestSmithers(outputSchemas);
    const adapter = new SmithersDb(db);
    try {
      const workflow = smithers(() => (
        <Workflow name="retry-running-run">
          <Task id="existing" output={outputs.outputA}>
            {{ value: 1 }}
          </Task>
        </Workflow>
      ));
      const runId = "retry-running-run-id";
      const finished = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId }));
      expect(finished.status).toBe("finished");
      for (const status of ["running", "waiting-approval", "waiting-event", "waiting-timer", "waiting-quota"]) {
        await adapter.updateRun(runId, { status, finishedAtMs: null });
        const blocked = await retryTask(adapter, {
          runId,
          nodeId: "existing",
        });
        expect(blocked.success).toBe(false);
        expect(blocked.error).toContain("running");
      }
      const forced = await retryTask(adapter, {
        runId,
        nodeId: "existing",
        force: true,
      });
      expect(forced.success).toBe(true);
      expect(forced.resetNodes).toEqual(["existing"]);
    } finally {
      cleanup();
    }
  });
  test("retry-task preserves state when durable workflow metadata changed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "smithers-retry-task-"));
    const workflowPath = join(dir, "workflow.jsx");
    await writeFile(workflowPath, "export const version = 1;\n");
    const { smithers, Workflow, Task, outputs, db, cleanup } = createTestSmithers(outputSchemas);
    const adapter = new SmithersDb(db);
    try {
      const workflow = smithers(() => (
        <Workflow name="retry-metadata-mismatch">
          <Task id="target" output={outputs.outputA}>
            {{ value: 1 }}
          </Task>
        </Workflow>
      ));
      const runId = "retry-metadata-mismatch-run";
      const finished = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId, workflowPath }));
      expect(finished.status).toBe("finished");
      await writeFile(workflowPath, "export const version = 2;\n");

      const reset = await retryTask(adapter, { runId, nodeId: "target" });

      expect(reset.success).toBe(false);
      expect(reset.error).toContain("durable workflow metadata");
      expect((await adapter.getRun(runId))?.status).toBe("finished");
      expect((await adapter.getNode(runId, "target", 0))?.state).toBe("finished");
      expect(await adapter.getRawNodeOutput("output_a", runId, "target")).toMatchObject({ value: 1 });
    } finally {
      cleanup();
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("retry-task leaves a durable, supervisor-recoverable claim across the relaunch window", async () => {
    const { smithers, Workflow, Task, outputs, db, cleanup } = createTestSmithers(outputSchemas);
    const adapter = new SmithersDb(db);
    try {
      const workflow = smithers(() => (
        <Workflow name="retry-durable-claim">
          <Task id="target" output={outputs.outputA}>
            {{ value: 1 }}
          </Task>
        </Workflow>
      ));
      const runId = "retry-durable-claim-run";
      const finished = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId }));
      expect(finished.status).toBe("finished");
      const resumeClaim = {
        claimOwnerId: "supervisor:retry-task:crash-window",
        claimHeartbeatAtMs: 10,
      };

      const reset = await retryTask(adapter, /** @type {any} */ ({ runId, nodeId: "target", resumeClaim }));

      expect(reset.success).toBe(true);
      expect(await adapter.getRun(runId)).toMatchObject({
        status: "running",
        runtimeOwnerId: resumeClaim.claimOwnerId,
        heartbeatAtMs: resumeClaim.claimHeartbeatAtMs,
      });
      expect((await adapter.getNode(runId, "target", 0))?.state).toBe("pending");
      expect((await adapter.listStaleRunningRuns(11)).map((run) => run.runId)).toContain(runId);
      expect(
        await Effect.runPromise(
          adapter.claimRunForResume({
            runId,
            expectedRuntimeOwnerId: resumeClaim.claimOwnerId,
            expectedHeartbeatAtMs: resumeClaim.claimHeartbeatAtMs,
            staleBeforeMs: 11,
            claimOwnerId: "supervisor:test:1",
            claimHeartbeatAtMs: 20,
          }),
        ),
      ).toBe(true);
    } finally {
      cleanup();
    }
  });
  test("CLI retry-task rolls back a reset when resume fails before ownership", () => {
    const repo = createTempRepo();
    pinSqliteBackend(repo.dir);
    repo.write(
      "workflow.tsx",
      `/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod";

const { smithers, Workflow, Task, outputs } = createSmithers({
  input: z.object({ token: z.string() }),
  result: z.object({ value: z.number() }),
});

export default smithers(() => (
  <Workflow name="retry-rollback">
    <Task id="target" output={outputs.result}>{{ value: 1 }}</Task>
  </Workflow>
));
`,
    );
    const runId = "retry-cli-pre-ownership-failure";
    const initial = runSmithers(
      ["up", "workflow.tsx", "--run-id", runId, "--input", JSON.stringify({ token: "seed" })],
      {
        cwd: repo.dir,
        format: "json",
        timeoutMs: 90_000,
      },
    );
    expect(initial.exitCode, `${initial.stdout}\n${initial.stderr}`).toBe(0);

    const sqlite = new Database(repo.path("smithers.db"));
    try {
      sqlite.query("DELETE FROM input WHERE run_id = ?").run(runId);
      sqlite.exec(
        "CREATE TRIGGER block_retry_input_restore BEFORE INSERT ON input BEGIN SELECT RAISE(ABORT, 'injected missing durable input'); END",
      );
      const snapshot = {
        run: sqlite.query("SELECT * FROM _smithers_runs WHERE run_id = ?").get(runId),
        nodes: sqlite.query("SELECT * FROM _smithers_nodes WHERE run_id = ? ORDER BY node_id, iteration").all(runId),
        attempts: sqlite
          .query("SELECT * FROM _smithers_attempts WHERE run_id = ? ORDER BY node_id, iteration, attempt")
          .all(runId),
        outputs: sqlite.query("SELECT * FROM result WHERE run_id = ? ORDER BY node_id, iteration").all(runId),
      };
      sqlite.close();

      const retried = runSmithers(["retry-task", "workflow.tsx", "--run-id", runId, "--node-id", "target"], {
        cwd: repo.dir,
        format: "json",
        timeoutMs: 90_000,
      });
      expect(retried.exitCode, `${retried.stdout}\n${retried.stderr}`).toBe(1);
      expect(retried.stderr).toContain("retry reset finished");

      const check = new Database(repo.path("smithers.db"), { readonly: true });
      try {
        expect(check.query("SELECT * FROM _smithers_runs WHERE run_id = ?").get(runId)).toEqual(snapshot.run);
        expect(
          check.query("SELECT * FROM _smithers_nodes WHERE run_id = ? ORDER BY node_id, iteration").all(runId),
        ).toEqual(snapshot.nodes);
        expect(
          check
            .query("SELECT * FROM _smithers_attempts WHERE run_id = ? ORDER BY node_id, iteration, attempt")
            .all(runId),
        ).toEqual(snapshot.attempts);
        expect(check.query("SELECT * FROM result WHERE run_id = ? ORDER BY node_id, iteration").all(runId)).toEqual(
          snapshot.outputs,
        );
      } finally {
        check.close();
      }
    } finally {
      if (sqlite.open) sqlite.close();
    }
  });
  test("CLI retry-task does not roll back over a newer resume owner", () => {
    const repo = createTempRepo();
    pinSqliteBackend(repo.dir);
    repo.write(
      "workflow.tsx",
      `/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod";

const { smithers, Workflow, Task, outputs } = createSmithers({
  input: z.object({}),
  result: z.object({ value: z.number() }),
});

export default smithers(() => (
  <Workflow name="retry-owner-race">
    <Task id="target" output={outputs.result}>{{ value: 1 }}</Task>
  </Workflow>
));
`,
    );
    const runId = "retry-cli-owner-race";
    const initial = runSmithers(["up", "workflow.tsx", "--run-id", runId], {
      cwd: repo.dir,
      format: "json",
      timeoutMs: 90_000,
    });
    expect(initial.exitCode, `${initial.stdout}\n${initial.stderr}`).toBe(0);

    const sqlite = new Database(repo.path("smithers.db"));
    try {
      sqlite.exec(`
        CREATE TRIGGER steal_retry_resume_claim
        AFTER UPDATE OF runtime_owner_id ON _smithers_runs
        WHEN NEW.run_id = '${runId}'
          AND NEW.runtime_owner_id LIKE 'supervisor:retry-task:%'
        BEGIN
          UPDATE _smithers_runs
          SET runtime_owner_id = 'supervisor:race:1',
              heartbeat_at_ms = NEW.heartbeat_at_ms + 1
          WHERE run_id = NEW.run_id;
        END
      `);
      sqlite.close();

      const retried = runSmithers(["retry-task", "workflow.tsx", "--run-id", runId, "--node-id", "target"], {
        cwd: repo.dir,
        format: "json",
        timeoutMs: 90_000,
      });
      expect(retried.exitCode, `${retried.stdout}\n${retried.stderr}`).toBe(1);

      const check = new Database(repo.path("smithers.db"), { readonly: true });
      try {
        expect(check.query("SELECT runtime_owner_id FROM _smithers_runs WHERE run_id = ?").get(runId)).toEqual({
          runtime_owner_id: "supervisor:race:1",
        });
        expect(
          check.query("SELECT state FROM _smithers_nodes WHERE run_id = ? AND node_id = ?").get(runId, "target"),
        ).toEqual({ state: "pending" });
        expect(check.query("SELECT * FROM result WHERE run_id = ?").all(runId)).toEqual([]);
      } finally {
        check.close();
      }
    } finally {
      if (sqlite.open) sqlite.close();
    }
  });
});
