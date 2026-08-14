/** @jsxImportSource smthrs */
import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { SmithersDb } from "@smthrs/db/adapter";
import { Effect } from "effect";
import { Sequence, Task, Workflow, runWorkflow } from "smthrs";
import { createTestSmithers, sleep } from "../../smithers/tests/helpers.js";
import { outputSchemas } from "../../smithers/tests/schema.js";
import { SmithersError } from "@smthrs/errors/SmithersError";
/**
 * @param {any[]} nodes
 * @param {string} nodeId
 */
function nodeState(nodes, nodeId) {
  return nodes.find((node) => node.nodeId === nodeId)?.state;
}
/**
 * @param {string} counterPath
 */
function readCounter(counterPath) {
  if (!existsSync(counterPath)) return 0;
  const raw = readFileSync(counterPath, "utf8").trim();
  return raw.length > 0 ? Number(raw) : 0;
}
/**
 * @param {string} counterPath
 */
function incrementCounter(counterPath) {
  const next = readCounter(counterPath) + 1;
  writeFileSync(counterPath, String(next));
  return next;
}

function readCallTimes(callLogPath) {
  if (!existsSync(callLogPath)) return [];
  return readFileSync(callLogPath, "utf8").trim().split("\n").filter(Boolean).map(Number);
}

function buildRetryBackoffWorkflow(smithers, outputs, callLogPath, firstRetryAfterMs) {
  return smithers(() => (
    <Workflow name="resume-durable-retry-backoff">
      <Task
        id="flaky"
        output={outputs.outputA}
        retries={2}
        retryPolicy={{ backoff: "exponential", initialDelayMs: 750 }}
      >
        {() => {
          const call = readCallTimes(callLogPath).length + 1;
          appendFileSync(callLogPath, `${Date.now()}\n`);
          if (call <= 2) {
            throw new SmithersError("PROVIDER_TRANSIENT", `failure ${call}`, {
              failureRetryable: true,
              retryAfterMs: call === 1 ? firstRetryAfterMs : 50,
            });
          }
          return { value: call };
        }}
      </Task>
    </Workflow>
  ));
}
/**
 * @param {() => Promise<boolean>} predicate
 * @param {{ timeoutMs?: number; intervalMs?: number }} [options]
 */
