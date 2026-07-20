/** @jsxImportSource smithers-orchestrator */
import { expect, test } from "bun:test";
import { Effect } from "effect";
import { Task, Workflow, runWorkflow } from "smithers-orchestrator";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { outputSchemas } from "../../smithers/tests/schema.js";

// Regression: CLI agents (e.g. CodexAgent) deliver their final answer through
// the event stream as a `completed` event with `answer`, NOT via the
// generate() return value's `text`. The engine must capture that answer as the
// node's structured output. Previously `responseText = result.text ?? null`
// discarded the event answer, and the JSON fallback parsed only `result.text`,
// so the task finished "succeeded" with an empty output row (NodeHasNoOutput).
test("CLI agent answer delivered via completed event is captured as output", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers(outputSchemas);
    const agent = {
        id: "fake-cli-agent",
        // CLI agents do not use native (SDK) structured output; they stream a
        // `completed` event and return no `text`.
        tools: {},
        /**
         * @param {any} args
         */
        async generate(args) {
            args.onEvent?.({
                type: "completed",
                engine: "codex",
                ok: true,
                answer: JSON.stringify({ value: 42 }),
            });
            // No `text` and no `output` — mirrors a CLI agent whose answer lives
            // only in the streamed completed event.
            return { response: { messages: [] } };
        },
    };
    const workflow = smithers(() => (<Workflow name="cli-agent-event-output">
      <Task id="probe" output={outputs.outputA} agent={agent}>
        verify and report
      </Task>
    </Workflow>));
    const result = await Effect.runPromise(runWorkflow(workflow, {
        input: {},
        runId: "cli-agent-event-output",
    }));
    expect(result.status).toBe("finished");
    expect(db.select().from(tables.outputA).all()).toEqual([
        expect.objectContaining({ nodeId: "probe", value: 42 }),
    ]);
    cleanup();
});
