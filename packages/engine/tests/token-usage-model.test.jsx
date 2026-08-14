/** @jsxImportSource smthrs */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Workflow, Task, runWorkflow } from "smthrs";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { z } from "zod";
import { Effect } from "effect";
import { SmithersError } from "@smthrs/errors/SmithersError";

const schemas = { a: z.object({ v: z.number() }) };

/**
 * Fake agent that reports token usage and a resolved response.modelId, the
 * authoritative id the engine should attribute the usage to.
 *
 * @param {string} id
 * @param {string | undefined} model
 * @param {string} responseModelId
 */
function usageAgent(id, model, responseModelId) {
  return {
    id,
    ...(model !== undefined ? { model } : {}),
    tools: {},
    generate: async () => ({
      output: { v: 1 },
      usage: {
        inputTokens: 10,
        inputTokenDetails: { noCacheTokens: 2, cacheReadTokens: 7, cacheWriteTokens: 1 },
        outputTokens: 5,
        outputTokenDetails: { reasoningTokens: 2 },
      },
      response: { modelId: responseModelId },
    }),
  };
}

/**
 * @param {string} dbPath
 * @returns {Array<Record<string, unknown>>}
 */
function readTokenUsageEvents(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db.query("SELECT payload_json FROM _smithers_events WHERE type = 'TokenUsageReported'").all();
    return rows.map((r) => JSON.parse(r.payload_json));
  } finally {
    db.close();
  }
}

describe("TokenUsageReported model attribution", () => {
  test("attributes usage to the resolved response.modelId", async () => {
    const { smithers, outputs, dbPath, cleanup } = createTestSmithers(schemas);
    try {
      const workflow = smithers(() => (
        <Workflow name="token-usage-model">
          <Task id="t" output={outputs.a} agent={usageAgent("agent-1", undefined, "claude-opus-test")}>
            compute
          </Task>
        </Workflow>
      ));
      const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
      expect(result.status).toBe("finished");
      const events = readTokenUsageEvents(dbPath);
      expect(events.length).toBeGreaterThan(0);
      expect(events.every((e) => e.model === "claude-opus-test")).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("does not attribute usage to a CLI agent's random-UUID id", async () => {
    const { smithers, outputs, dbPath, cleanup } = createTestSmithers(schemas);
    const uuidId = "5f65b75c-e0c0-4780-d037-080678a6d78f";
    try {
      const workflow = smithers(() => (
        <Workflow name="token-usage-uuid">
          <Task id="t" output={outputs.a} agent={usageAgent(uuidId, undefined, "gpt-5.4-codex")}>
            compute
          </Task>
        </Workflow>
      ));
      const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
      expect(result.status).toBe("finished");
      const events = readTokenUsageEvents(dbPath);
      expect(events.length).toBeGreaterThan(0);
      for (const e of events) {
        expect(e.model).toBe("gpt-5.4-codex");
        expect(e.model).not.toBe(uuidId);
      }
    } finally {
      cleanup();
    }
  });

  test("emits usage carried by a failed attempt's partial result", async () => {
    const { smithers, outputs, dbPath, cleanup } = createTestSmithers(schemas);
    try {
      const agent = {
        id: "failed-agent",
        model: "fallback-model",
        tools: {},
        async generate() {
          const error = /** @type {any} */ (
            new SmithersError("AGENT_CONFIG_INVALID", "provider failed after reporting usage", {
              failureRetryable: false,
            })
          );
          error.result = {
            usage: {
              promptTokens: 17,
              completionTokens: 4,
              inputTokenDetails: { noCacheTokens: 7, cacheReadTokens: 8, cacheWriteTokens: 2 },
              outputTokenDetails: { reasoningTokens: 3 },
            },
            response: { modelId: "claude-sonnet-5" },
          };
          throw error;
        },
      };
      const workflow = smithers(() => (
        <Workflow name="token-usage-failed-attempt">
          <Task id="t" output={outputs.a} agent={agent} retries={3}>
            fail after provider usage
          </Task>
        </Workflow>
      ));
      const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
      expect(result.status).toBe("failed");
      const events = readTokenUsageEvents(dbPath);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        runId: result.runId,
        nodeId: "t",
        iteration: 0,
        attempt: 1,
        model: "claude-sonnet-5",
        agent: "failed-agent",
        inputTokens: 17,
        freshInputTokens: 7,
        outputTokens: 4,
        cacheReadTokens: 8,
        cacheWriteTokens: 2,
        reasoningTokens: 3,
      });
      expect(events[0].costUsd).toBeCloseTo(0.0000909, 12);
      // A failed attempt still burned tokens, so it has to reach
      // `_smithers_run_usage` too — otherwise `smithers usage --run` undercounts
      // exactly the runs whose cost the operator most wants explained (#1464
      // AWF-6).
      const usageRows = readRunUsageRows(dbPath);
      expect(usageRows).toMatchObject([
        {
          run_id: result.runId,
          node_id: "t",
          iteration: 0,
          attempt: 1,
          model: "claude-sonnet-5",
          input_tokens: 17,
          fresh_input_tokens: 7,
          output_tokens: 4,
          cache_read_tokens: 8,
          cache_write_tokens: 2,
          reasoning_tokens: 3,
        },
      ]);
      expect(usageRows[0].cost_usd).toBeCloseTo(0.0000909, 12);
    } finally {
      cleanup();
    }
  });

  test("a throwing usage getter never replaces the provider error", async () => {
    const { smithers, outputs, dbPath, cleanup } = createTestSmithers(schemas);
    try {
      const agent = {
        id: "exotic-error-agent",
        tools: {},
        async generate() {
          const error = new SmithersError("AGENT_CONFIG_INVALID", "original provider failure", {
            failureRetryable: false,
          });
          Object.defineProperty(error, "usage", {
            get() {
              throw new Error("telemetry getter exploded");
            },
          });
          throw error;
        },
      };
      const workflow = smithers(() => (
        <Workflow name="token-usage-throwing-getter">
          <Task id="t" output={outputs.a} agent={agent}>
            fail with exotic error
          </Task>
        </Workflow>
      ));

      const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
      expect(result.status).toBe("failed");
      expect(result.error?.cause).toMatchObject({
        code: "AGENT_CONFIG_INVALID",
        message: expect.stringContaining("original provider failure"),
      });
      expect(JSON.stringify(result.error)).not.toContain("telemetry getter exploded");
      expect(readTokenUsageEvents(dbPath)).toEqual([]);
    } finally {
      cleanup();
    }
  });
});

/**
 * @param {string} dbPath
 * @returns {Array<Record<string, unknown>>}
 */
function readRunUsageRows(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.query("SELECT * FROM _smithers_run_usage ORDER BY node_id").all();
  } finally {
    db.close();
  }
}

