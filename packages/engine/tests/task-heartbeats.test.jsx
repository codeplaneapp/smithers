/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { Task, Workflow, runWorkflow } from "smithers-orchestrator";
import { requireTaskRuntime } from "@smithers-orchestrator/driver/task-runtime";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { createTestSmithers, sleep } from "../../smithers/tests/helpers.js";
import { outputSchemas } from "../../smithers/tests/schema.js";
import { Effect } from "effect";
import { BaseCliAgent } from "@smithers-orchestrator/agents/BaseCliAgent";

class SilentOwnedChildAgent extends BaseCliAgent {
  async buildCommand() {
    return {
      command: process.execPath,
      args: ["-e", "setTimeout(() => process.stdout.write(JSON.stringify({value: 1})), 2000)"],
    };
  }
}
class ExitedChildNeverResolvingAgent extends BaseCliAgent {
  postExit;
  workStarted;
  processExited = false;
  superGenerateReturned = false;
  constructor(options) {
    super(options);
    this.postExit = new Promise((resolve) => {
      this.resolvePostExit = resolve;
    });
    this.workStarted = new Promise((resolve) => {
      this.resolveWorkStarted = resolve;
    });
  }
  async buildCommand() {
    return {
      command: "node",
      args: ["-e", "process.exit(0)"],
    };
  }
  async generate(options) {
    // Exercise the real BaseCliAgent child lifecycle first. Once its child
    // has exited (and emitted no further process evidence), emulate a
    // wedged adapter that ignores its abort signal.
    let processExited = false;
    let resolveProcessExited;
    const processExit = new Promise((resolve) => {
      resolveProcessExited = resolve;
    });
    let result;
    try {
      result = await super.generate({
        ...options,
        // The regression is specifically post-child-exit work that ignores
        // the engine abort. Let the real child lifecycle settle normally;
        // the outer engine watchdog must time out only the later work.
        abortSignal: undefined,
        onProcess: (event) => {
          options.onProcess?.(event);
          if (event?.phase === "exited") {
            processExited = true;
            this.processExited = true;
            resolveProcessExited?.();
          }
        },
      });
    } catch (error) {
      this.superGenerateError = error;
      throw error;
    }
    this.superGenerateReturned = true;
    expect(processExited).toBe(true);
    expect(this.superGenerateError).toBeUndefined();
    await processExit;
    this.resolvePostExit?.();
    this.resolveWorkStarted?.();
    await new Promise(() => {});
    return result;
  }
}
class NeverResolvingAgent {
  id = "never-resolving-agent";
  async generate() {
    // Deliberately ignore AbortSignal and never settle. The engine must
    // still win the heartbeat race and finish the run durably.
    await new Promise(() => {});
  }
}
class CallbackCheckpointAgent {
  id = "callback-checkpoint-agent";
  constructor(db, checkpointJson) {
    this.adapter = new SmithersDb(db);
    this.checkpointJson = checkpointJson;
    this.calls = 0;
  }
  async generate(options) {
    this.calls += 1;
    if (this.calls === 1) {
      const run = await this.adapter.getRun(options.taskContext.runId);
      await Effect.runPromise(
        this.adapter.heartbeatAttempt(
          options.taskContext.runId,
          options.taskContext.nodeId,
          options.taskContext.iteration,
          options.taskContext.attempt,
          Date.now(),
          this.checkpointJson,
          run?.runtimeOwnerId ?? null,
        ),
      );
      throw new Error("retry after checkpoint");
    }
    options.onStdout?.("stdout");
    options.onStderr?.("stderr");
    options.onEvent?.({ type: "completed", engine: "test", resume: "resume-1", answer: "" });
    options.onStepFinish?.({ response: { messages: [{ role: "assistant", content: "step" }] } });
    options.onStepEnd?.({ response: { messages: [{ role: "assistant", content: "end" }] } });
    options.onProcess?.({ phase: "started", pid: process.pid });
    options.onProcess?.({ phase: "exited", pid: process.pid });
    return { text: JSON.stringify({ value: 1 }) };
  }
}
class LateResolvingAgent {
  id = "late-resolving-agent";
  resolve;
  async generate() {
    return await new Promise((resolve) => {
      this.resolve = resolve;
    });
  }
}
class StaleOwnerCallbacksAgent {
  id = "stale-owner-callbacks-agent";
  options = null;
  startedResolve;
  started = new Promise((resolve) => {
    this.startedResolve = resolve;
  });
  async generate(options) {
    this.options = options;
    this.startedResolve?.();
    // Keep the original call pending after the other runtime takes over.
    // The engine's abort race, rather than agent cooperation, must end it.
    await new Promise(() => {});
  }
}
class SchemaRepairStaleOwnerAgent {
  id = "schema-repair-stale-owner-agent";
  calls = 0;
  options = null;
  repairStartedResolve;
  repairStarted = new Promise((resolve) => {
    this.repairStartedResolve = resolve;
  });
  async generate(options) {
    this.calls += 1;
    if (this.calls === 1) {
      // Valid JSON but invalid for outputA, so the engine enters its
      // schema-repair call path.
      return { text: "{}" };
    }
    this.options = options;
    this.repairStartedResolve?.();
    await new Promise(() => {});
  }
}
function buildSmithers() {
  return createTestSmithers(outputSchemas);
}
async function waitForRunningAttempt(adapter, nodeId) {
  for (let i = 0; i < 80; i += 1) {
    try {
      const run = (await adapter.listRuns(20, "running"))[0];
      if (run) {
        const attempt = (await adapter.listAttempts(run.runId, nodeId, 0))[0];
        if (attempt) return { run, attempt };
      }
    } catch {}
    await sleep(25);
  }
  throw new Error(`attempt ${nodeId} did not start`);
}
describe("task heartbeats", () => {
  test("a real silent owned child keeps task and run heartbeats fresh", async () => {
    const { smithers, outputs, db, cleanup, tables } = buildSmithers();
    const workflow = smithers(() => (
      <Workflow name="heartbeat-owned-child">
        <Task
          id="child"
          output={outputs.outputA}
          agent={new SilentOwnedChildAgent({ id: "silent-owned-child" })}
          heartbeatTimeoutMs={700}
        >
          A silent child process must remain alive until it returns valid JSON.
        </Task>
      </Workflow>
    ));
    const resultPromise = Effect.runPromise(runWorkflow(workflow, { input: {} }));
    const adapter = new SmithersDb(db);
    const { run: initialRun, attempt: initialAttempt } = await waitForRunningAttempt(adapter, "child");
    await sleep(1300);
    const running = await adapter.listRuns(20, "running");
    expect(running).toHaveLength(1);
    const attempt = (await adapter.listAttempts(running[0].runId, "child", 0))[0];
    expect(running[0].heartbeatAtMs).toBeGreaterThan(initialRun.heartbeatAtMs ?? 0);
    expect(attempt?.heartbeatAtMs).toBeGreaterThan(initialAttempt?.heartbeatAtMs ?? 0);
    const result = await resultPromise;
    expect(result.status).toBe("finished");
    cleanup();
  }, 10_000);
  test("a real child that exits cannot keep a wedged agent alive", async () => {
    const { smithers, outputs, db, cleanup } = buildSmithers();
    const agent = new ExitedChildNeverResolvingAgent({ id: "exited-child" });
    const workflow = smithers(() => (
      <Workflow name="heartbeat-exited-child-dead-work">
        <Task id="child" output={outputs.outputA} agent={agent} retries={0} noRetry heartbeatTimeoutMs={5_000}>
          The child exits, then the adapter wedges without process evidence.
        </Task>
      </Workflow>
    ));
    const resultPromise = Effect.runPromise(runWorkflow(workflow, { input: {} }));
    await agent.postExit;
    await agent.workStarted;
    expect(agent.processExited).toBe(true);
    expect(agent.superGenerateReturned).toBe(true);
    const result = await resultPromise;
    expect(result.status).toBe("failed");
    const attempts = await new SmithersDb(db).listAttempts(result.runId, "child", 0);
    expect(attempts[0]?.errorJson).toContain("TASK_HEARTBEAT_TIMEOUT");
    cleanup();
  }, 15_000);
  test("heartbeat persists and is readable", async () => {
    const { smithers, outputs, db, cleanup } = buildSmithers();
    const workflow = smithers(() => (
      <Workflow name="heartbeat-persists">
        <Task id="hb" output={outputs.outputA}>
          {() => {
            const runtime = requireTaskRuntime();
            runtime.heartbeat({ progress: 50 });
            return { value: 1 };
          }}
        </Task>
      </Workflow>
    ));
    const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
    expect(result.status).toBe("finished");
    const adapter = new SmithersDb(db);
    const attempts = await adapter.listAttempts(result.runId, "hb", 0);
    expect(typeof attempts[0]?.heartbeatAtMs).toBe("number");
    expect(JSON.parse(attempts[0]?.heartbeatDataJson ?? "null")).toEqual({
      progress: 50,
    });
    cleanup();
  });
  test("checkpoint is passed to retry attempt via runtime.lastHeartbeat", async () => {
    const { smithers, outputs, cleanup } = buildSmithers();
    let calls = 0;
    const checkpoints = [];
    const workflow = smithers(() => (
      <Workflow name="heartbeat-retry-checkpoint">
        <Task id="retry" output={outputs.outputA} retries={1}>
          {() => {
            calls += 1;
            const runtime = requireTaskRuntime();
            checkpoints.push(runtime.lastHeartbeat);
            if (calls === 1) {
              runtime.heartbeat({ cursor: "page-5" });
              throw new Error("fail first attempt");
            }
            const checkpoint = runtime.lastHeartbeat;
            if (checkpoint?.cursor !== "page-5") {
              throw new Error("missing retry checkpoint");
            }
            return { value: 2 };
          }}
        </Task>
      </Workflow>
    ));
    const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
    expect(result.status).toBe("finished");
    expect(calls).toBe(2);
    expect(checkpoints[0]).toBeNull();
    expect(checkpoints[1]).toEqual({ cursor: "page-5" });
    cleanup();
  });
  test("multiple heartbeats overwrite and persist only latest payload", async () => {
    const { smithers, outputs, db, cleanup } = buildSmithers();
    const workflow = smithers(() => (
      <Workflow name="heartbeat-overwrite">
        <Task id="overwrite" output={outputs.outputA}>
          {() => {
            const runtime = requireTaskRuntime();
            runtime.heartbeat({ progress: 25 });
            runtime.heartbeat({ progress: 50 });
            runtime.heartbeat({ progress: 75 });
            return { value: 1 };
          }}
        </Task>
      </Workflow>
    ));
    const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
    expect(result.status).toBe("finished");
    const adapter = new SmithersDb(db);
    const attempts = await adapter.listAttempts(result.runId, "overwrite", 0);
    expect(JSON.parse(attempts[0]?.heartbeatDataJson ?? "null")).toEqual({
      progress: 75,
    });
    cleanup();
  });
  test("activity after a checkpoint preserves the checkpoint payload", async () => {
    const { smithers, outputs, db, cleanup } = buildSmithers();
    const workflow = smithers(() => (
      <Workflow name="heartbeat-checkpoint-stream">
        <Task id="stream" output={outputs.outputA} cache={{ key: "checkpoint-stream" }}>
          {async () => {
            const runtime = requireTaskRuntime();
            runtime.heartbeat({ cursor: "page-5" });
            await sleep(20);
            runtime.heartbeat();
            return { value: 1 };
          }}
        </Task>
      </Workflow>
    ));
    const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
    expect(result.status).toBe("finished");
    const adapter = new SmithersDb(db);
    const attempts = await adapter.listAttempts(result.runId, "stream", 0);
    expect(JSON.parse(attempts[0]?.heartbeatDataJson ?? "null")).toEqual({ cursor: "page-5" });
    cleanup();
  });
  test("agent activity preserves object, scalar, and array checkpoints byte-for-byte", async () => {
    for (const checkpointJson of [
      ' { "z": "line\\nvalue", "cursor": "page-5" } ',
      '[  "a", 2e0 ]',
      ' "scalar\\u002Dcheckpoint" ',
    ]) {
      const { smithers, outputs, db, cleanup } = buildSmithers();
      const workflow = smithers(() => (
        <Workflow name="heartbeat-callback-checkpoint">
          <Task
            id="callbacks"
            output={outputs.outputA}
            retries={1}
            agent={new CallbackCheckpointAgent(db, checkpointJson)}
          >
            Preserve the application checkpoint while callbacks report activity.
          </Task>
        </Workflow>
      ));
      const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
      expect(result.status).toBe("finished");
      const attempts = await new SmithersDb(db).listAttempts(result.runId, "callbacks", 0);
      expect(attempts[0]?.heartbeatDataJson).toBe(checkpointJson);
      cleanup();
    }
  });
  test("a never-resolving agent times out promptly without synthetic liveness", async () => {
    const { smithers, outputs, db, cleanup } = buildSmithers();
    const workflow = smithers(() => (
      <Workflow name="heartbeat-silent-legacy-execution">
        <Task
          id="silent"
          output={outputs.outputA}
          agent={new NeverResolvingAgent()}
          retries={0}
          noRetry
          heartbeatTimeoutMs={200}
        >
          Ignore the abort signal and never resolve.
        </Task>
      </Workflow>
    ));
    const startedAt = Date.now();
    const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(result.status).toBe("failed");
    const attempts = await new SmithersDb(db).listAttempts(result.runId, "silent", 0);
    expect(attempts[0]?.errorJson).toContain("TASK_HEARTBEAT_TIMEOUT");
    cleanup();
  }, 10_000);
  test("legacy compute watchdog abort has no unhandled task-abort rejection", async () => {
    const { smithers, outputs, cleanup } = buildSmithers();
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const workflow = smithers(() => (
        <Workflow name="heartbeat-legacy-compute-abort">
          <Task
            id="compute"
            output={outputs.outputA}
            cache={{ key: "legacy-compute-abort" }}
            retries={0}
            noRetry
            heartbeatTimeoutMs={120}
          >
            {async () => await new Promise(() => {})}
          </Task>
        </Workflow>
      ));
      const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
      expect(result.status).toBe("failed");
      await sleep(50);
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      cleanup();
    }
  }, 10_000);
  test("a late agent result cannot write output or terminal success after heartbeat timeout", async () => {
    const { smithers, outputs, db, cleanup, tables } = buildSmithers();
    const agent = new LateResolvingAgent();
    const workflow = smithers(() => (
      <Workflow name="heartbeat-late-agent-result">
        <Task id="late" output={outputs.outputA} agent={agent} retries={0} noRetry heartbeatTimeoutMs={120}>
          late
        </Task>
      </Workflow>
    ));
    const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
    expect(result.status).toBe("failed");
    const adapter = new SmithersDb(db);
    const outputRows = await db.select().from(tables.outputA);
    expect(outputRows).toHaveLength(0);
    const beforeLateResolve = await adapter.listEventHistory(result.runId, { limit: 200 });
    agent.resolve?.({ text: JSON.stringify({ value: 99 }) });
    await sleep(350);
    const outputRowsAfterLateResolve = await db.select().from(tables.outputA);
    expect(outputRowsAfterLateResolve).toHaveLength(0);
    const attempts = await adapter.listAttempts(result.runId, "late", 0);
    expect(attempts[0]?.state).toBe("failed");
    expect(attempts[0]?.errorJson).toContain("TASK_HEARTBEAT_TIMEOUT");
    const events = await adapter.listEventHistory(result.runId, { limit: 200 });
    expect(events).toEqual(beforeLateResolve);
    expect(events.map((event) => event.type)).not.toContain("NodeFinished");
    expect(events.map((event) => event.type)).not.toContain("RunFinished");
    cleanup();
  }, 10_000);
  test("stale-owner callbacks cannot create output, agent events, heartbeats, or process evidence", async () => {
    const { smithers, outputs, db, cleanup } = buildSmithers();
    const agent = new StaleOwnerCallbacksAgent();
    const workflow = smithers(() => (
      <Workflow name="heartbeat-stale-owner-callbacks">
        <Task id="stale" output={outputs.outputA} agent={agent} retries={0} noRetry heartbeatTimeoutMs={2_000}>
          Do not settle; callbacks are invoked after ownership changes.
        </Task>
      </Workflow>
    ));
    const resultPromise = Effect.runPromise(runWorkflow(workflow, { input: {} }));
    await agent.started;
    const adapter = new SmithersDb(db);
    const running = (await adapter.listRuns(20, "running"))[0];
    expect(running).toBeDefined();
    await Effect.runPromise(adapter.updateRun(running.runId, { runtimeOwnerId: "new-runtime-owner" }));
    const before = await adapter.getRun(running.runId);
    const beforeEvents = await adapter.listEventHistory(running.runId, { limit: 200 });
    agent.options.onStdout?.("stale stdout");
    agent.options.onStderr?.("stale stderr");
    agent.options.onEvent?.({ type: "completed", engine: "test", resume: "stale-resume", answer: "stale" });
    agent.options.onStepFinish?.({ response: { messages: [{ role: "assistant", content: "stale step" }] } });
    agent.options.onProcess?.({ phase: "started", pid: process.pid });
    const result = await resultPromise;
    // The other runtime owns the run now, so this executor deliberately
    // returns without terminalizing it; only the new owner may do that.
    expect(result.status).toBe("running");
    await sleep(50);
    const after = await adapter.getRun(running.runId);
    const afterEvents = await adapter.listEventHistory(running.runId, { limit: 200 });
    expect(after?.heartbeatAtMs).toBe(before?.heartbeatAtMs);
    const callbackEvents = afterEvents.slice(beforeEvents.length);
    expect(callbackEvents.map((event) => event.type)).not.toContain("TaskHeartbeat");
    expect(callbackEvents.map((event) => event.type)).not.toContain("NodeOutput");
    expect(callbackEvents.map((event) => event.type)).not.toContain("AgentEvent");
    cleanup();
  }, 10_000);
  test("schema-repair callbacks are fenced before they persist evidence", async () => {
    const { smithers, outputs, db, cleanup } = buildSmithers();
    const agent = new SchemaRepairStaleOwnerAgent();
    const workflow = smithers(() => (
      <Workflow name="heartbeat-schema-repair-stale-owner">
        <Task id="repair" output={outputs.outputA} agent={agent} retries={0} noRetry heartbeatTimeoutMs={2_000}>
          The invalid first response must enter schema repair.
        </Task>
      </Workflow>
    ));
    const resultPromise = Effect.runPromise(runWorkflow(workflow, { input: {} }));
    await agent.repairStarted;
    const adapter = new SmithersDb(db);
    const running = (await adapter.listRuns(20, "running"))[0];
    await Effect.runPromise(adapter.updateRun(running.runId, { runtimeOwnerId: "new-runtime-owner" }));
    const beforeEvents = await adapter.listEventHistory(running.runId, { limit: 200 });
    agent.options.onStdout?.("stale repair stdout");
    agent.options.onStderr?.("stale repair stderr");
    agent.options.onEvent?.({ type: "completed", engine: "test", resume: "stale-repair", answer: "stale" });
    agent.options.onStepFinish?.({ response: { messages: [{ role: "assistant", content: "stale repair step" }] } });
    agent.options.onProcess?.({ phase: "started", pid: process.pid });
    const result = await resultPromise;
    expect(result.status).toBe("running");
    await sleep(50);
    const afterEvents = await adapter.listEventHistory(running.runId, { limit: 200 });
    const callbackEvents = afterEvents.slice(beforeEvents.length);
    expect(callbackEvents.map((event) => event.type)).not.toContain("TaskHeartbeat");
    expect(callbackEvents.map((event) => event.type)).not.toContain("NodeOutput");
    expect(callbackEvents.map((event) => event.type)).not.toContain("AgentEvent");
    cleanup();
  }, 10_000);
  test("heartbeat timeout marks attempt failed and retries", async () => {
    const { smithers, outputs, db, cleanup } = buildSmithers();
    let calls = 0;
    const workflow = smithers(() => (
      <Workflow name="heartbeat-timeout-retry">
        <Task id="timeout" output={outputs.outputA} cache={{ key: "dead-legacy" }} retries={1} heartbeatTimeoutMs={300}>
          {async () => {
            calls += 1;
            const runtime = requireTaskRuntime();
            if (calls === 1) {
              // Establish the timeout baseline from inside the execution.
              // Test-file setup can otherwise consume most of the short
              // 200ms window before this compute callback gets a turn.
              runtime.heartbeat({ phase: "started" });
              await sleep(350);
              return { value: 1 };
            }
            runtime.heartbeat({ progress: 1 });
            await sleep(40);
            runtime.heartbeat({ progress: 2 });
            return { value: 2 };
          }}
        </Task>
      </Workflow>
    ));
    const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
    expect(result.status).toBe("finished");
    expect(calls).toBe(2);
    const adapter = new SmithersDb(db);
    const attempts = await adapter.listAttempts(result.runId, "timeout", 0);
    expect(attempts.some((attempt) => attempt.state === "failed")).toBe(true);
    expect(attempts.some((attempt) => attempt.state === "finished")).toBe(true);
    cleanup();
  }, 20_000);
  test("task without heartbeat timeout can run without heartbeats", async () => {
    const { smithers, outputs, cleanup } = buildSmithers();
    const workflow = smithers(() => (
      <Workflow name="heartbeat-no-timeout">
        <Task id="no-timeout" output={outputs.outputA}>
          {async () => {
            await sleep(300);
            return { value: 1 };
          }}
        </Task>
      </Workflow>
    ));
    const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
    expect(result.status).toBe("finished");
    cleanup();
  });
  test("frequent heartbeats keep task alive beyond timeout window", async () => {
    const { smithers, outputs, cleanup } = buildSmithers();
    const workflow = smithers(() => (
      <Workflow name="heartbeat-keeps-alive">
        <Task id="alive" output={outputs.outputA} heartbeatTimeoutMs={120}>
          {async () => {
            const runtime = requireTaskRuntime();
            for (let i = 0; i < 6; i++) {
              runtime.heartbeat({ tick: i });
              await sleep(60);
            }
            return { value: 1 };
          }}
        </Task>
      </Workflow>
    ));
    const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
    expect(result.status).toBe("finished");
    cleanup();
  });
  test("non-JSON heartbeat payload fails at heartbeat call time", async () => {
    const { smithers, outputs, db, cleanup } = buildSmithers();
    const workflow = smithers(() => (
      <Workflow name="heartbeat-invalid-json">
        <Task id="invalid" output={outputs.outputA}>
          {() => {
            const runtime = requireTaskRuntime();
            runtime.heartbeat({ fn: () => {} });
            return { value: 1 };
          }}
        </Task>
      </Workflow>
    ));
    const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
    expect(result.status).toBe("failed");
    const adapter = new SmithersDb(db);
    const attempts = await adapter.listAttempts(result.runId, "invalid", 0);
    const errorJson = JSON.parse(attempts[0]?.errorJson ?? "{}");
    expect(errorJson.code).toBe("HEARTBEAT_PAYLOAD_NOT_JSON_SERIALIZABLE");
    cleanup();
  });
  test("oversized heartbeat payload fails with HEARTBEAT_PAYLOAD_TOO_LARGE", async () => {
    const { smithers, outputs, db, cleanup } = buildSmithers();
    const workflow = smithers(() => (
      <Workflow name="heartbeat-too-large">
        <Task id="too-large" output={outputs.outputA}>
          {() => {
            const runtime = requireTaskRuntime();
            runtime.heartbeat({ data: "x".repeat(1_100_000) });
            return { value: 1 };
          }}
        </Task>
      </Workflow>
    ));
    const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
    expect(result.status).toBe("failed");
    const adapter = new SmithersDb(db);
    const attempts = await adapter.listAttempts(result.runId, "too-large", 0);
    const errorJson = JSON.parse(attempts[0]?.errorJson ?? "{}");
    expect(errorJson.code).toBe("HEARTBEAT_PAYLOAD_TOO_LARGE");
    cleanup();
  });
  test("heartbeat calls after task completion are ignored", async () => {
    const { smithers, outputs, db, cleanup } = buildSmithers();
    const workflow = smithers(() => (
      <Workflow name="heartbeat-after-complete">
        <Task id="after" output={outputs.outputA}>
          {() => {
            const runtime = requireTaskRuntime();
            setTimeout(() => {
              runtime.heartbeat({ late: true });
            }, 40);
            return { value: 1 };
          }}
        </Task>
      </Workflow>
    ));
    const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
    expect(result.status).toBe("finished");
    await sleep(120);
    const adapter = new SmithersDb(db);
    const attempts = await adapter.listAttempts(result.runId, "after", 0);
    expect(attempts[0]?.heartbeatDataJson).toBeNull();
    cleanup();
  });
});
