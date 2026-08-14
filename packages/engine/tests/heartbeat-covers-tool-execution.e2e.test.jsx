/** @jsxImportSource smthrs */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { SmithersDb } from "@smthrs/db/adapter";
import { defineTool } from "@smthrs/tool-context";
import { Task } from "../../components/src/components/Task.js";
import { Workflow } from "../../components/src/components/Workflow.js";
import { runWorkflow } from "../src/engine.js";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { outputSchemas } from "../../smithers/tests/schema.js";
import { sleep } from "../src/sleep.js";
import { Effect } from "effect";

const TIMEOUT_MS = 30_000;
const HEARTBEAT_WINDOW_MS = 500;
const TOOL_WORK_MS = 1_500;

/**
 * Bug 01kzzgg77q1wawmy5pvp1b35qc. Run oneshot-mssi6m38's review node ran 3448s
 * of legitimate work, was editing files a minute before death, then failed with
 * "has not heartbeated in 600516ms (timeout: 600000ms)". One in-flight tool
 * call (a recursive test suite over a 24-package workspace) outlasted the
 * heartbeat window while the attempt was healthy, and the retry restarted the
 * review from zero.
 *
 * The watchdog's only liveness evidence was an agent subprocess pid reported
 * through onProcess. A tool the ENGINE executes in-process reports no pid, so
 * a long tool call looked identical to a hung agent.
 */
describe("heartbeat: in-flight tool execution is liveness evidence", () => {
  test(
    "a tool call that outlasts the heartbeat window does not kill a healthy attempt",
    async () => {
      const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
      const adapter = new SmithersDb(db);
      try {
        let toolCalls = 0;
        const slowTool = defineTool({
          name: "slow_verification",
          description: "runs the whole test suite",
          schema: z.object({}),
          async execute() {
            toolCalls += 1;
            await sleep(TOOL_WORK_MS);
            return { ok: true };
          },
        });
        let generateCalls = 0;
        const agent = {
          id: "sdk-agent",
          tools: {},
          async generate() {
            generateCalls += 1;
            await slowTool.execute({}, {});
            return { output: { value: 1 } };
          },
        };
        const workflow = smithers(() => (
          <Workflow name="heartbeat-tool-execution">
            <Task
              id="verify"
              output={outputs.outputA}
              agent={agent}
              heartbeatTimeoutMs={HEARTBEAT_WINDOW_MS}
              retries={0}
            >
              verify the work
            </Task>
          </Workflow>
        ));
        const runId = "heartbeat-tool-execution-run";

        const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId }));

        expect(result.status).toBe("finished");
        expect(toolCalls).toBe(1);
        // A killed-and-retried attempt is exactly the waste this fixes.
        expect(generateCalls).toBe(1);
        const attempts = await Effect.runPromise(adapter.listAttempts(runId, "verify", 0));
        expect(attempts).toHaveLength(1);
        expect(attempts[0]?.errorJson).toBeNull();
      } finally {
        cleanup();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "an agent that goes silent with no tool call in flight still dies on the heartbeat",
    async () => {
      const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
      const adapter = new SmithersDb(db);
      try {
        const agent = {
          id: "hung-agent",
          tools: {},
          async generate() {
            await sleep(TOOL_WORK_MS);
            return { output: { value: 1 } };
          },
        };
        const workflow = smithers(() => (
          <Workflow name="heartbeat-hung-agent">
            <Task id="hung" output={outputs.outputA} agent={agent} heartbeatTimeoutMs={HEARTBEAT_WINDOW_MS} retries={0}>
              go silent
            </Task>
          </Workflow>
        ));
        const runId = "heartbeat-hung-agent-run";

        const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId }));

        expect(result.status).toBe("failed");
        const attempts = await Effect.runPromise(adapter.listAttempts(runId, "hung", 0));
        expect(JSON.parse(attempts[0]?.errorJson ?? "{}").code).toBe("TASK_HEARTBEAT_TIMEOUT");
      } finally {
        cleanup();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "a tool call that finishes stops crediting liveness, so a later silence still dies",
    async () => {
      const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
      const adapter = new SmithersDb(db);
      try {
        const quickTool = defineTool({
          name: "quick_check",
          description: "a fast check",
          schema: z.object({}),
          async execute() {
            return { ok: true };
          },
        });
        const agent = {
          id: "silent-after-tool",
          tools: {},
          async generate() {
            await quickTool.execute({}, {});
            await sleep(TOOL_WORK_MS);
            return { output: { value: 1 } };
          },
        };
        const workflow = smithers(() => (
          <Workflow name="heartbeat-silent-after-tool">
            <Task
              id="after"
              output={outputs.outputA}
              agent={agent}
              heartbeatTimeoutMs={HEARTBEAT_WINDOW_MS}
              retries={0}
            >
              call a tool then go silent
            </Task>
          </Workflow>
        ));
        const runId = "heartbeat-silent-after-tool-run";

        const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId }));

        expect(result.status).toBe("failed");
        const attempts = await Effect.runPromise(adapter.listAttempts(runId, "after", 0));
        expect(JSON.parse(attempts[0]?.errorJson ?? "{}").code).toBe("TASK_HEARTBEAT_TIMEOUT");
      } finally {
        cleanup();
      }
    },
    TIMEOUT_MS,
  );
});
