/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { Task, Workflow, runWorkflow } from "smithers-orchestrator";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { z } from "zod";
import { Effect } from "effect";
import { dirname } from "node:path";

// Tasks default to three automatic output-format/schema correction calls.
// Corrections re-invoke the same agent and do not count as task retries.
const MAX_SCHEMA_RETRIES = 3;
const TIMEOUT_MS = 30_000;

/**
 * Build an agent that returns invalid JSON (fails the zod schema) `failures`
 * times, then valid output. Counts the total number of generate() calls.
 * @param {number} failures
 */
function makeFlakyAgent(failures) {
  const counter = { calls: 0 };
  const agent = {
    id: "flaky",
    tools: {},
    generate: async (_args) => {
      counter.calls += 1;
      if (counter.calls <= failures) {
        // Returns parseable JSON but it doesn't match the zod schema
        // (schema expects { value: number }; we return { wrong: "x" }).
        return {
          text: '{"wrong":"x"}',
          output: { wrong: "x" },
          response: { messages: [{ role: "assistant", content: '{"wrong":"x"}' }] },
        };
      }
      return {
        text: '{"value":42}',
        output: { value: 42 },
        response: { messages: [{ role: "assistant", content: '{"value":42}' }] },
      };
    },
  };
  return { agent, counter };
}

