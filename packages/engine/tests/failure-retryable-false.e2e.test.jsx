/** @jsxImportSource smthrs */
import { describe, expect, test } from "bun:test";
import { SmithersDb } from "@smthrs/db/adapter";
import { SmithersError } from "@smthrs/errors/SmithersError";
import { Parallel, Task, Workflow, runWorkflow } from "smthrs";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { outputSchemas } from "../../smithers/tests/schema.js";
import { Effect } from "effect";

/**
 * When an agent throws a non-retryable SmithersError, the engine must stop after
 * the first failed attempt even if `retries` would otherwise allow another try.
 * This also bypasses retry backoff, so deterministic configuration failures
 * surface immediately.
 */
describe("failureRetryable=false short-circuits engine retries", () => {
  test("agent preflight failure stops before generate and skips retries", async () => {
    const { smithers, outputs, cleanup, db } = createTestSmithers(outputSchemas);
    const adapter = new SmithersDb(db);
    try {
      let preflightCalls = 0;
      let generateCalls = 0;
      const agent = {
        id: "preflight-invalid",
        model: "bad-model",
        cliEngine: "fake-cli",
        tools: {},
        async preflight() {
          preflightCalls += 1;
          throw new SmithersError("AGENT_CONFIG_INVALID", "fake-cli is not authenticated", {
            failureRetryable: false,
            preflight: true,
          });
        },
        async generate() {
          generateCalls += 1;
          return { output: { value: 1 } };
        },
      };
      const workflow = smithers(() => (
        <Workflow name="preflight-fails-fast">
          <Task id="preflight-bad" output={outputs.outputA} agent={agent} retries={5}>
            This should never reach generate.
          </Task>
        </Workflow>
      ));
      const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
      expect(result.status).toBe("failed");
      expect(preflightCalls).toBe(1);
      expect(generateCalls).toBe(0);
      const attempts = await adapter.listAttempts(result.runId, "preflight-bad", 0);
      expect(attempts).toHaveLength(1);
      const error = JSON.parse(attempts[0].errorJson ?? "{}");
      expect(error.code).toBe("AGENT_CONFIG_INVALID");
      const meta = JSON.parse(attempts[0].metaJson ?? "{}");
      expect(meta.failureRetryable).toBe(false);
      expect(meta.agentPreflight).toMatchObject({
        checked: true,
        status: "failed",
      });
    } finally {
      cleanup();
    }
  }, 15_000);

  test("agent preflight is shared once per workflow agent", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers(outputSchemas);
    try {
      let preflightCalls = 0;
      let generateCalls = 0;
      const agent = {
        id: "shared-preflight",
        model: "ok-model",
        cliEngine: "fake-cli",
        tools: {},
        supportsNativeStructuredOutput: true,
        async preflight() {
          preflightCalls += 1;
          await Bun.sleep(20);
        },
        async generate() {
          generateCalls += 1;
          return { output: { value: generateCalls } };
        },
      };
      const workflow = smithers(() => (
        <Workflow name="preflight-cached-once">
          <Parallel>
            <Task id="left" output={outputs.outputA} agent={agent}>
              left
            </Task>
            <Task id="right" output={outputs.outputB} agent={agent}>
              right
            </Task>
          </Parallel>
        </Workflow>
      ));
      const result = await Effect.runPromise(
        runWorkflow(workflow, {
          input: {},
          maxConcurrency: 2,
        }),
      );
      expect(result.status).toBe("finished");
      expect(preflightCalls).toBe(1);
      expect(generateCalls).toBe(2);
    } finally {
      cleanup();
    }
  }, 15_000);

  test("a failover chain advances past a leading agent that fails preflight auth", async () => {
    // Regression: the implementer chain documents a "guaranteed fallback"
    // (Sonnet behind Codex). A leading agent that fails preflight (e.g. Codex
    // with an invalid OPENAI_API_KEY → 401) is non-retryable for THAT agent,
    // and previously sank the whole task. Selection must advance to the next
    // agent that passes preflight WITHIN the same attempt.
    const { smithers, outputs, cleanup, db } = createTestSmithers(outputSchemas);
    const adapter = new SmithersDb(db);
    try {
      let leadPreflight = 0;
      let leadGenerate = 0;
      let fallbackPreflight = 0;
      let fallbackGenerate = 0;
      const authFailLead = {
        id: "codex-auth-fail",
        model: "gpt-5.5",
        cliEngine: "fake-cli",
        tools: {},
        async preflight() {
          leadPreflight += 1;
          throw new SmithersError("AGENT_CONFIG_INVALID", "OPENAI_API_KEY is invalid (401 Unauthorized)", {
            failureRetryable: false,
            preflight: true,
          });
        },
        async generate() {
          leadGenerate += 1;
          return { output: { value: -1 } };
        },
      };
      const healthyFallback = {
        id: "sonnet-fallback",
        model: "claude-sonnet-5",
        cliEngine: "fake-cli",
        tools: {},
        supportsNativeStructuredOutput: true,
        async preflight() {
          fallbackPreflight += 1;
        },
        async generate() {
          fallbackGenerate += 1;
          return { output: { value: 42 } };
        },
      };
      const workflow = smithers(() => (
        <Workflow name="failover-preflight-advance">
          <Task id="impl" output={outputs.outputA} agent={[authFailLead, healthyFallback]} retries={0}>
            The leading agent cannot authenticate; the fallback must run.
          </Task>
        </Workflow>
      ));
      const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
      expect(result.status).toBe("finished");
      // Failover happens within selection, before any generate. The lead
      // never generates; the fallback runs exactly once.
      expect(leadPreflight).toBe(1);
      expect(leadGenerate).toBe(0);
      expect(fallbackGenerate).toBe(1);
      // A single successful attempt: no retry was needed to reach the fallback.
      const attempts = await adapter.listAttempts(result.runId, "impl", 0);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.state).toBe("finished");
      const meta = JSON.parse(attempts[0]?.metaJson ?? "{}");
      expect(meta.agentId).toBe("sonnet-fallback");
    } finally {
      cleanup();
    }
  }, 15_000);

  test("the final attempt falls back to an earlier healthy agent when the terminal rung is uninstalled", async () => {
    // Regression: attempt N maps to ladder rung N (capped at the last). On
    // the final attempt the mapped rung is the LAST agent; when that agent
    // is uninstalled ("agy not found on PATH") there is no forward
    // candidate, and the run used to burn its final attempt on an agent
    // that could never work. Selection must fall back to the nearest
    // earlier preflight-passing agent.
    const { smithers, outputs, cleanup, db } = createTestSmithers(outputSchemas);
    const adapter = new SmithersDb(db);
    try {
      let healthyGenerate = 0;
      const flakyLead = {
        id: "flaky-lead",
        model: "lead-model",
        cliEngine: "fake-cli",
        tools: {},
        async preflight() {},
        async generate() {
          // Fails attempt 1 so the scheduler retries onto rung 2.
          throw new SmithersError("AGENT_CLI_ERROR", "transient stream failure", {
            failureRetryable: true,
          });
        },
      };
      const healthyMiddle = {
        id: "healthy-middle",
        model: "middle-model",
        cliEngine: "fake-cli",
        tools: {},
        supportsNativeStructuredOutput: true,
        async preflight() {},
        async generate() {
          healthyGenerate += 1;
          if (healthyGenerate === 1) {
            // Fails attempt 2 so the final attempt maps to rung 3.
            throw new SmithersError("AGENT_CLI_ERROR", "transient provider failure", {
              failureRetryable: true,
            });
          }
          return { output: { value: 7 } };
        },
      };
      const uninstalledTerminal = {
        id: "agy-not-installed",
        model: "gemini-3.1-pro-preview",
        cliEngine: "fake-cli",
        tools: {},
        async preflight() {
          throw new SmithersError("AGENT_CONFIG_INVALID", "antigravity: cli_installed=fail: agy not found on PATH", {
            failureRetryable: false,
            preflight: true,
          });
        },
        async generate() {
          throw new Error("must never run");
        },
      };
      const workflow = smithers(() => (
        <Workflow name="terminal-rung-fallback">
          <Task id="impl" output={outputs.outputA} agent={[flakyLead, healthyMiddle, uninstalledTerminal]} retries={2}>
            The terminal rung is uninstalled; the final attempt must reuse an earlier healthy agent.
          </Task>
        </Workflow>
      ));
      const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
      expect(result.status).toBe("finished");
      expect(healthyGenerate).toBe(2);
      const attempts = await adapter.listAttempts(result.runId, "impl", 0);
      const finished = attempts.filter((a) => a.state === "finished");
      expect(finished).toHaveLength(1);
      const meta = JSON.parse(finished[0]?.metaJson ?? "{}");
      expect(meta.agentId).toBe("healthy-middle");
    } finally {
      cleanup();
    }
  }, 20_000);

  test("a failover chain whose every agent fails preflight still fails terminally", async () => {
    const { smithers, outputs, cleanup, db } = createTestSmithers(outputSchemas);
    const adapter = new SmithersDb(db);
    try {
      const makeBroken = (id) => ({
        id,
        model: "bad",
        cliEngine: "fake-cli",
        tools: {},
        async preflight() {
          throw new SmithersError("AGENT_CONFIG_INVALID", "401 invalid_authentication", {
            failureRetryable: false,
            preflight: true,
          });
        },
        async generate() {
          return { output: { value: 0 } };
        },
      });
      const workflow = smithers(() => (
        <Workflow name="failover-all-broken">
          <Task id="impl" output={outputs.outputA} agent={[makeBroken("a"), makeBroken("b")]} retries={0}>
            Both agents are unauthenticated.
          </Task>
        </Workflow>
      ));
      const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
      expect(result.status).toBe("failed");
      const attempts = await adapter.listAttempts(result.runId, "impl", 0);
      expect(attempts).toHaveLength(1);
      const error = JSON.parse(attempts[0]?.errorJson ?? "{}");
      expect(error.code).toBe("AGENT_CONFIG_INVALID");
    } finally {
      cleanup();
    }
  }, 15_000);

  test("Kimi-style AGENT_CONFIG_INVALID stops after a single attempt", async () => {
    const { smithers, outputs, cleanup, db } = createTestSmithers(outputSchemas);
    const adapter = new SmithersDb(db);
    try {
      let callCount = 0;
      const agent = {
        id: "kimi-style-config-invalid",
        tools: {},
        async generate() {
          callCount += 1;
          throw new SmithersError(
            "AGENT_CONFIG_INVALID",
            "OAuth token expired at 2026-04-25T01:00:00Z; auto-refresh failed: invalid_grant. Run `kimi login`.",
            {
              failureRetryable: false,
              agentId: "kimi-style-config-invalid",
              agentEngine: "kimi",
              agentModel: "kimi-k2-instruct",
              command: "kimi",
              underlying: "invalid_grant",
            },
          );
        },
      };
      const workflow = smithers(() => (
        <Workflow name="failure-retryable-false-kimi">
          <Task id="creds-bad" output={outputs.outputA} agent={agent} retries={5}>
            Should not retry — non-retryable config error.
          </Task>
        </Workflow>
      ));
      const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
      expect(result.status).toBe("failed");
      expect(callCount).toBe(1);
      const attempts = await adapter.listAttempts(result.runId, "creds-bad", 0);
      expect(attempts).toHaveLength(1);
    } finally {
      cleanup();
    }
  }, 15_000);

  test("generic SmithersError with details.failureRetryable=false stops retrying", async () => {
    const { smithers, outputs, cleanup, db } = createTestSmithers(outputSchemas);
    const adapter = new SmithersDb(db);
    try {
      let callCount = 0;
      const agent = {
        id: "generic-non-retryable",
        tools: {},
        async generate() {
          callCount += 1;
          throw new SmithersError("AGENT_CLI_ERROR", "Deterministic failure that operator must fix.", {
            failureRetryable: false,
          });
        },
      };
      const workflow = smithers(() => (
        <Workflow name="failure-retryable-false-generic">
          <Task id="bad" output={outputs.outputA} agent={agent} retries={4}>
            Generic non-retryable signal honored.
          </Task>
        </Workflow>
      ));
      const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
      expect(result.status).toBe("failed");
      expect(callCount).toBe(1);
      const attempts = await adapter.listAttempts(result.runId, "bad", 0);
      expect(attempts).toHaveLength(1);
      const meta = JSON.parse(attempts[0].metaJson ?? "{}");
      expect(meta.failureRetryable).toBe(false);
    } finally {
      cleanup();
    }
  }, 15_000);

  test("AGENT_CONFIG_INVALID without details flag stops retrying", async () => {
    const { smithers, outputs, cleanup, db } = createTestSmithers(outputSchemas);
    const adapter = new SmithersDb(db);
    try {
      let callCount = 0;
      const agent = {
        id: "config-invalid-no-details",
        tools: {},
        async generate() {
          callCount += 1;
          throw new SmithersError("AGENT_CONFIG_INVALID", "LLM not set: configure model in agent.");
        },
      };
      const workflow = smithers(() => (
        <Workflow name="config-invalid-no-details">
          <Task id="missing-config" output={outputs.outputA} agent={agent} retries={4}>
            Configuration errors should not retry.
          </Task>
        </Workflow>
      ));
      const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
      expect(result.status).toBe("failed");
      expect(callCount).toBe(1);
      const attempts = await adapter.listAttempts(result.runId, "missing-config", 0);
      expect(attempts).toHaveLength(1);
      const error = JSON.parse(attempts[0].errorJson ?? "{}");
      expect(error.code).toBe("AGENT_CONFIG_INVALID");
      const meta = JSON.parse(attempts[0].metaJson ?? "{}");
      expect(meta.failureRetryable).toBe(false);
    } finally {
      cleanup();
    }
  }, 15_000);

  test("retryable SmithersError still retries normally (sanity)", async () => {
    const { smithers, outputs, cleanup, db } = createTestSmithers(outputSchemas);
    const adapter = new SmithersDb(db);
    try {
      let callCount = 0;
      const agent = {
        id: "retryable-error",
        tools: {},
        async generate() {
          callCount += 1;
          if (callCount < 3) {
            // No failureRetryable=false flag → engine should retry.
            throw new SmithersError("AGENT_CLI_ERROR", `transient ${callCount}`);
          }
          return { output: { value: callCount } };
        },
      };
      const workflow = smithers(() => (
        <Workflow name="retryable-still-retries">
          <Task id="flaky" output={outputs.outputA} agent={agent} retries={5}>
            Retries on plain SmithersError without the flag.
          </Task>
        </Workflow>
      ));
      const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
      expect(result.status).toBe("finished");
      expect(callCount).toBe(3);
      const attempts = await adapter.listAttempts(result.runId, "flaky", 0);
      expect(attempts).toHaveLength(3);
    } finally {
      cleanup();
    }
  }, 30_000);
});

