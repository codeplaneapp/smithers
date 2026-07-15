/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { z } from "zod";
import { SmithersDb, Task, Workflow, defineTool, runWorkflow } from "smithers-orchestrator";
import { createTestSmithers } from "../../smithers/tests/helpers.js";

const TIMEOUT_MS = 20_000;

function makeTool({ name, idempotent, keyed, invocations }) {
    const execute = keyed
        ? async (_args, ctx) => {
            invocations.push(ctx.idempotencyKey);
            return "ok";
        }
        : async () => {
            invocations.push(null);
            return "ok";
        };
    return defineTool({
        name,
        schema: z.object({}),
        sideEffect: true,
        idempotent,
        execute,
    });
}

function makeAgent(tool, name) {
    return {
        id: `agent-${name}`,
        model: "deterministic-test-agent",
        tools: { [name]: tool },
        async generate({ taskContext }) {
            await tool.execute({});
            if (taskContext.attempt === 1) throw new Error("interrupt after side effect");
            return { output: { value: 2 } };
        },
    };
}

function buildWorkflow(agent, name) {
    const fixture = createTestSmithers({ result: z.object({ value: z.number() }) });
    const workflow = fixture.smithers(() => (
        <Workflow name={`replay-${name}`}>
            <Task id="publish" output={fixture.outputs.result} agent={agent} retries={1} retryPolicy={{ backoff: "fixed", initialDelayMs: 0 }}>
                Publish once.
            </Task>
        </Workflow>
    ));
    return { ...fixture, workflow };
}

describe("replay-unsafe approval through the real engine", () => {
    test("parks a replay of an unkeyed non-idempotent tool before invoking it again", async () => {
        const invocations = [];
        const tool = makeTool({ name: "publish-comment", idempotent: false, keyed: false, invocations });
        const fixture = buildWorkflow(makeAgent(tool, "publish-comment"), "unsafe");
        try {
            const result = await Effect.runPromise(runWorkflow(fixture.workflow, { input: {} }));
            expect(result.status).toBe("waiting-approval");
            expect(invocations).toEqual([null]);

            const adapter = new SmithersDb(fixture.db);
            const approval = await Effect.runPromise(adapter.getApproval(result.runId, "publish", 0));
            expect(approval?.status).toBe("requested");
            expect(JSON.parse(approval?.requestJson ?? "{}")).toMatchObject({
                kind: "ReplayUnsafeApproval",
                offending: [{ toolName: "publish-comment", attempt: 1, seq: 1 }],
            });
            expect((await Effect.runPromise(adapter.getRun(result.runId)))?.status).toBe("waiting-approval");
            expect((await Effect.runPromise(adapter.listToolCalls(result.runId, "publish", 0)))).toHaveLength(1);
        } finally {
            fixture.cleanup();
        }
    }, TIMEOUT_MS);

    test.each([
        ["idempotent tool", true, false],
        ["keyed non-idempotent tool", false, true],
    ])("replays a safe %s", async (_label, idempotent, keyed) => {
        const invocations = [];
        const name = keyed ? "keyed-publish" : "idempotent-publish";
        const tool = makeTool({ name, idempotent, keyed, invocations });
        const fixture = buildWorkflow(makeAgent(tool, name), name);
        try {
            const result = await Effect.runPromise(runWorkflow(fixture.workflow, { input: {} }));
            expect(result.status).toBe("finished");
            expect(invocations).toHaveLength(2);
            if (keyed) {
                expect(invocations[0]).toBeTruthy();
                expect(invocations[1]).toBe(invocations[0]);
            }
            const adapter = new SmithersDb(fixture.db);
            expect(await Effect.runPromise(adapter.getApproval(result.runId, "publish", 0))).toBeUndefined();
        } finally {
            fixture.cleanup();
        }
    }, TIMEOUT_MS);
});