describe("per-run token usage table (#1464 AWF-6)", () => {
  test("a finished run's token total is queryable without replaying the event log", async () => {
    const { smithers, outputs, dbPath, cleanup } = createTestSmithers(schemas);
    try {
      const workflow = smithers(() => (
        <Workflow name="run-usage">
          <Task id="one" output={outputs.a} agent={usageAgent("agent-1", undefined, "claude-opus-test")}>
            compute
          </Task>
          <Task id="two" output={outputs.a} agent={usageAgent("agent-2", undefined, "claude-opus-test")}>
            compute again
          </Task>
        </Workflow>
      ));
      const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
      expect(result.status).toBe("finished");
      const rows = readRunUsageRows(dbPath);
      expect(rows.map((row) => row.node_id)).toEqual(["one", "two"]);
      // usageAgent reports 10 in / 5 out per task, so the run total is a SUM
      // over the table rather than a scan of _smithers_events.payload_json.
      const db = new Database(dbPath, { readonly: true });
      try {
        const total = db
          .query(
            "SELECT SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens FROM _smithers_run_usage",
          )
          .get();
        expect(total).toMatchObject({ input_tokens: 20, output_tokens: 10 });
      } finally {
        db.close();
      }
      expect(rows.every((row) => row.model === "claude-opus-test")).toBe(true);
      expect(rows.every((row) => row.fresh_input_tokens === 2)).toBe(true);
    } finally {
      cleanup();
    }
  });
});