/**
 * Direct unit-style coverage for the compute-task-bridge fix in commit
 * b561fca0f, exercising executeTaskBridge with a compute task that throws a
 * SmithersError with details.failureRetryable=false. The fix added two
 * conditions to compute-task-bridge.js around line 630:
 *   effectiveError?.details?.failureRetryable === false ||
 *   effectiveError?.code === "AGENT_CONFIG_INVALID"
 */
import { ensureSmithersTables } from "@smthrs/db/ensure";
import { EventBus as BridgeEventBus } from "../src/events.js";
import { executeTaskBridge as bridgeExecuteTaskBridge } from "../src/effect/workflow-bridge.js";
import { z as bridgeZ } from "zod";

describe("compute-task-bridge propagates failureRetryable=false", () => {
  test("compute callback throwing failureRetryable=false marks attempt non-retryable", async () => {
    const schema = bridgeZ.object({ value: bridgeZ.number() });
    const { tables, db, cleanup } = createTestSmithers({ out: schema });
    try {
      ensureSmithersTables(db);
      const adapter = new SmithersDb(db);
      const runId = "bridge-compute-non-retryable";
      await adapter.insertRun({
        runId,
        workflowName: "bridge-compute-non-retryable",
        workflowHash: "h",
        status: "running",
        createdAtMs: Date.now(),
      });
      let calls = 0;
      const desc = {
        nodeId: "non-retryable-task",
        ordinal: 0,
        iteration: 0,
        outputTable: tables.out,
        outputTableName: "out",
        outputSchema: schema,
        needsApproval: false,
        skipIf: false,
        retries: 5,
        timeoutMs: null,
        heartbeatTimeoutMs: null,
        continueOnFail: false,
        computeFn: () => {
          calls += 1;
          throw new SmithersError("AGENT_CONFIG_INVALID", "creds expired; refresh failed", { failureRetryable: false });
        },
      };
      const eventBus = new BridgeEventBus({ db: adapter });
      await bridgeExecuteTaskBridge(
        adapter,
        db,
        runId,
        desc,
        new Map([[desc.nodeId, desc]]),
        null,
        eventBus,
        { rootDir: process.cwd(), allowNetwork: false, maxOutputBytes: 1_000_000, toolTimeoutMs: 30_000 },
        "bridge-compute-non-retryable",
        false,
      );
      // Single attempt: the bridge should see failureRetryable=false and
      // not emit NodeRetrying or schedule another execution.
      expect(calls).toBe(1);
      const attempts = await adapter.listAttempts(runId, desc.nodeId, 0);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.state).toBe("failed");
      const meta = JSON.parse(attempts[0]?.metaJson ?? "{}");
      expect(meta.failureRetryable).toBe(false);
    } finally {
      cleanup();
    }
  }, 30_000);

  test("compute callback throwing AGENT_CONFIG_INVALID without details flag is also marked non-retryable", async () => {
    const schema = bridgeZ.object({ value: bridgeZ.number() });
    const { tables, db, cleanup } = createTestSmithers({ out: schema });
    try {
      ensureSmithersTables(db);
      const adapter = new SmithersDb(db);
      const runId = "bridge-compute-config-invalid";
      await adapter.insertRun({
        runId,
        workflowName: "bridge-compute-config-invalid",
        workflowHash: "h",
        status: "running",
        createdAtMs: Date.now(),
      });
      const desc = {
        nodeId: "config-invalid-task",
        ordinal: 0,
        iteration: 0,
        outputTable: tables.out,
        outputTableName: "out",
        outputSchema: schema,
        needsApproval: false,
        skipIf: false,
        retries: 5,
        timeoutMs: null,
        heartbeatTimeoutMs: null,
        continueOnFail: false,
        computeFn: () => {
          // Note: no failureRetryable in details — the bridge fix
          // also short-circuits on `code === "AGENT_CONFIG_INVALID"`.
          throw new SmithersError("AGENT_CONFIG_INVALID", "LLM not set: configure model in agent");
        },
      };
      const eventBus = new BridgeEventBus({ db: adapter });
      await bridgeExecuteTaskBridge(
        adapter,
        db,
        runId,
        desc,
        new Map([[desc.nodeId, desc]]),
        null,
        eventBus,
        { rootDir: process.cwd(), allowNetwork: false, maxOutputBytes: 1_000_000, toolTimeoutMs: 30_000 },
        "bridge-compute-config-invalid",
        false,
      );
      const attempts = await adapter.listAttempts(runId, desc.nodeId, 0);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.state).toBe("failed");
      const meta = JSON.parse(attempts[0]?.metaJson ?? "{}");
      expect(meta.failureRetryable).toBe(false);
    } finally {
      cleanup();
    }
  }, 30_000);

  test("plain compute failure without flag retains the default retry behaviour", async () => {
    const schema = bridgeZ.object({ value: bridgeZ.number() });
    const { tables, db, cleanup } = createTestSmithers({ out: schema });
    try {
      ensureSmithersTables(db);
      const adapter = new SmithersDb(db);
      const runId = "bridge-compute-retryable";
      await adapter.insertRun({
        runId,
        workflowName: "bridge-compute-retryable",
        workflowHash: "h",
        status: "running",
        createdAtMs: Date.now(),
      });
      const desc = {
        nodeId: "retryable-task",
        ordinal: 0,
        iteration: 0,
        outputTable: tables.out,
        outputTableName: "out",
        outputSchema: schema,
        needsApproval: false,
        skipIf: false,
        retries: 1,
        timeoutMs: null,
        heartbeatTimeoutMs: null,
        continueOnFail: false,
        computeFn: () => {
          throw new Error("boring transient error");
        },
      };
      const eventBus = new BridgeEventBus({ db: adapter });
      await bridgeExecuteTaskBridge(
        adapter,
        db,
        runId,
        desc,
        new Map([[desc.nodeId, desc]]),
        null,
        eventBus,
        { rootDir: process.cwd(), allowNetwork: false, maxOutputBytes: 1_000_000, toolTimeoutMs: 30_000 },
        "bridge-compute-retryable",
        false,
      );
      const attempts = await adapter.listAttempts(runId, desc.nodeId, 0);
      expect(attempts).toHaveLength(1);
      const meta = JSON.parse(attempts[0]?.metaJson ?? "{}");
      // Without the flag and not AGENT_CONFIG_INVALID, the bridge should
      // NOT mark it non-retryable.
      expect(meta.failureRetryable).not.toBe(false);
    } finally {
      cleanup();
    }
  }, 30_000);
});
