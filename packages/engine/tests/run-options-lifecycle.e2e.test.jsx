/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { SmithersDb, Task, Workflow, runWorkflow } from "smithers-orchestrator";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { outputSchemas } from "../../smithers/tests/schema.js";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { Effect } from "effect";

// Mirrors RUN_WORKFLOW_RUN_ID_MAX_LENGTH / RUN_WORKFLOW_WORKFLOW_PATH_MAX_LENGTH
// in engine.js (not exported), to pin the limit ± 1 boundaries.
const RUN_ID_MAX_LENGTH = 256;
const WORKFLOW_PATH_MAX_LENGTH = 4096;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const TIMEOUT_MS = 30_000;

function buildRuntime() {
  const runtime = createTestSmithers(outputSchemas);
  const workflow = runtime.smithers(() => (
    <Workflow name="run-options-lifecycle">
      <Task id="t" output={runtime.outputs.outputA}>
        {{ value: 1 }}
      </Task>
    </Workflow>
  ));
  ensureSmithersTables(runtime.db);
  return { ...runtime, workflow, adapter: new SmithersDb(runtime.db) };
}

/**
 * Run workflow expecting a rejection from option validation (these throw
 * before the engine starts, so runPromise rejects instead of returning a
 * failed RunResult).
 * @param {unknown} workflow
 * @param {Record<string, unknown>} opts
 */
