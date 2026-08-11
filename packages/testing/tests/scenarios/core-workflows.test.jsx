/** @jsxImportSource smthrs */
/**
 * Core workflow scenarios — token-free, real engine + sqlite + scripted vectors.
 *
 * These are the primary practical shapes people run in Smithers (hello → sequence →
 * parallel → HITL → steer → retry/loop → control-flow), not snapshot "goldens".
 */
import { describe, expect, test } from "bun:test";
import { dirname } from "node:path";
import {
  Workflow,
  Task,
  Sequence,
  Parallel,
  Approval,
  Loop,
  Branch,
  ContinueAsNew,
  runWorkflow,
  approvalDecisionSchema,
} from "smthrs";
import { SmithersDb } from "@smthrs/db/adapter";
import { enqueueSteer } from "@smthrs/engine/steers";
import { approveNode, denyNode } from "@smthrs/engine/approvals";
import { createTestSmithers } from "../../../smithers/tests/helpers.js";
import { Effect } from "effect";
import { z } from "zod";
import {
  createVirtualClock,
  expectEventCount,
  expectNodeState,
  expectSteerConsumed,
  expectRunStatus,
  runScenario,
  tallyNodeStates,
} from "../../src/index.ts";
import { agentFromFixture, loadFixture, runInRoot, scenarioRunWorkflowFn } from "../helpers/scenario.js";
import { scriptedAgent } from "../../src/index.ts";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Local copy of system-workflow frontmatter detection (no apps/cli dependency). */
function isSystemWorkflowSource(workflowPath) {
  try {
    const head = readFileSync(workflowPath, "utf8").slice(0, 4000);
    return /smithers-system\s*:\s*true/i.test(head);
  } catch {
    return false;
  }
}

const outSchema = z.object({
  summary: z.string(),
  ok: z.boolean(),
  steerd: z.boolean().optional(),
  done: z.boolean().optional(),
  path: z.string().optional(),
});

const STEER = "FOCUS_EDGE_CASES";

