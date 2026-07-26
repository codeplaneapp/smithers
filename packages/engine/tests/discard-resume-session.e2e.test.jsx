/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { Task, Workflow, runWorkflow } from "smithers-orchestrator";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { outputSchemas } from "../../smithers/tests/schema.js";
import { Effect } from "effect";

/**
 * A CLI agent that loses its session (e.g. kimi crashing on `kimi -r <uuid>`)
 * fails the attempt with `discardResumeSession: true`. The retry must NOT
 * resume the corrupt session: neither via the heartbeat checkpoint nor via the
 * hijack-continuation captured in the failed attempt's meta (`agentResume`),
 * nor via the cwd-scoped `continueSession` fallback. Before the fix, the
 * continuation path ignored the discard flag, so every retry deterministically
 * reproduced the crash.
 */
describe("discardResumeSession vetoes every resume path on retry", () => {
  test("retry after session loss starts a fresh session", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers(outputSchemas);
    try {
      const generateArgs = [];
      const agent = {
        id: "session-loser",
        model: "fake-model",
        cliEngine: "fake-cli",
        tools: {},
        async generate(params) {
          generateArgs.push({
            resumeSession: params.resumeSession,
            continueSession: params.continueSession,
          });
          if (generateArgs.length === 1) {
            // Capture a session id into attempt meta the way real CLI
            // agents do, then die reporting the session as corrupt.
            params.onEvent?.({
              type: "started",
              engine: "fake-cli",
              resume: "broken-session-uuid",
            });
            throw new SmithersError(
              "AGENT_SESSION_LOST",
              "fake-cli session broken-session-uuid is broken; CLI exited 1. Retry will start a fresh session.",
              {
                failureRetryable: true,
                discardResumeSession: true,
              },
            );
          }
          return { output: { value: 1 } };
        },
      };
      const workflow = smithers(() => (
        <Workflow name="discard-resume-session">
          <Task id="session-task" output={outputs.outputA} agent={agent} retries={2}>
            Produce a value.
          </Task>
        </Workflow>
      ));
      const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
      expect(result.status).toBe("finished");
      expect(generateArgs).toHaveLength(2);
      // First attempt has nothing to resume.
      expect(generateArgs[0].resumeSession).toBeUndefined();
      // The retry must start fresh: no resume of the corrupt session and
      // no --continue fallback that could re-attach it by cwd.
      expect(generateArgs[1].resumeSession).toBeUndefined();
      expect(generateArgs[1].continueSession).toBeFalsy();
    } finally {
      await cleanup();
    }
  });
});