async function runExpectingError(workflow, opts) {
  try {
    await Effect.runPromise(runWorkflow(/** @type {any} */ (workflow), /** @type {any} */ (opts)));
    throw new Error("expected runWorkflow to fail");
  } catch (error) {
    return error;
  }
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function fullErrorText(error) {
  const err = /** @type {any} */ (error);
  return [err?.message, err?.cause?.message, String(err)].filter(Boolean).join(" || ");
}

describe("runWorkflow runId option", () => {
  test(
    "explicit runId override is honored and persisted to the run row",
    async () => {
      const { workflow, adapter, cleanup } = buildRuntime();
      try {
        const runId = "explicit-run-id-override";
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId }));
        expect(result.status).toBe("finished");
        expect(result.runId).toBe(runId);
        const run = await Effect.runPromise(adapter.getRun(runId));
        expect(run?.runId).toBe(runId);
        expect(run?.status).toBe("finished");
        expect(result.failedChildren).toBeUndefined();
      } finally {
        cleanup();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "generated runId falls back to a UUID when omitted",
    async () => {
      const { workflow, adapter, cleanup } = buildRuntime();
      try {
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        expect(result.status).toBe("finished");
        expect(result.runId).toMatch(UUID_RE);
        const run = await Effect.runPromise(adapter.getRun(result.runId));
        expect(run?.runId).toBe(result.runId);
      } finally {
        cleanup();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "runId at the 256-char limit is accepted",
    async () => {
      const { workflow, cleanup } = buildRuntime();
      try {
        const runId = "r".repeat(RUN_ID_MAX_LENGTH);
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId }));
        expect(result.status).toBe("finished");
        expect(result.runId).toBe(runId);
      } finally {
        cleanup();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "runId over the 256-char limit is rejected before any run row is written",
    async () => {
      const { workflow, adapter, cleanup } = buildRuntime();
      try {
        const runId = "r".repeat(RUN_ID_MAX_LENGTH + 1);
        const error = await runExpectingError(workflow, { input: {}, runId });
        const text = fullErrorText(error);
        expect(text).toContain("runId");
        expect(text).toContain(`maximum length of ${RUN_ID_MAX_LENGTH}`);
        const run = await Effect.runPromise(adapter.getRun(runId));
        expect(run).toBeFalsy();
      } finally {
        cleanup();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "workflowPath over the 4096-char limit is rejected",
    async () => {
      const { workflow, cleanup } = buildRuntime();
      try {
        const workflowPath = "p".repeat(WORKFLOW_PATH_MAX_LENGTH + 1);
        const error = await runExpectingError(workflow, {
          input: {},
          workflowPath,
        });
        const text = fullErrorText(error);
        expect(text).toContain("workflowPath");
        expect(text).toContain(`maximum length of ${WORKFLOW_PATH_MAX_LENGTH}`);
      } finally {
        cleanup();
      }
    },
    TIMEOUT_MS,
  );
});

describe("runWorkflow reserved input.runId column", () => {
  test(
    "input.runId mismatching the runId override fails the run with INVALID_INPUT",
    async () => {
      const { workflow, cleanup } = buildRuntime();
      try {
        const result = await Effect.runPromise(
          runWorkflow(workflow, {
            input: { runId: "some-other-run" },
            runId: "the-actual-run",
          }),
        );
        expect(result.status).toBe("failed");
        expect(result.error).toMatchObject({ code: "INVALID_INPUT" });
        expect(String(result.error?.message ?? "")).toContain("Input runId does not match provided runId");
      } finally {
        cleanup();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "input.runId matching the runId override is accepted",
    async () => {
      const { workflow, cleanup } = buildRuntime();
      try {
        const runId = "matching-input-run-id";
        const result = await Effect.runPromise(runWorkflow(workflow, { input: { runId }, runId }));
        expect(result.status).toBe("finished");
        expect(result.runId).toBe(runId);
      } finally {
        cleanup();
      }
    },
    TIMEOUT_MS,
  );
});

describe("runWorkflow config persistence", () => {
  test(
    "persists normalized startedBy, reserves config.startedBy, and preserves it on resume",
    async () => {
      const { workflow, adapter, cleanup } = buildRuntime();
      try {
        const runId = "started-by-lifecycle";
        const result = await Effect.runPromise(
          runWorkflow(workflow, {
            input: {},
            runId,
            startedBy: { harness: " codex ", sessionId: " thread-1 ", prompt: "launch context" },
            config: { startedBy: { harness: "forbidden" } },
          }),
        );
        expect(result.status).toBe("finished");
        let config = JSON.parse((await Effect.runPromise(adapter.getRun(runId)))?.configJson ?? "{}");
        expect(config.startedBy).toEqual({ harness: "codex", sessionId: "thread-1", prompt: "launch context" });

        await Effect.runPromise(
          runWorkflow(workflow, {
            input: {},
            runId,
            resume: true,
            force: true,
            startedBy: { harness: "claude-code", sessionId: "new-session" },
          }),
        );
        config = JSON.parse((await Effect.runPromise(adapter.getRun(runId)))?.configJson ?? "{}");
        expect(config.startedBy).toEqual({ harness: "codex", sessionId: "thread-1", prompt: "launch context" });
      } finally {
        cleanup();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "omits startedBy when absent and visibly clips its explicit prompt",
    async () => {
      const { workflow, adapter, cleanup } = buildRuntime();
      try {
        const absent = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId: "started-by-absent" }));
        expect(
          JSON.parse((await Effect.runPromise(adapter.getRun(absent.runId)))?.configJson ?? "{}").startedBy,
        ).toBeUndefined();
        const clipped = await Effect.runPromise(
          runWorkflow(workflow, {
            input: {},
            runId: "started-by-clipped",
            startedBy: { prompt: "😀".repeat(8_193) },
          }),
        );
        const prompt = JSON.parse((await Effect.runPromise(adapter.getRun(clipped.runId)))?.configJson ?? "{}")
          .startedBy.prompt;
        expect(Array.from(prompt)).toHaveLength(8_192);
        expect(prompt.endsWith("…")).toBe(true);
      } finally {
        cleanup();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "cliAgentToolsDefault persists into the run configJson",
    async () => {
      const { workflow, adapter, cleanup } = buildRuntime();
      try {
        const runId = "cli-agent-tools-default-run";
        const result = await Effect.runPromise(
          runWorkflow(workflow, {
            input: {},
            runId,
            cliAgentToolsDefault: "explicit-only",
          }),
        );
        expect(result.status).toBe("finished");
        const run = await Effect.runPromise(adapter.getRun(runId));
        const config = JSON.parse(run?.configJson ?? "{}");
        expect(config.cliAgentToolsDefault).toBe("explicit-only");
      } finally {
        cleanup();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "cliAgentToolsDefault is omitted from configJson when not provided",
    async () => {
      const { workflow, adapter, cleanup } = buildRuntime();
      try {
        const runId = "cli-agent-tools-default-absent";
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId }));
        expect(result.status).toBe("finished");
        const run = await Effect.runPromise(adapter.getRun(runId));
        const config = JSON.parse(run?.configJson ?? "{}");
        expect("cliAgentToolsDefault" in config).toBe(false);
      } finally {
        cleanup();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "allowNetwork and concurrency/output limits persist into configJson",
    async () => {
      const { workflow, adapter, cleanup } = buildRuntime();
      try {
        const runId = "run-config-limits";
        const result = await Effect.runPromise(
          runWorkflow(workflow, {
            input: {},
            runId,
            allowNetwork: true,
            maxConcurrency: 2,
            maxOutputBytes: 4096,
          }),
        );
        expect(result.status).toBe("finished");
        const run = await Effect.runPromise(adapter.getRun(runId));
        const config = JSON.parse(run?.configJson ?? "{}");
        expect(config.allowNetwork).toBe(true);
        expect(config.maxConcurrency).toBe(2);
        expect(config.maxOutputBytes).toBe(4096);
      } finally {
        cleanup();
      }
    },
    TIMEOUT_MS,
  );
});

describe("runWorkflow failed-children reporting", () => {
  test(
    "a finished run carries tolerated child failures onto the result and RunFinished event",
    async () => {
      const runtime = createTestSmithers(outputSchemas);
      ensureSmithersTables(runtime.db);
      const adapter = new SmithersDb(runtime.db);
      try {
        const failingAgent = {
          id: "always-fails-agent",
          tools: {},
          async generate() {
            throw new Error("deliberate child failure");
          },
        };
        const workflow = runtime.smithers(() => (
          <Workflow name="failed-children-reporting">
            <Task id="bad" output={runtime.outputs.outputA} agent={failingAgent} continueOnFail>
              Fail once, tolerated.
            </Task>
            <Task id="good" output={runtime.outputs.outputB}>
              {{ value: 2 }}
            </Task>
          </Workflow>
        ));
        const runId = "failed-children-run";
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId }));
        expect(result.status).toBe("finished");
        expect(result.failedChildren).toBe(1);
        expect(result.failedChildKeys).toEqual([expect.stringContaining("bad")]);
        const finished = await Effect.runPromise(adapter.listEventsByType(runId, "RunFinished"));
        expect(finished).toHaveLength(1);
        const payload = JSON.parse(finished[0]?.payloadJson ?? "{}");
        expect(payload.failedChildren).toBe(1);
      } finally {
        runtime.cleanup();
      }
    },
    TIMEOUT_MS,
  );
});

describe("runWorkflow resume status validation", () => {
  test(
    "resume rejects a run parked in a non-resumable status with RUN_NOT_RESUMABLE",
    async () => {
      const { workflow, adapter, cleanup } = buildRuntime();
      try {
        const runId = "resume-non-resumable-status";
        const first = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId }));
        expect(first.status).toBe("finished");
        // "continued" is the one persistable status outside the engine's
        // resumable set: a continued-as-new run's successor owns the
        // lineage, so resuming the predecessor must be refused.
        await Effect.runPromise(adapter.updateRun(runId, { status: "continued" }));
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId, resume: true }));
        expect(result.status).toBe("failed");
        expect(result.error).toMatchObject({ code: "RUN_NOT_RESUMABLE" });
        expect(String(result.error?.message ?? "")).toContain("continued");
      } finally {
        cleanup();
      }
    },
    TIMEOUT_MS,
  );
});
