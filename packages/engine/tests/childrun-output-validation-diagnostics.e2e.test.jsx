/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { z } from "zod";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { Subflow, Task, Workflow } from "@smithers-orchestrator/components/components/index";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { runWorkflow } from "../src/engine.js";

const END_TO_END_TIMEOUT_MS = 30_000;

function buildSmithers() {
  return createTestSmithers({
    childOut: z.object({ topic: z.string() }),
    parentResult: z.object({ value: z.number() }),
  });
}

/**
 * @param {import("drizzle-orm/bun-sqlite").BunSQLiteDatabase<Record<string, unknown>>} db
 * @param {string} runId
 * @param {string} nodeId
 * @returns {Promise<Record<string, any>>}
 */
async function getFailedAttemptError(db, runId, nodeId) {
  const adapter = new SmithersDb(db);
  const attempts = await adapter.listAttempts(runId, nodeId, 0);
  const failed = attempts.find((attempt) => attempt.state === "failed");
  expect(failed).toBeDefined();
  return JSON.parse(failed?.errorJson ?? "{}");
}

describe("childRun output validation diagnostics", () => {
  test(
    "a parent schema mismatch surfaces issue paths, expected data, and the child's top-level keys",
    async () => {
      const { smithers, outputs, db, cleanup } = buildSmithers();
      try {
        const childWorkflow = smithers(
          () => (
            <Workflow name="childrun-diagnostics-child">
              <Task id="emit-topic" output={outputs.childOut}>
                {{ topic: "quarterly-report" }}
              </Task>
            </Workflow>
          ),
          { output: outputs.childOut },
        );
        const parentWorkflow = smithers(() => (
          <Workflow name="childrun-diagnostics-parent">
            <Subflow id="child-run" output={outputs.parentResult} workflow={childWorkflow} retries={0} />
          </Workflow>
        ));
        const result = await Effect.runPromise(runWorkflow(parentWorkflow, { input: {} }));
        expect(result.status).toBe("failed");
        const error = await getFailedAttemptError(db, result.runId, "child-run");
        expect(error.code).toBe("INVALID_OUTPUT");
        // Node and output-table context is preserved.
        expect(error.details.nodeId).toBe("child-run");
        expect(error.details.outputTable).toBe("parentResult");
        // The durable details carry the Zod issue (path + expected type) and
        // the received value's top-level keys.
        const issues = error.details.issues;
        expect(Array.isArray(issues)).toBe(true);
        const valueIssue = issues.find((issue) => Array.isArray(issue.path) && issue.path.includes("value"));
        expect(valueIssue?.expected).toBe("number");
        expect(error.details.receivedKeys).toEqual(["topic"]);
        // The surfaced message is actionable on its own.
        expect(error.message).toContain("Task output failed validation for parentResult");
        expect(error.message).toContain("value:");
        expect(error.message).toContain("expected number");
        expect(error.message).toContain("received value top-level keys: [topic]");
      } finally {
        cleanup();
      }
    },
    END_TO_END_TIMEOUT_MS,
  );

  test(
    "a multi-row child output is described as an array, not a generic failure",
    async () => {
      const { smithers, outputs, db, cleanup } = buildSmithers();
      try {
        const childWorkflow = smithers(
          () => (
            <Workflow name="childrun-array-child">
              <Task id="row-one" output={outputs.childOut}>
                {{ topic: "alpha" }}
              </Task>
              <Task id="row-two" output={outputs.childOut}>
                {{ topic: "beta" }}
              </Task>
            </Workflow>
          ),
          { output: outputs.childOut },
        );
        const parentWorkflow = smithers(() => (
          <Workflow name="childrun-array-parent">
            <Subflow id="child-run" output={outputs.parentResult} workflow={childWorkflow} retries={0} />
          </Workflow>
        ));
        const result = await Effect.runPromise(runWorkflow(parentWorkflow, { input: {} }));
        expect(result.status).toBe("failed");
        const error = await getFailedAttemptError(db, result.runId, "child-run");
        expect(error.code).toBe("INVALID_OUTPUT");
        expect(error.details.nodeId).toBe("child-run");
        expect(error.details.receivedKeys).toBeNull();
        expect(error.details.receivedDescription).toBe("received value is an array of 2 element(s), not an object");
        expect(error.message).toContain("array of 2 element(s)");
      } finally {
        cleanup();
      }
    },
    END_TO_END_TIMEOUT_MS,
  );

  test(
    "a static payload mismatch carries the same actionable diagnostics",
    async () => {
      const { smithers, outputs, db, cleanup } = buildSmithers();
      try {
        const workflow = smithers(() => (
          <Workflow name="static-output-diagnostics">
            <Task
              id="static-bad"
              output={outputs.parentResult}
              outputSchema={z.object({ value: z.number().max(5) })}
              noRetry
            >
              {{ value: 10 }}
            </Task>
          </Workflow>
        ));
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        expect(result.status).toBe("failed");
        const error = await getFailedAttemptError(db, result.runId, "static-bad");
        expect(error.code).toBe("INVALID_OUTPUT");
        expect(error.details.nodeId).toBe("static-bad");
        expect(error.details.receivedKeys).toEqual(["value"]);
        expect(error.message).toContain("value:");
      } finally {
        cleanup();
      }
    },
    END_TO_END_TIMEOUT_MS,
  );
});