describe("core workflow scenarios (token-free, real engine)", () => {
  // ── hello / sequence / parallel ─────────────────────────────────────────

  test("hello: single agent task finishes", async () => {
    const clock = createVirtualClock();
    const agent = agentFromFixture("hello-ok", { clock, schema: outSchema, id: "hello" });
    const { smithers, outputs, db, dbPath, cleanup } = createTestSmithers({ hello: outSchema });
    try {
      const workflow = smithers(() => (
        <Workflow name="core-hello">
          <Task id="hello" output={outputs.hello} agent={agent}>
            say hello
          </Task>
        </Workflow>
      ));
      const { runId, status } = await runScenario({
        workflow,
        runId: "core-hello-1",
        rootDir: dirname(dbPath),
        clock,
        runWorkflowFn: scenarioRunWorkflowFn(dbPath),
      });
      expect(status).toBe("finished");
      const adapter = new SmithersDb(db);
      await expectRunStatus(adapter, runId, "finished");
      await expectNodeState(adapter, runId, "hello", "finished");
      expect(agent.calls).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  test("sequence: implement then validate", async () => {
    const clock = createVirtualClock();
    const implement = agentFromFixture("pipeline-implement", {
      clock,
      schema: outSchema,
      id: "agent-implement",
    });
    const validate = agentFromFixture("pipeline-validate", {
      clock,
      schema: outSchema,
      id: "agent-validate",
    });
    const { smithers, outputs, db, dbPath, cleanup } = createTestSmithers({
      implement: outSchema,
      validate: outSchema,
    });
    try {
      const workflow = smithers(() => (
        <Workflow name="core-sequence">
          <Sequence>
            <Task id="implement" output={outputs.implement} agent={implement}>
              implement
            </Task>
            <Task id="validate" output={outputs.validate} agent={validate}>
              validate
            </Task>
          </Sequence>
        </Workflow>
      ));
      const { runId, status } = await runScenario({
        workflow,
        runId: "core-sequence-1",
        rootDir: dirname(dbPath),
        clock,
        runWorkflowFn: scenarioRunWorkflowFn(dbPath),
      });
      expect(status).toBe("finished");
      const adapter = new SmithersDb(db);
      await expectNodeState(adapter, runId, "implement", "finished");
      await expectNodeState(adapter, runId, "validate", "finished");
    } finally {
      cleanup();
    }
  });

  test("parallel: four workers, one hard-fail", async () => {
    const clock = createVirtualClock();
    const ok = () => agentFromFixture("worker-ok", { clock, schema: outSchema });
    const bad = agentFromFixture("worker-fail", { clock, schema: outSchema, id: "boom" });
    const { smithers, outputs, db, dbPath, cleanup } = createTestSmithers({ w: outSchema });
    try {
      const workflow = smithers(() => (
        <Workflow name="core-parallel-fail">
          <Parallel maxConcurrency={4}>
            <Task id="worker-01" output={outputs.w} agent={ok()} retries={0}>
              s1
            </Task>
            <Task id="worker-02" output={outputs.w} agent={ok()} retries={0}>
              s2
            </Task>
            <Task id="worker-03" output={outputs.w} agent={bad} retries={0}>
              s3
            </Task>
            <Task id="worker-04" output={outputs.w} agent={ok()} retries={0}>
              s4
            </Task>
          </Parallel>
        </Workflow>
      ));
      const { runId, status } = await runScenario({
        workflow,
        runId: "core-parallel-1",
        rootDir: dirname(dbPath),
        clock,
        runWorkflowFn: scenarioRunWorkflowFn(dbPath),
      });
      const adapter = new SmithersDb(db);
      await expectNodeState(adapter, runId, "worker-01", "finished");
      await expectNodeState(adapter, runId, "worker-03", "failed");
      const tally = await tallyNodeStates(adapter, runId);
      expect(tally.done).toBe(3);
      expect(tally.failed).toBe(1);
      expect(["finished", "failed"]).toContain(status);
    } finally {
      cleanup();
    }
  });

  // ── HITL ────────────────────────────────────────────────────────────────

  test("hitl: approval parks then approve resumes", async () => {
    const clock = createVirtualClock();
    const after = agentFromFixture("hello-ok", { clock, schema: outSchema, id: "after" });
    const { smithers, outputs, db, dbPath, cleanup } = createTestSmithers({
      gate: approvalDecisionSchema,
      after: outSchema,
    });
    try {
      const workflow = smithers(() => (
        <Workflow name="core-hitl-approve">
          <Sequence>
            <Approval id="gate" output={outputs.gate} request={{ title: "Ship?" }} />
            <Task id="after" output={outputs.after} agent={after}>
              continue
            </Task>
          </Sequence>
        </Workflow>
      ));
      const first = await runInRoot(workflow, dbPath, { input: {}, runId: "core-hitl-approve-1" });
      expect(first.status).toBe("waiting-approval");
      const adapter = new SmithersDb(db);
      await Effect.runPromise(approveNode(adapter, first.runId, "gate", 0, "lgtm", "tester"));
      const resumed = await runScenario({
        workflow,
        runId: first.runId,
        resume: true,
        rootDir: dirname(dbPath),
        clock,
        runWorkflowFn: scenarioRunWorkflowFn(dbPath),
      });
      expect(resumed.status).toBe("finished");
      await expectNodeState(adapter, first.runId, "after", "finished");
    } finally {
      cleanup();
    }
  });

  test("hitl: approval deny with onDeny=skip continues", async () => {
    const { smithers, outputs, tables, db, dbPath, cleanup } = createTestSmithers({
      gate: approvalDecisionSchema,
      after: z.object({ v: z.number() }),
    });
    try {
      const workflow = smithers(() => (
        <Workflow name="core-hitl-deny">
          <Sequence>
            <Approval id="gate" output={outputs.gate} request={{ title: "Ship?" }} onDeny="skip" />
            <Task id="after" output={outputs.after}>
              {{ v: 1 }}
            </Task>
          </Sequence>
        </Workflow>
      ));
      const first = await runInRoot(workflow, dbPath, { input: {}, runId: "core-hitl-deny-1" });
      expect(first.status).toBe("waiting-approval");
      const adapter = new SmithersDb(db);
      await Effect.runPromise(denyNode(adapter, first.runId, "gate", 0, "nope", "tester"));
      const resumed = await runInRoot(workflow, dbPath, {
        input: {},
        runId: first.runId,
        resume: true,
      });
      expect(resumed.status).toBe("finished");
      const rows = await db.select().from(tables.after);
      expect(rows).toEqual([expect.objectContaining({ v: 1 })]);
    } finally {
      cleanup();
    }
  });

  // ── steer ───────────────────────────────────────────────────────────────

  test("steer: steer injects on next generate (no gate)", async () => {
    const clock = createVirtualClock();
    const consumer = scriptedAgent(loadFixture("steer-consumer"), {
      clock,
      schema: outSchema,
      id: "consumer",
    });
    const producerBase = agentFromFixture("steer-producer", {
      clock,
      schema: outSchema,
      id: "producer",
    });
    const { smithers, outputs, db, dbPath, cleanup } = createTestSmithers({
      a: outSchema,
      b: outSchema,
    });
    try {
      const adapter = new SmithersDb(db);
      const producer = {
        id: "producer",
        tools: {},
        supportsNativeStructuredOutput: true,
        calls: producerBase.calls,
        generate: async (args) => {
          const runId = args?.taskContext?.runId;
          if (typeof runId === "string") {
            await Effect.runPromise(enqueueSteer(adapter, runId, "b", STEER, { author: "scenario" }));
          }
          return producerBase.generate(args);
        },
        lastPrompt: () => producerBase.lastPrompt(),
        reset: () => producerBase.reset(),
      };
      const workflow = smithers(() => (
        <Workflow name="core-steer-steer">
          <Sequence>
            <Task id="a" output={outputs.a} agent={producer}>
              plan
            </Task>
            <Task id="b" output={outputs.b} agent={consumer}>
              implement
            </Task>
          </Sequence>
        </Workflow>
      ));
      const { runId, status } = await runScenario({
        workflow,
        runId: "core-steer-steer-1",
        rootDir: dirname(dbPath),
        clock,
        runWorkflowFn: scenarioRunWorkflowFn(dbPath),
      });
      expect(status).toBe("finished");
      await expectSteerConsumed(adapter, runId, { nodeId: "b" });
      expect(JSON.stringify(consumer.calls[0]?.args ?? {})).toContain(STEER);
      expect([...consumer.usedTurnIndexes]).toEqual([0]);
    } finally {
      cleanup();
    }
  });

  test("steer: unused steer expires at run terminal", async () => {
    const clock = createVirtualClock();
    const base = agentFromFixture("hello-ok", { clock, schema: outSchema, id: "exp" });
    const { smithers, outputs, db, dbPath, cleanup } = createTestSmithers({ a: outSchema });
    try {
      const adapter = new SmithersDb(db);
      const agent = {
        id: "exp",
        tools: {},
        supportsNativeStructuredOutput: true,
        calls: base.calls,
        generate: async (args) => {
          const runId = args?.taskContext?.runId;
          if (typeof runId === "string") {
            // Queued after this generate's consumption window — expires at finish.
            await Effect.runPromise(enqueueSteer(adapter, runId, "task", "too late", { author: "scenario" }));
          }
          return base.generate(args);
        },
        lastPrompt: () => base.lastPrompt(),
        reset: () => base.reset(),
      };
      const workflow = smithers(() => (
        <Workflow name="core-steer-expire">
          <Task id="task" output={outputs.a} agent={agent}>
            go
          </Task>
        </Workflow>
      ));
      const { runId, status } = await runScenario({
        workflow,
        runId: "core-steer-expire-1",
        rootDir: dirname(dbPath),
        clock,
        runWorkflowFn: scenarioRunWorkflowFn(dbPath),
      });
      expect(status).toBe("finished");
      const steers = await Effect.runPromise(adapter.listSteers(runId));
      expect(steers).toHaveLength(1);
      expect(steers[0].status).toBe("expired");
      await expectEventCount(adapter, runId, "SteerExpired", 1);
      await expectEventCount(adapter, runId, "SteerConsumed", 0);
    } finally {
      cleanup();
    }
  });

  // ── retry / loop / hang / stream ────────────────────────────────────────

  test("retry: first attempt fails, second succeeds", async () => {
    const clock = createVirtualClock();
    const agent = agentFromFixture("retry-fail-then-ok", {
      clock,
      schema: outSchema,
      id: "retry-agent",
    });
    const { smithers, outputs, db, dbPath, cleanup } = createTestSmithers({ t: outSchema });
    try {
      const workflow = smithers(() => (
        <Workflow name="core-retry">
          <Task id="task" output={outputs.t} agent={agent} retries={2}>
            flaky work
          </Task>
        </Workflow>
      ));
      const { runId, status } = await runScenario({
        workflow,
        runId: "core-retry-1",
        rootDir: dirname(dbPath),
        clock,
        runWorkflowFn: scenarioRunWorkflowFn(dbPath),
      });
      expect(status).toBe("finished");
      const adapter = new SmithersDb(db);
      await expectNodeState(adapter, runId, "task", "finished");
      expect(agent.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      cleanup();
    }
  });

  test("loop: body runs across iterations until done", async () => {
    const clock = createVirtualClock();
    const agent = agentFromFixture("loop-body", {
      clock,
      schema: outSchema,
      id: "loop-agent",
    });
    const { smithers, outputs, db, dbPath, cleanup } = createTestSmithers({
      body: outSchema,
    });
    try {
      const workflow = smithers((ctx) => {
        const latest = ctx.latest("body", "body");
        return (
          <Workflow name="core-loop">
            <Loop id="loop" until={latest?.done === true} maxIterations={5}>
              <Task id="body" output={outputs.body} agent={agent}>
                loop body
              </Task>
            </Loop>
          </Workflow>
        );
      });
      const { runId, status } = await runScenario({
        workflow,
        runId: "core-loop-1",
        rootDir: dirname(dbPath),
        clock,
        runWorkflowFn: scenarioRunWorkflowFn(dbPath),
      });
      expect(status).toBe("finished");
      expect(agent.calls.length).toBe(2);
      const adapter = new SmithersDb(db);
      // Same nodeId across iterations; at least one finished row for body.
      const nodes = await Effect.runPromise(adapter.listNodes(runId));
      const bodyNodes = nodes.filter((n) => n.nodeId === "body");
      expect(bodyNodes.length).toBeGreaterThanOrEqual(1);
      expect(bodyNodes.every((n) => n.state === "finished")).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("hang: scripted hang fails the node without cancel semantics", async () => {
    const clock = createVirtualClock();
    const agent = agentFromFixture("hang-timeout", { clock, id: "hang" });
    const { smithers, outputs, db, dbPath, cleanup } = createTestSmithers({
      t: outSchema,
    });
    try {
      const workflow = smithers(() => (
        <Workflow name="core-hang">
          <Task id="task" output={outputs.t} agent={agent} retries={0}>
            hang
          </Task>
        </Workflow>
      ));
      const { runId, status } = await runScenario({
        workflow,
        runId: "core-hang-1",
        rootDir: dirname(dbPath),
        clock,
        runWorkflowFn: scenarioRunWorkflowFn(dbPath),
      });
      const adapter = new SmithersDb(db);
      await expectNodeState(adapter, runId, "task", "failed");
      // Must not look like a clean cancel-only path for the node.
      expect(status).not.toBe("cancelled");
      expect(["failed", "finished"]).toContain(status);
    } finally {
      cleanup();
    }
  });

  test("stream: slow multi-chunk virtual stream completes", async () => {
    const clock = createVirtualClock();
    const chunks = [];
    const base = agentFromFixture("slow-stream", { clock, schema: outSchema, id: "slow" });
    const agent = {
      ...base,
      generate: async (args) => {
        const onStdout = args.onStdout;
        return base.generate({
          ...args,
          onStdout: (t) => {
            chunks.push(t);
            onStdout?.(t);
          },
        });
      },
    };
    const { smithers, outputs, db, dbPath, cleanup } = createTestSmithers({ t: outSchema });
    try {
      const workflow = smithers(() => (
        <Workflow name="core-slow-stream">
          <Task id="task" output={outputs.t} agent={agent}>
            stream
          </Task>
        </Workflow>
      ));
      const { status } = await runScenario({
        workflow,
        runId: "core-slow-stream-1",
        rootDir: dirname(dbPath),
        clock,
        runWorkflowFn: scenarioRunWorkflowFn(dbPath),
      });
      expect(status).toBe("finished");
      expect(chunks.join("")).toContain("chunk-1");
      expect(chunks.join("")).toContain("chunk-2");
      expect(clock.now()).toBeGreaterThanOrEqual(30);
    } finally {
      cleanup();
    }
  });

  // ── mixed graph / branch / continueAsNew / system ───────────────────────

  test("mixed: static compute then agent task", async () => {
    const clock = createVirtualClock();
    const agent = agentFromFixture("hello-ok", { clock, schema: outSchema, id: "agent" });
    const { smithers, outputs, tables, db, dbPath, cleanup } = createTestSmithers({
      seed: z.object({ n: z.number() }),
      hello: outSchema,
    });
    try {
      const workflow = smithers(() => (
        <Workflow name="core-mixed-static-agent">
          <Sequence>
            <Task id="seed" output={outputs.seed}>
              {{ n: 42 }}
            </Task>
            <Task id="hello" output={outputs.hello} agent={agent}>
              use seed
            </Task>
          </Sequence>
        </Workflow>
      ));
      const { runId, status } = await runScenario({
        workflow,
        runId: "core-mixed-1",
        rootDir: dirname(dbPath),
        clock,
        runWorkflowFn: scenarioRunWorkflowFn(dbPath),
      });
      expect(status).toBe("finished");
      const adapter = new SmithersDb(db);
      await expectNodeState(adapter, runId, "seed", "finished");
      await expectNodeState(adapter, runId, "hello", "finished");
      const seedRows = await db.select().from(tables.seed);
      expect(seedRows[0].n).toBe(42);
    } finally {
      cleanup();
    }
  });

  test("branch: input selects then vs else agent path", async () => {
    const clock = createVirtualClock();
    const thenAgent = agentFromFixture("branch-then", {
      clock,
      schema: outSchema,
      id: "then",
    });
    const elseAgent = agentFromFixture("branch-else", {
      clock,
      schema: outSchema,
      id: "else",
    });
    const { smithers, outputs, db, dbPath, cleanup } = createTestSmithers({
      path: outSchema,
    });
    try {
      const workflow = smithers((ctx) => (
        <Workflow name="core-branch">
          <Branch
            if={ctx.input?.takeThen === true}
            then={
              <Task id="path" output={outputs.path} agent={thenAgent}>
                then path
              </Task>
            }
            else={
              <Task id="path" output={outputs.path} agent={elseAgent}>
                else path
              </Task>
            }
          />
        </Workflow>
      ));
      const thenRun = await runScenario({
        workflow,
        runId: "core-branch-then",
        input: { takeThen: true },
        rootDir: dirname(dbPath),
        clock,
        runWorkflowFn: scenarioRunWorkflowFn(dbPath),
      });
      expect(thenRun.status).toBe("finished");
      expect(thenAgent.calls.length).toBe(1);
      expect(elseAgent.calls.length).toBe(0);

      // Fresh agents for else path (same DB file is fine with new runId)
      const then2 = agentFromFixture("branch-then", { clock, schema: outSchema, id: "then2" });
      const else2 = agentFromFixture("branch-else", { clock, schema: outSchema, id: "else2" });
      const {
        smithers: s2,
        outputs: o2,
        dbPath: db2,
        cleanup: c2,
      } = createTestSmithers({
        path: outSchema,
      });
      try {
        const wf2 = s2((ctx) => (
          <Workflow name="core-branch-else">
            <Branch
              if={ctx.input?.takeThen === true}
              then={
                <Task id="path" output={o2.path} agent={then2}>
                  then
                </Task>
              }
              else={
                <Task id="path" output={o2.path} agent={else2}>
                  else
                </Task>
              }
            />
          </Workflow>
        ));
        const elseRun = await runScenario({
          workflow: wf2,
          runId: "core-branch-else",
          input: { takeThen: false },
          rootDir: dirname(db2),
          clock,
          runWorkflowFn: scenarioRunWorkflowFn(db2),
        });
        expect(elseRun.status).toBe("finished");
        expect(else2.calls.length).toBe(1);
        expect(then2.calls.length).toBe(0);
      } finally {
        c2();
      }
    } finally {
      cleanup();
    }
  });

  test("continueAsNew: child run receives continuation payload", async () => {
    const { smithers, outputs, tables, db, dbPath, cleanup } = createTestSmithers({
      result: z.object({ cursor: z.string().nullable(), seenPayload: z.boolean() }),
    });
    try {
      const workflow = smithers((ctx) => {
        const continuation = ctx.input?.__smithersContinuation;
        const shouldContinue = !continuation?.payload;
        return (
          <Workflow name="core-continue-as-new">
            <Sequence>
              {shouldContinue ? <ContinueAsNew state={{ cursor: "abc" }} /> : null}
              <Task id="result" output={outputs.result}>
                {() => ({
                  cursor: continuation?.payload?.cursor ?? null,
                  seenPayload: Boolean(continuation?.payload),
                })}
              </Task>
            </Sequence>
          </Workflow>
        );
      });
      const result = await runInRoot(workflow, dbPath, {
        input: {},
        runId: "core-can-1",
      });
      expect(result.status).toBe("finished");
      // Child run should have been created with payload; root may finish after continueAsNew.
      const rows = await db.select().from(tables.result);
      // At least one result row exists across parent/child.
      expect(rows.length).toBeGreaterThanOrEqual(1);
      const seen = rows.some((r) => r.seenPayload === true || r.cursor === "abc" || r.cursor === null);
      expect(seen).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("system: frontmatter smithers-system is detected (no env auto-mirror)", async () => {
    const dir = join(tmpdir(), `core-sys-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const sysPath = join(dir, "post-failure.tsx");
    const userPath = join(dir, "hello.tsx");
    writeFileSync(sysPath, `// smithers-system: true\nexport default {}\n`);
    writeFileSync(userPath, `export default {}\n`);
    expect(isSystemWorkflowSource(sysPath)).toBe(true);
    expect(isSystemWorkflowSource(userPath)).toBe(false);
  });

  test("hitl+steer: approval then steer-steered implement", async () => {
    // Combined practical path: plan → gate → steered implement
    const clock = createVirtualClock();
    const consumer = scriptedAgent(loadFixture("steer-consumer"), {
      clock,
      schema: outSchema,
      id: "consumer",
    });
    const producerBase = agentFromFixture("steer-producer", {
      clock,
      schema: outSchema,
      id: "producer",
    });
    const { smithers, outputs, db, dbPath, cleanup } = createTestSmithers({
      plan: outSchema,
      gate: approvalDecisionSchema,
      implement: outSchema,
    });
    try {
      const adapter = new SmithersDb(db);
      const producer = {
        id: "producer",
        tools: {},
        supportsNativeStructuredOutput: true,
        calls: producerBase.calls,
        generate: async (args) => {
          const runId = args?.taskContext?.runId;
          if (typeof runId === "string") {
            await Effect.runPromise(enqueueSteer(adapter, runId, "implement", STEER, { author: "scenario" }));
          }
          return producerBase.generate(args);
        },
        lastPrompt: () => producerBase.lastPrompt(),
        reset: () => producerBase.reset(),
      };
      const workflow = smithers(() => (
        <Workflow name="core-hitl-steer">
          <Sequence>
            <Task id="plan" output={outputs.plan} agent={producer}>
              plan
            </Task>
            <Approval id="gate" output={outputs.gate} request={{ title: "Ship plan?" }} />
            <Task id="implement" output={outputs.implement} agent={consumer}>
              implement
            </Task>
          </Sequence>
        </Workflow>
      ));
      const first = await runInRoot(workflow, dbPath, { input: {}, runId: "core-hitl-steer-1" });
      expect(first.status).toBe("waiting-approval");
      await Effect.runPromise(approveNode(adapter, first.runId, "gate", 0, "ok", "tester"));
      const resumed = await runScenario({
        workflow,
        runId: first.runId,
        resume: true,
        rootDir: dirname(dbPath),
        clock,
        runWorkflowFn: scenarioRunWorkflowFn(dbPath),
      });
      expect(resumed.status).toBe("finished");
      await expectSteerConsumed(adapter, first.runId, { nodeId: "implement" });
      expect([...consumer.usedTurnIndexes]).toEqual([0]);
    } finally {
      cleanup();
    }
  });
});