async function waitFor(predicate, options) {
  const timeoutMs = options?.timeoutMs ?? 5_000;
  const intervalMs = options?.intervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch {}
    await sleep(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}
/**
 * @param {{ dbPath: string; counterPath: string; runId: string; }} params
 */
function spawnHangingRun(params) {
  const smithersPath = resolve(import.meta.dir, "../../smithers/src/index.js");
  const schemaPath = resolve(import.meta.dir, "../../smithers/tests/schema.js");
  const script = `
import React from "react";
import { createSmithers, Task, Workflow, runWorkflow } from ${JSON.stringify(smithersPath)};
import { outputSchemas } from ${JSON.stringify(schemaPath)};
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Effect } from "effect";

function readCounter(path) {
  if (!existsSync(path)) return 0;
  const raw = readFileSync(path, "utf8").trim();
  return raw.length > 0 ? Number(raw) : 0;
}

function incrementCounter(path) {
  const next = readCounter(path) + 1;
  writeFileSync(path, String(next));
  return next;
}

const api = createSmithers(outputSchemas, { dbPath: ${JSON.stringify(params.dbPath)} });
const agent = {
  id: "hang-on-first-call",
  tools: {},
  async generate() {
    const call = incrementCounter(${JSON.stringify(params.counterPath)});
    if (call === 1) {
      return new Promise(() => {});
    }
    return {
      text: '{"value":7}',
      output: { value: 7 },
    };
  },
};

const workflow = api.smithers(() =>
  React.createElement(
    Workflow,
    { name: "resume-force-running" },
    React.createElement(
      Task,
      {
        id: "stuck",
        output: api.outputs.outputA,
        agent,
      },
      "produce a value",
    ),
  ),
);

await Effect.runPromise(runWorkflow(workflow, {
  input: {},
  runId: ${JSON.stringify(params.runId)},
}));
`;
  const child = spawn(process.execPath, ["-e", script], {
    cwd: process.cwd(),
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("close", (code, signal) => {
      resolveExit({ exitCode: code, signal });
    });
  });
  return {
    child,
    exited,
    readStderr: () => stderr,
  };
}

function spawnRetryBackoffRun(params) {
  const smithersPath = resolve(import.meta.dir, "../../smithers/src/index.js");
  const schemaPath = resolve(import.meta.dir, "../../smithers/tests/schema.js");
  const errorPath = resolve(import.meta.dir, "../../errors/src/SmithersError.js");
  const script = `
import React from "react";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createSmithers, Task, Workflow, runWorkflow } from ${JSON.stringify(smithersPath)};
import { outputSchemas } from ${JSON.stringify(schemaPath)};
import { SmithersError } from ${JSON.stringify(errorPath)};
import { Effect } from "effect";

const callLogPath = ${JSON.stringify(params.callLogPath)};
const readCalls = () => existsSync(callLogPath)
  ? readFileSync(callLogPath, "utf8").trim().split("\\n").filter(Boolean).length
  : 0;
const api = createSmithers(outputSchemas, { dbPath: ${JSON.stringify(params.dbPath)} });
const workflow = api.smithers(() => React.createElement(
  Workflow,
  { name: "resume-durable-retry-backoff" },
  React.createElement(
    Task,
    {
      id: "flaky",
      output: api.outputs.outputA,
      retries: 2,
      retryPolicy: { backoff: "exponential", initialDelayMs: 750 },
    },
    () => {
      const call = readCalls() + 1;
      appendFileSync(callLogPath, String(Date.now()) + "\\n");
      if (call <= 2) {
        throw new SmithersError("PROVIDER_TRANSIENT", "failure " + call, {
          failureRetryable: true,
          retryAfterMs: call === 1 ? ${JSON.stringify(params.firstRetryAfterMs)} : 50,
        });
      }
      return { value: call };
    },
  ),
));
await Effect.runPromise(runWorkflow(workflow, { input: {}, runId: ${JSON.stringify(params.runId)} }));
`;
  const child = spawn(process.execPath, ["-e", script], {
    cwd: process.cwd(),
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("close", (code, signal) => resolveExit({ exitCode: code, signal }));
  });
  return { child, exited, readStderr: () => stderr };
}
describe("resume without time travel", () => {
  test("hard-stop resume preserves the original retry deadline and exponential rung", async () => {
    const { smithers, outputs, db, dbPath, cleanup } = createTestSmithers(outputSchemas);
    const adapter = new SmithersDb(db);
    const runId = "resume-durable-retry-deadline";
    const callLogPath = `${dbPath}.retry-calls`;
    const child = spawnRetryBackoffRun({ dbPath, callLogPath, runId, firstRetryAfterMs: 1_500 });
    try {
      let durableRetryState;
      await waitFor(
        async () => {
          const failed = (await adapter.listAttempts(runId, "flaky", 0)).find((attempt) => attempt.state === "failed");
          durableRetryState = failed ? JSON.parse(failed.metaJson ?? "{}").retryState : undefined;
          return durableRetryState?.failureCount === 1;
        },
        { timeoutMs: 10_000, intervalMs: 20 },
      );
      expect(readCallTimes(callLogPath)).toHaveLength(1);
      child.child.kill("SIGKILL");
      await child.exited;

      const workflow = buildRetryBackoffWorkflow(smithers, outputs, callLogPath, 1_500);
      const resumedPromise = Effect.runPromise(runWorkflow(workflow, { input: {}, runId, resume: true, force: true }));
      await sleep(100);
      expect(readCallTimes(callLogPath)).toHaveLength(1);
      const resumed = await resumedPromise;
      expect(resumed.status).toBe("finished");
      const callTimes = readCallTimes(callLogPath);
      expect(callTimes).toHaveLength(3);
      expect(callTimes[1]).toBeGreaterThanOrEqual(durableRetryState.retryAtMs);
      expect(callTimes[2] - callTimes[1]).toBeGreaterThanOrEqual(1_400);
      const attempts = await adapter.listAttempts(runId, "flaky", 0);
      expect(JSON.parse(attempts.find((attempt) => attempt.attempt === 2).metaJson).retryState.failureCount).toBe(2);
    } finally {
      if (child.child.exitCode === null && !child.child.killed) {
        child.child.kill("SIGKILL");
        await child.exited.catch(() => undefined);
      }
      cleanup();
    }
  }, 30_000);

  test("cancellation promptly interrupts a retry wait hydrated after a hard stop", async () => {
    const { smithers, outputs, db, dbPath, cleanup } = createTestSmithers(outputSchemas);
    const adapter = new SmithersDb(db);
    const runId = "resume-durable-retry-cancel";
    const callLogPath = `${dbPath}.retry-cancel-calls`;
    const child = spawnRetryBackoffRun({ dbPath, callLogPath, runId, firstRetryAfterMs: 5_000 });
    try {
      await waitFor(
        async () => {
          const failed = (await adapter.listAttempts(runId, "flaky", 0)).find((attempt) => attempt.state === "failed");
          return JSON.parse(failed?.metaJson ?? "{}").retryState?.failureCount === 1;
        },
        { timeoutMs: 10_000, intervalMs: 20 },
      );
      const ownerBeforeKill = (await adapter.getRun(runId))?.runtimeOwnerId;
      child.child.kill("SIGKILL");
      await child.exited;

      const workflow = buildRetryBackoffWorkflow(smithers, outputs, callLogPath, 5_000);
      const startedAtMs = Date.now();
      const resumedPromise = Effect.runPromise(runWorkflow(workflow, { input: {}, runId, resume: true, force: true }));
      await waitFor(async () => {
        const run = await adapter.getRun(runId);
        return run?.status === "running" && run.runtimeOwnerId && run.runtimeOwnerId !== ownerBeforeKill;
      });
      await adapter.requestRunCancel(runId, Date.now());
      const resumed = await resumedPromise;
      expect(resumed.status).toBe("cancelled");
      expect(Date.now() - startedAtMs).toBeLessThan(2_000);
      expect(readCallTimes(callLogPath)).toHaveLength(1);
    } finally {
      if (child.child.exitCode === null && !child.child.killed) {
        child.child.kill("SIGKILL");
        await child.exited.catch(() => undefined);
      }
      cleanup();
    }
  }, 30_000);

  test("resume keeps exhausted failed task failed until retries increase", async () => {
    const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
    try {
      const adapter = new SmithersDb(db);
      const callsByNodeId = {};
      /**
       * @param {string} nodeId
       */
      const makeAgent = (nodeId) => ({
        id: `agent-${nodeId}`,
        tools: {},
        /**
         * @param {any} args
         */
        async generate(args) {
          callsByNodeId[nodeId] = (callsByNodeId[nodeId] ?? 0) + 1;
          if (args?.nodeId) {
            expect(args.nodeId).toBe(nodeId);
          }
          if (nodeId === "implement" && callsByNodeId[nodeId] === 1) {
            throw new Error("implement failed");
          }
          return {
            text: '{"value":7}',
            output: { value: 7 },
          };
        },
      });
      const workflow = smithers(() => (
        <Workflow name="resume-current-state">
          <Sequence>
            <Task id="analyze" output={outputs.outputA} agent={makeAgent("analyze")}>
              analyze the problem
            </Task>
            <Task id="implement" output={outputs.outputB} agent={makeAgent("implement")} retries={0}>
              implement the fix
            </Task>
            <Task id="test" output={outputs.outputC} agent={makeAgent("test")}>
              validate the result
            </Task>
          </Sequence>
        </Workflow>
      ));
      const first = await Effect.runPromise(
        runWorkflow(workflow, {
          input: {},
          runId: "resume-no-time-travel-retry",
        }),
      );
      expect(first.status).toBe("failed");
      const firstNodes = await adapter.listNodes(first.runId);
      expect(nodeState(firstNodes, "analyze")).toBe("finished");
      expect(nodeState(firstNodes, "implement")).toBe("failed");
      const resumed = await Effect.runPromise(
        runWorkflow(workflow, {
          input: {},
          runId: first.runId,
          resume: true,
        }),
      );
      expect(resumed.status).toBe("failed");
      const analyzeAttempts = await adapter.listAttempts(first.runId, "analyze", 0);
      const implementAttempts = await adapter.listAttempts(first.runId, "implement", 0);
      const testAttempts = await adapter.listAttempts(first.runId, "test", 0);
      expect(analyzeAttempts).toHaveLength(1);
      expect(implementAttempts).toHaveLength(1);
      expect(testAttempts).toHaveLength(0);
      expect(callsByNodeId.analyze).toBe(1);
      expect(callsByNodeId.implement).toBe(1);
      expect(callsByNodeId.test).toBeUndefined();
    } finally {
      cleanup();
    }
  });
  test("resume retries failed task when workflow now allows more retries", async () => {
    const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
    try {
      const adapter = new SmithersDb(db);
      const callsByNodeId = {};
      /**
       * @param {string} nodeId
       */
      const makeAgent = (nodeId) => ({
        id: `agent-${nodeId}`,
        tools: {},
        /**
         * @param {any} args
         */
        async generate(args) {
          callsByNodeId[nodeId] = (callsByNodeId[nodeId] ?? 0) + 1;
          if (args?.nodeId) {
            expect(args.nodeId).toBe(nodeId);
          }
          if (nodeId === "implement" && callsByNodeId[nodeId] === 1) {
            throw new Error("implement failed");
          }
          return {
            text: '{"value":7}',
            output: { value: 7 },
          };
        },
      });
      const originalWorkflow = smithers(() => (
        <Workflow name="resume-current-state-upgrade">
          <Sequence>
            <Task id="analyze" output={outputs.outputA} agent={makeAgent("analyze")}>
              analyze the problem
            </Task>
            <Task id="implement" output={outputs.outputB} agent={makeAgent("implement")} retries={0}>
              implement the fix
            </Task>
            <Task id="test" output={outputs.outputC} agent={makeAgent("test")}>
              validate the result
            </Task>
          </Sequence>
        </Workflow>
      ));
      const upgradedWorkflow = smithers(() => (
        <Workflow name="resume-current-state-upgrade">
          <Sequence>
            <Task id="analyze" output={outputs.outputA} agent={makeAgent("analyze")}>
              analyze the problem
            </Task>
            <Task id="implement" output={outputs.outputB} agent={makeAgent("implement")} retries={1}>
              implement the fix
            </Task>
            <Task id="test" output={outputs.outputC} agent={makeAgent("test")}>
              validate the result
            </Task>
          </Sequence>
        </Workflow>
      ));
      const first = await Effect.runPromise(
        runWorkflow(originalWorkflow, {
          input: {},
          runId: "resume-no-time-travel-retry-upgraded",
        }),
      );
      expect(first.status).toBe("failed");
      const resumed = await Effect.runPromise(
        runWorkflow(upgradedWorkflow, {
          input: {},
          runId: first.runId,
          resume: true,
        }),
      );
      expect(resumed.status).toBe("finished");
      const analyzeAttempts = await adapter.listAttempts(first.runId, "analyze", 0);
      const implementAttempts = await adapter.listAttempts(first.runId, "implement", 0);
      const testAttempts = await adapter.listAttempts(first.runId, "test", 0);
      expect(analyzeAttempts).toHaveLength(1);
      expect(implementAttempts).toHaveLength(2);
      expect(testAttempts).toHaveLength(1);
      expect(callsByNodeId.analyze).toBe(1);
      expect(callsByNodeId.implement).toBe(2);
      expect(callsByNodeId.test).toBe(1);
    } finally {
      cleanup();
    }
  });
  test("resume is idempotent on already-finished run", async () => {
    const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
    try {
      const adapter = new SmithersDb(db);
      let callCount = 0;
      const agent = {
        id: "finished-agent",
        tools: {},
        async generate() {
          callCount += 1;
          return {
            text: '{"value":7}',
            output: { value: 7 },
          };
        },
      };
      const workflow = smithers(() => (
        <Workflow name="resume-idempotent-finished">
          <Task id="done" output={outputs.outputA} agent={agent}>
            complete the task
          </Task>
        </Workflow>
      ));
      const first = await Effect.runPromise(
        runWorkflow(workflow, {
          input: {},
          runId: "resume-no-time-travel-idempotent",
        }),
      );
      expect(first.status).toBe("finished");
      expect(callCount).toBe(1);
      const resumed = await Effect.runPromise(
        runWorkflow(workflow, {
          input: {},
          runId: first.runId,
          resume: true,
        }),
      );
      expect(resumed.status).toBe("finished");
      expect(callCount).toBe(1);
      const attempts = await adapter.listAttempts(first.runId, "done", 0);
      expect(attempts).toHaveLength(1);
    } finally {
      cleanup();
    }
  });
  test("resume refuses to steal a run from a live owner process", async () => {
    const { smithers, outputs, db, dbPath, cleanup } = createTestSmithers(outputSchemas);
    const runId = "resume-owner-alive";
    const counterPath = `${dbPath}.owner-alive.calls`;
    const child = spawnHangingRun({ dbPath, counterPath, runId });
    try {
      const adapter = new SmithersDb(db);
      await waitFor(
        async () => {
          const run = await adapter.getRun(runId);
          const attempts = await adapter.listAttempts(runId, "stuck", 0);
          return run?.status === "running" && attempts.some((attempt) => attempt.state === "in-progress");
        },
        { timeoutMs: 10_000, intervalMs: 50 },
      );
      await waitFor(async () => readCounter(counterPath) === 1, { timeoutMs: 10_000, intervalMs: 50 });
      const agent = {
        id: "hang-on-first-call",
        tools: {},
        async generate() {
          const call = incrementCounter(counterPath);
          if (call === 1) {
            return new Promise(() => {});
          }
          return {
            text: '{"value":7}',
            output: { value: 7 },
          };
        },
      };
      const workflow = smithers(() => (
        <Workflow name="resume-owner-alive">
          <Task id="stuck" output={outputs.outputA} agent={agent}>
            produce a value
          </Task>
        </Workflow>
      ));
      const resumed = await Effect.runPromise(
        runWorkflow(workflow, {
          input: {},
          runId,
          resume: true,
          force: true,
        }),
      );
      expect(resumed.status).toBe("failed");
      expect(resumed.error?.code).toBe("RUN_OWNER_ALIVE");
      expect(readCounter(counterPath)).toBe(1);
      const run = await adapter.getRun(runId);
      expect(run?.status).toBe("running");
      expect(run?.runtimeOwnerId).toContain("pid:");
      const attempts = await adapter.listAttempts(runId, "stuck", 0);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.state).toBe("in-progress");
    } finally {
      if (child.child.exitCode === null && !child.child.killed) {
        child.child.kill("SIGKILL");
        await child.exited.catch(() => undefined);
      }
      cleanup();
    }
  });
  test("resume with force flag overrides running status", async () => {
    const { smithers, outputs, db, dbPath, cleanup } = createTestSmithers(outputSchemas);
    const runId = "resume-no-time-travel-force";
    const counterPath = `${dbPath}.calls`;
    const child = spawnHangingRun({ dbPath, counterPath, runId });
    try {
      const adapter = new SmithersDb(db);
      const firstWindow = await Promise.race([child.exited.then(() => "exited"), sleep(250).then(() => "timeout")]);
      expect(firstWindow).toBe("timeout");
      await waitFor(
        async () => {
          const run = await adapter.getRun(runId);
          const attempts = await adapter.listAttempts(runId, "stuck", 0);
          return run?.status === "running" && attempts.some((attempt) => attempt.state === "in-progress");
        },
        { timeoutMs: 10_000, intervalMs: 50 },
      );
      const runBeforeResume = await adapter.getRun(runId);
      expect(runBeforeResume?.status).toBe("running");
      await waitFor(async () => readCounter(counterPath) === 1, { timeoutMs: 10_000, intervalMs: 50 });
      expect(readCounter(counterPath)).toBe(1);
      child.child.kill("SIGKILL");
      await child.exited;
      const agent = {
        id: "hang-on-first-call",
        tools: {},
        async generate() {
          const call = incrementCounter(counterPath);
          if (call === 1) {
            return new Promise(() => {});
          }
          return {
            text: '{"value":7}',
            output: { value: 7 },
          };
        },
      };
      const workflow = smithers(() => (
        <Workflow name="resume-force-running">
          <Task id="stuck" output={outputs.outputA} agent={agent}>
            produce a value
          </Task>
        </Workflow>
      ));
      const resumed = await Effect.runPromise(
        runWorkflow(workflow, {
          input: {},
          runId,
          resume: true,
          force: true,
        }),
      );
      expect(resumed.status).toBe("finished");
      expect(readCounter(counterPath)).toBe(2);
      const attempts = await adapter.listAttempts(runId, "stuck", 0);
      expect(attempts).toHaveLength(2);
      expect(attempts[0]?.state).toBe("finished");
      expect(attempts[1]?.state).toBe("cancelled");
    } finally {
      if (child.child.exitCode === null && !child.child.killed) {
        child.child.kill("SIGKILL");
        await child.exited.catch(() => undefined);
      }
      cleanup();
    }
  });
});
