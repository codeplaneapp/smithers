/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { Task, Workflow, runWorkflow } from "smithers-orchestrator";
import { fakeAgent } from "smithers-orchestrator/testing";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { Effect } from "effect";
import { z } from "zod";
import { createTestSmithers } from "../../smithers/tests/helpers.js";

const schemas = { out: z.object({ value: z.number() }) };
const TIMEOUT_MS = 30_000;

function buildFailingWorkflow(rawError) {
  const runtime = createTestSmithers(schemas);
  const agent = fakeAgent(
    schemas.out,
    () => {
      throw rawError;
    },
    { id: "error-reporting-agent" },
  );
  const workflow = runtime.smithers(() => (
    <Workflow name="error-reporting-hook">
      <Task id="fail" output={runtime.outputs.out} agent={agent} noRetry>
        Fail for the error-reporting hook test.
      </Task>
    </Workflow>
  ));
  return { runtime, workflow };
}

describe("RunOptions.onError", () => {
  test(
    "reports structured node and run failures once",
    async () => {
      const rawError = new TypeError("agent failure for reporter");
      const { runtime, workflow } = buildFailingWorkflow(rawError);
      const reports = [];
      try {
        const result = await Effect.runPromise(
          runWorkflow(workflow, {
            input: {},
            runId: "error-report-node-run",
            onError: (report) => reports.push(report),
          }),
        );

        expect(result.status).toBe("failed");
        expect(reports.map((report) => report.phase)).toEqual(["node", "run"]);

        const nodeReport = reports[0];
        expect(nodeReport).toMatchObject({
          phase: "node",
          runId: "error-report-node-run",
          nodeId: "fail",
          iteration: 0,
          attempt: 1,
        });
        expect(nodeReport.error).toBeInstanceOf(SmithersError);
        expect(nodeReport.error.code).toBe("INTERNAL_ERROR");
        expect(nodeReport.error.cause).toBe(nodeReport.rawError);
        expect(nodeReport.rawError).toMatchObject({
          message: "agent failure for reporter",
        });

        const runReport = reports[1];
        expect(runReport).toMatchObject({
          phase: "run",
          runId: "error-report-node-run",
        });
        expect(runReport.error).toBeInstanceOf(SmithersError);
        expect(runReport.error).toBe(runReport.rawError);
        expect(runReport.error).toMatchObject({
          code: "SESSION_ERROR",
          cause: { message: "agent failure for reporter" },
        });
      } finally {
        runtime.cleanup();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "reports a run failure that has no node context",
    async () => {
      const runtime = createTestSmithers(schemas);
      const reports = [];
      const rawError = new Error("workflow render failed");
      const workflow = runtime.smithers(() => {
        throw rawError;
      });
      try {
        const result = await Effect.runPromise(
          runWorkflow(workflow, {
            input: {},
            runId: "error-report-run-only",
            onError: (report) => reports.push(report),
          }),
        );

        expect(result.status).toBe("failed");
        expect(reports).toHaveLength(1);
        expect(reports[0]).toMatchObject({
          phase: "run",
          runId: "error-report-run-only",
        });
        expect(reports[0].nodeId).toBeUndefined();
        expect(reports[0].attempt).toBeUndefined();
        expect(reports[0].error).toBeInstanceOf(SmithersError);
        expect(reports[0].error.code).toBe("WORKFLOW_RENDER_FAILED");
        expect(reports[0].error).toBe(reports[0].rawError);
        expect(reports[0].error).toMatchObject({
          cause: { message: "workflow render failed" },
        });
      } finally {
        runtime.cleanup();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "reports bridge-managed static failures once",
    async () => {
      const runtime = createTestSmithers(schemas);
      const reports = [];
      const workflow = runtime.smithers(() => (
        <Workflow name="error-reporting-static-task">
          <Task id="invalid-static" output={runtime.outputs.out} noRetry>
            {{ value: "not-a-number" }}
          </Task>
        </Workflow>
      ));
      try {
        const result = await Effect.runPromise(
          runWorkflow(workflow, {
            input: {},
            runId: "error-report-static-task",
            onError: (report) => reports.push(report),
          }),
        );

        expect(result.status).toBe("failed");
        expect(reports.map((report) => report.phase)).toEqual(["node", "run"]);
        expect(reports[0]).toMatchObject({
          phase: "node",
          runId: "error-report-static-task",
          nodeId: "invalid-static",
          iteration: 0,
          attempt: 1,
        });
      } finally {
        runtime.cleanup();
      }
    },
    TIMEOUT_MS,
  );

  test.each([
    [
      "throwing",
      () => {
        throw new Error("reporter unavailable");
      },
    ],
    ["Promise-rejecting", () => Promise.reject(new Error("async reporter unavailable"))],
  ])(
    "a %s reporter is swallowed and retries report each failed attempt once",
    async (_kind, failReporter) => {
      const runtime = createTestSmithers(schemas);
      let taskCalls = 0;
      const workflow = runtime.smithers(() => (
        <Workflow name="error-reporting-throwing-reporter">
          <Task
            id="flaky"
            output={runtime.outputs.out}
            retries={1}
            retryPolicy={{ backoff: "fixed", initialDelayMs: 0 }}
          >
            {() => {
              taskCalls += 1;
              if (taskCalls === 1) {
                throw new Error("first attempt fails");
              }
              return { value: 7 };
            }}
          </Task>
        </Workflow>
      ));
      const reports = [];
      try {
        const result = await Effect.runPromise(
          runWorkflow(workflow, {
            input: {},
            runId: "error-report-throwing-reporter",
            onError(report) {
              reports.push(report);
              return failReporter();
            },
          }),
        );

        expect(result.status).toBe("finished");
        expect(taskCalls).toBe(2);
        expect(reports).toHaveLength(1);
        expect(reports[0]).toMatchObject({
          phase: "node",
          nodeId: "flaky",
          attempt: 1,
        });
      } finally {
        runtime.cleanup();
      }
    },
    TIMEOUT_MS,
  );
});
