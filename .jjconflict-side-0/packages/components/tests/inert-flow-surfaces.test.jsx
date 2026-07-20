/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { SmithersDb, Subflow, runWorkflow } from "smithers-orchestrator";
import { createTestSmithers } from "./helpers.js";
import { z } from "zod";
import { Effect } from "effect";
const COMPONENT_TIMEOUT_MS = 30_000;
// These tests pin two documented-but-inert flow-control surfaces so a future
// implementation (or a silent regression into new misbehavior) flips them
// intentionally. Both are typed, documented props that currently do nothing.
describe("<Subflow mode=\"inline\"> is a silent no-op (known gap)", () => {
    test("an inline subflow finishes the parent without ever executing the child workflow", async () => {
        const { Workflow, Task, smithers, outputs, tables, db, cleanup } = createTestSmithers({
            childOut: z.object({ topic: z.string() }),
        });
        let childRendered = false;
        const childWorkflow = smithers(() => {
            childRendered = true;
            return (<Workflow name="inline-child">
          <Task id="never-runs" output={outputs.childOut}>
            {{ topic: "from-child" }}
          </Task>
        </Workflow>);
        });
        const parentWorkflow = smithers(() => (<Workflow name="inline-parent">
        <Subflow id="inline-run" mode="inline" output={outputs.childOut} workflow={childWorkflow} input={{ topic: "ignored" }}/>
      </Workflow>));
        const result = await Effect.runPromise(runWorkflow(parentWorkflow, { input: {} }));
        // BUG (documented gap): buildPlanTree collapses inline subflows to a
        // sequence of host children, but <Subflow> emits no JSX children — the
        // `workflow` prop is ignored, so the child never runs anywhere: no
        // child run row, no child output, no error. When inline mode is
        // implemented, this test should start failing and be rewritten to
        // assert real inline execution.
        expect(result.status).toBe("finished");
        expect(childRendered).toBe(false);
        const adapter = new SmithersDb(db);
        const childRun = await adapter.getLatestChildRun(result.runId);
        expect(childRun ?? null).toBeNull();
        expect(db.select().from(tables.childOut).all()).toEqual([]);
        cleanup();
    }, COMPONENT_TIMEOUT_MS);
});
describe("<Task memory> is inert at runtime (known gap)", () => {
    test("a memory config neither augments the agent prompt nor fails the run", async () => {
        const { Workflow, Task, smithers, outputs, cleanup } = createTestSmithers({
            answer: z.object({ value: z.number() }),
        });
        /** @type {any[]} */
        const calls = [];
        const recordingAgent = {
            id: "memory-probe",
            tools: {},
            generate: async (args) => {
                calls.push(args);
                return {
                    output: { value: 7 },
                    text: JSON.stringify({ value: 7 }),
                    response: { messages: [] },
                };
            },
        };
        const workflow = smithers(() => (<Workflow name="task-memory-inert">
        <Task id="recall-task" output={outputs.answer} agent={recordingAgent} memory={{
                recall: { query: "previous deploy failures", topK: 3 },
                remember: { key: "deploy-outcome" },
            }}>
          Answer using anything you remember.
        </Task>
      </Workflow>));
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        // BUG (documented gap): the memory prop is extracted onto the task
        // descriptor as `memoryConfig` (packages/graph/src/extract.js) but no
        // engine/scheduler code consumes it — the engine never imports
        // @smithers-orchestrator/memory. The agent sees the authored prompt
        // only, with no recalled facts injected and nothing remembered. When
        // memory integration lands, rewrite this test to assert recall/save.
        expect(result.status).toBe("finished");
        expect(calls.length).toBe(1);
        const promptText = JSON.stringify(calls[0]);
        expect(promptText).toContain("Answer using anything you remember.");
        expect(promptText).not.toContain("previous deploy failures");
        expect(promptText).not.toContain("deploy-outcome");
        cleanup();
    }, COMPONENT_TIMEOUT_MS);
});