describe("maxSchemaRetries output-correction budget", () => {
  test(
    "zero disables every correction call, including malformed JSON recovery",
    async () => {
      const { smithers, outputs, db, cleanup } = createTestSmithers({
        out: z.object({ value: z.number() }),
      });
      let calls = 0;
      const agent = {
        id: "no-output-corrections",
        tools: {},
        generate: async () => {
          calls += 1;
          return { text: "completed the task without structured output" };
        },
      };
      const workflow = smithers(() => (
        <Workflow name="schema-corrections-disabled">
          <Task id="t" output={outputs.out} agent={agent} maxSchemaRetries={0} noRetry>
            do work
          </Task>
        </Workflow>
      ));

      const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));

      expect(result.status).toBe("failed");
      expect(calls).toBe(1);
      const adapter = new SmithersDb(db);
      const attempts = await adapter.listAttempts(result.runId, "t", 0);
      const finalAttempt = attempts[attempts.length - 1];
      expect(JSON.parse(finalAttempt?.metaJson ?? "{}")).toMatchObject({
        maxSchemaRetries: 0,
        schemaCorrectionAttempts: 0,
      });
      expect(JSON.parse(finalAttempt?.errorJson ?? "{}")).toMatchObject({
        code: "INVALID_OUTPUT",
        details: {
          maxSchemaRetries: 0,
          schemaRetryAttempts: 0,
        },
      });
      cleanup();
    },
    TIMEOUT_MS,
  );

  test(
    "format and schema corrections consume one shared budget",
    async () => {
      const { smithers, outputs, db, cleanup } = createTestSmithers({
        out: z.object({ value: z.number() }),
      });
      let calls = 0;
      const agent = {
        id: "shared-output-correction-budget",
        tools: {},
        generate: async () => {
          calls += 1;
          if (calls === 1) {
            return { text: "completed the task without structured output" };
          }
          if (calls === 2) {
            return { text: '{"value":"still-wrong"}' };
          }
          return { text: '{"value":42}' };
        },
      };
      const workflow = smithers(() => (
        <Workflow name="shared-schema-correction-budget">
          <Task id="t" output={outputs.out} agent={agent} maxSchemaRetries={1} noRetry>
            do work
          </Task>
        </Workflow>
      ));

      const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));

      expect(result.status).toBe("failed");
      expect(calls).toBe(2);
      const adapter = new SmithersDb(db);
      const attempts = await adapter.listAttempts(result.runId, "t", 0);
      const finalAttempt = attempts[attempts.length - 1];
      expect(JSON.parse(finalAttempt?.metaJson ?? "{}")).toMatchObject({
        maxSchemaRetries: 1,
        schemaCorrectionAttempts: 1,
      });
      expect(JSON.parse(finalAttempt?.errorJson ?? "{}")).toMatchObject({
        code: "INVALID_OUTPUT",
        details: {
          maxSchemaRetries: 1,
          schemaRetryAttempts: 1,
        },
      });
      cleanup();
    },
    TIMEOUT_MS,
  );

  test(
    "repair and schema retries preserve task execution context",
    async () => {
      const { smithers, outputs, dbPath, cleanup } = createTestSmithers({
        out: z.object({ value: z.number() }),
      });
      const calls = [];
      let generateCount = 0;
      const agent = {
        id: "context-aware-retries",
        tools: {},
        generate: async (args) => {
          calls.push(args);
          generateCount += 1;
          if (generateCount === 1) {
            return { text: "I completed the work, but forgot the JSON." };
          }
          if (generateCount === 2) {
            return { text: '{"value":"wrong"}' };
          }
          return { text: '{"value":42}' };
        },
      };
      const workflow = smithers(() => (
        <Workflow name="retry-context">
          <Task id="t" output={outputs.out} agent={agent}>
            do work
          </Task>
        </Workflow>
      ));
      const runId = "retry-context-run";
      const rootDir = dirname(dbPath);
      const result = await Effect.runPromise(
        runWorkflow(workflow, {
          input: {},
          runId,
          rootDir,
          maxOutputBytes: 12345,
        }),
      );
      expect(result.status).toBe("finished");
      expect(calls).toHaveLength(3);
      for (const args of calls.slice(1)) {
        expect(args).toMatchObject({
          rootDir,
          maxOutputBytes: 12345,
          taskContext: {
            runId,
            nodeId: "t",
            iteration: 0,
            attempt: 1,
          },
        });
      }
      cleanup();
    },
    TIMEOUT_MS,
  );

  test(
    "agent recovers within retry budget (failures=2 < MAX) succeeds",
    async () => {
      const { smithers, outputs, cleanup } = createTestSmithers({
        out: z.object({ value: z.number() }),
      });
      const { agent, counter } = makeFlakyAgent(MAX_SCHEMA_RETRIES - 1);
      const workflow = smithers(() => (
        <Workflow name="schema-retry-recovers">
          <Task id="t" output={outputs.out} agent={agent}>
            do work
          </Task>
        </Workflow>
      ));
      const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
      expect(result.status).toBe("finished");
      // Initial call + (MAX-1) retries = MAX calls.
      expect(counter.calls).toBe(MAX_SCHEMA_RETRIES);
      cleanup();
    },
    TIMEOUT_MS,
  );

  test(
    "agent recovers exactly at the boundary (failures=MAX) succeeds",
    async () => {
      const { smithers, outputs, cleanup } = createTestSmithers({
        out: z.object({ value: z.number() }),
      });
      const { agent, counter } = makeFlakyAgent(MAX_SCHEMA_RETRIES);
      const workflow = smithers(() => (
        <Workflow name="schema-retry-boundary">
          <Task id="t" output={outputs.out} agent={agent}>
            do work
          </Task>
        </Workflow>
      ));
      const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
      expect(result.status).toBe("finished");
      // Initial call + MAX retries = MAX+1 calls.
      expect(counter.calls).toBe(MAX_SCHEMA_RETRIES + 1);
      cleanup();
    },
    TIMEOUT_MS,
  );

  test(
    "agent never recovers (failures=MAX+1) exhausts retries and the task fails INVALID_OUTPUT",
    async () => {
      const { smithers, outputs, db, cleanup } = createTestSmithers({
        out: z.object({ value: z.number() }),
      });
      // Always-bad agent: returns invalid output on every call.
      const calls = { count: 0 };
      const badAgent = {
        id: "always-bad",
        tools: {},
        generate: async () => {
          calls.count += 1;
          return {
            text: '{"wrong":"x"}',
            output: { wrong: "x" },
            response: { messages: [{ role: "assistant", content: '{"wrong":"x"}' }] },
          };
        },
      };
      const workflow = smithers(() => (
        <Workflow name="schema-retry-exhausts">
          <Task id="t" output={outputs.out} agent={badAgent} noRetry>
            do work
          </Task>
        </Workflow>
      ));
      const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
      expect(result.status).toBe("failed");
      // Initial call + MAX retries = MAX+1 calls.
      expect(calls.count).toBe(MAX_SCHEMA_RETRIES + 1);
      const adapter = new SmithersDb(db);
      const attempts = await adapter.listAttempts(result.runId, "t", 0);
      const errorJson = JSON.parse(attempts[attempts.length - 1]?.errorJson ?? "{}");
      expect(errorJson.code).toBe("INVALID_OUTPUT");
      cleanup();
    },
    TIMEOUT_MS,
  );

  test(
    "schema retries renew per task attempt",
    async () => {
      const { smithers, outputs, cleanup } = createTestSmithers({
        out: z.object({ value: z.number() }),
      });
      // Track each generate() call. A schema-retry call passes `messages`;
      // a fresh task attempt passes `prompt` (and no `messages` from the
      // engine's inner conversation). Use that to distinguish.
      let taskAttempts = 0;
      let schemaRetriesThisAttempt = 0;
      const totalCalls = { value: 0 };
      const agent = {
        id: "exhaust-then-recover",
        tools: {},
        generate: async (args) => {
          totalCalls.value += 1;
          // The initial generate() carries the task callbacks and prompt;
          // schema-repair generations carry the resumed messages and the
          // same callbacks so repair activity remains observable.
          const isFreshAttempt = typeof args?.prompt === "string" && !Array.isArray(args?.messages);
          if (isFreshAttempt) {
            taskAttempts += 1;
            schemaRetriesThisAttempt = 0;
          } else {
            schemaRetriesThisAttempt += 1;
          }
          // First task attempt: always invalid (exhaust schema retries).
          if (taskAttempts === 1) {
            return {
              text: '{"wrong":"x"}',
              output: { wrong: "x" },
              response: { messages: [{ role: "assistant", content: '{"wrong":"x"}' }] },
            };
          }
          // Second task attempt: valid on first try.
          return {
            text: '{"value":7}',
            output: { value: 7 },
            response: { messages: [{ role: "assistant", content: '{"value":7}' }] },
          };
        },
      };
      const workflow = smithers(() => (
        <Workflow name="schema-retry-vs-task-retry">
          <Task id="t" output={outputs.out} agent={agent} retries={1}>
            do work
          </Task>
        </Workflow>
      ));
      const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
      expect(result.status).toBe("finished");
      // Attempt 1: 1 initial + MAX_SCHEMA_RETRIES retries = 4 calls (all bad).
      // Attempt 2: 1 initial (valid) = 1 call. Total = 5.
      expect(totalCalls.value).toBe(MAX_SCHEMA_RETRIES + 1 + 1);
      expect(taskAttempts).toBe(2);
      cleanup();
    },
    TIMEOUT_MS,
  );

  test(
    "no-JSON responses consume the whole correction budget before failing",
    async () => {
      const { smithers, outputs, db, cleanup } = createTestSmithers({
        out: z.object({ value: z.number() }),
      });
      let calls = 0;
      const agent = {
        id: "never-json",
        tools: {},
        async generate() {
          calls += 1;
          return { text: "prose only, no JSON here" };
        },
      };
      const workflow = smithers(() => (
        <Workflow name="format-corrections-exhaust">
          <Task id="t" output={outputs.out} agent={agent} noRetry>
            do work
          </Task>
        </Workflow>
      ));
      const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
      expect(result.status).toBe("failed");
      // Initial call + MAX_SCHEMA_RETRIES format corrections = MAX+1 calls;
      // the attempt only fails once the whole correction budget is spent.
      expect(calls).toBe(MAX_SCHEMA_RETRIES + 1);
      const adapter = new SmithersDb(db);
      const attempts = await adapter.listAttempts(result.runId, "t", 0);
      const errorJson = JSON.parse(attempts[attempts.length - 1]?.errorJson ?? "{}");
      expect(errorJson.code).toBe("INVALID_OUTPUT");
      expect(errorJson.details).toMatchObject({
        schemaRetryAttempts: MAX_SCHEMA_RETRIES,
        maxSchemaRetries: MAX_SCHEMA_RETRIES,
      });
      cleanup();
    },
    TIMEOUT_MS,
  );

  test(
    "CLI agents resume their session for JSON-format corrections",
    async () => {
      const { smithers, outputs, cleanup } = createTestSmithers({
        out: z.object({ value: z.number() }),
      });
      const calls = [];
      const agent = {
        id: "cli-format-corrections",
        cliEngine: "claude-code",
        tools: {},
        /** @param {any} args */
        async generate(args) {
          calls.push(args);
          if (calls.length === 1) {
            args.onEvent?.({
              type: "started",
              engine: "claude-code",
              title: "Claude Code",
              resume: "cli-session-1",
            });
            return { text: "I finished the work but wrote prose instead of JSON." };
          }
          if (calls.length === 2) {
            // Resumed CLI sessions get a fresh session id from the CLI's
            // init event; later corrections must resume the LATEST one.
            args.onEvent?.({
              type: "started",
              engine: "claude-code",
              title: "Claude Code",
              resume: "cli-session-2",
            });
            return { text: "Still prose, still no JSON." };
          }
          return { text: '{"value":42}' };
        },
      };
      const workflow = smithers(() => (
        <Workflow name="cli-format-corrections">
          <Task id="t" output={outputs.out} agent={agent} noRetry>
            do work
          </Task>
        </Workflow>
      ));
      const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
      expect(result.status).toBe("finished");
      expect(calls).toHaveLength(3);
      // Corrections resume the agent's own CLI session instead of spawning a
      // context-free repair process.
      expect(calls[0].resumeSession).toBeUndefined();
      expect(calls[1].resumeSession).toBe("cli-session-1");
      expect(calls[2].resumeSession).toBe("cli-session-2");
      // A resumed session already holds the task context, so the correction
      // prompt only restates the output contract.
      expect(typeof calls[1].prompt).toBe("string");
      expect(calls[1].prompt).not.toContain("You were given this task");
      expect(calls[1].prompt).toContain("ONLY a valid JSON object");
      cleanup();
    },
    TIMEOUT_MS,
  );

  test(
    "CLI agents resume their session for schema-validation corrections",
    async () => {
      const { smithers, outputs, cleanup } = createTestSmithers({
        out: z.object({ value: z.number() }),
      });
      const calls = [];
      const agent = {
        id: "cli-schema-corrections",
        cliEngine: "claude-code",
        tools: {},
        /** @param {any} args */
        async generate(args) {
          calls.push(args);
          if (calls.length === 1) {
            args.onEvent?.({
              type: "started",
              engine: "claude-code",
              title: "Claude Code",
              resume: "cli-session-a",
            });
            return { text: '{"wrong":"x"}' };
          }
          return { text: '{"value":7}' };
        },
      };
      const workflow = smithers(() => (
        <Workflow name="cli-schema-corrections">
          <Task id="t" output={outputs.out} agent={agent} noRetry>
            do work
          </Task>
        </Workflow>
      ));
      const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
      expect(result.status).toBe("finished");
      expect(calls).toHaveLength(2);
      // The validation retry resumes the CLI session with only the
      // correction prompt instead of replaying a flattened transcript.
      const retryArgs = calls[1];
      expect(retryArgs.resumeSession).toBe("cli-session-a");
      expect(retryArgs.messages).toBeUndefined();
      expect(typeof retryArgs.prompt).toBe("string");
      expect(retryArgs.prompt).toContain("didn't match the required schema");
      cleanup();
    },
    TIMEOUT_MS,
  );
});
