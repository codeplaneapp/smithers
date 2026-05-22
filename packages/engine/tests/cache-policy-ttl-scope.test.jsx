/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Effect } from "effect";
import { Workflow, Task, runWorkflow } from "smithers-orchestrator";
import { createTestSmithers } from "../../smithers/tests/helpers.js";

describe("cachePolicy.ttlMs", () => {
    test("ttlMs expiration causes re-execution", async () => {
        const { smithers, outputs, cleanup } = createTestSmithers({
            out: z.object({ v: z.number() }),
        });
        try {
            let calls = 0;
            const agent = {
                id: "ttl",
                tools: {},
                generate: async () => { calls += 1; return { output: { v: calls } }; },
            };
            const workflow = smithers(() => (
                <Workflow name="ttl-cache">
                    <Task id="t" output={outputs.out} agent={agent} cache={{ ttlMs: 1 }}>
                        same prompt
                    </Task>
                </Workflow>
            ));
            await Effect.runPromise(runWorkflow(workflow, { input: {}, runId: "r1" }));
            // wait long enough that ttl is exceeded.
            await new Promise((r) => setTimeout(r, 50));
            await Effect.runPromise(runWorkflow(workflow, { input: {}, runId: "r2" }));
            expect(calls).toBe(2);
        } finally {
            cleanup();
        }
    });
});

describe("cachePolicy.scope", () => {
    test("scope=run keeps cache local to a single run", async () => {
        const { smithers, outputs, cleanup } = createTestSmithers({
            out: z.object({ v: z.number() }),
        });
        try {
            let calls = 0;
            const agent = {
                id: "run-scope",
                tools: {},
                generate: async () => { calls += 1; return { output: { v: calls } }; },
            };
            const workflow = smithers(() => (
                <Workflow name="run-scope-cache">
                    <Task id="t" output={outputs.out} agent={agent} cache={{ scope: "run", key: "same" }}>
                        same prompt
                    </Task>
                </Workflow>
            ));
            await Effect.runPromise(runWorkflow(workflow, { input: {}, runId: "run-scope-r1" }));
            await Effect.runPromise(runWorkflow(workflow, { input: {}, runId: "run-scope-r2" }));
            expect(calls).toBe(2);
        } finally {
            cleanup();
        }
    });
    test("scope=workflow shares cache across runs of the same workflow", async () => {
        const { smithers, outputs, cleanup } = createTestSmithers({
            out: z.object({ v: z.number() }),
        });
        try {
            let calls = 0;
            const agent = {
                id: "workflow-scope",
                tools: {},
                generate: async () => { calls += 1; return { output: { v: calls } }; },
            };
            const workflow = smithers(() => (
                <Workflow name="workflow-scope-cache">
                    <Task id="t" output={outputs.out} agent={agent} cache={{ scope: "workflow", key: "same" }}>
                        same prompt
                    </Task>
                </Workflow>
            ));
            await Effect.runPromise(runWorkflow(workflow, { input: {}, runId: "workflow-scope-r1" }));
            await Effect.runPromise(runWorkflow(workflow, { input: {}, runId: "workflow-scope-r2" }));
            expect(calls).toBe(1);
        } finally {
            cleanup();
        }
    });
    test("explicit key shares cache across different task ids in the same workflow", async () => {
        const { smithers, outputs, cleanup } = createTestSmithers({
            out: z.object({ v: z.number() }),
        });
        try {
            let calls = 0;
            const agent = {
                id: "workflow-key",
                tools: {},
                generate: async () => { calls += 1; return { output: { v: calls } }; },
            };
            const workflow = smithers(() => (
                <Workflow name="workflow-key-cache">
                    <Task id="first-task" output={outputs.out} agent={agent} cache={{ scope: "workflow", key: "shared-task-key" }}>
                        same prompt
                    </Task>
                    <Task id="second-task" output={outputs.out} agent={agent} cache={{ scope: "workflow", key: "shared-task-key" }} dependsOn={["first-task"]}>
                        same prompt
                    </Task>
                </Workflow>
            ));
            await Effect.runPromise(runWorkflow(workflow, { input: {}, runId: "workflow-key-r1" }));
            expect(calls).toBe(1);
        } finally {
            cleanup();
        }
    });
    test("scope=global shares across distinct workflows", async () => {
        const { smithers, outputs, cleanup } = createTestSmithers({
            out: z.object({ v: z.number() }),
        });
        try {
            let calls = 0;
            const agent = {
                id: "global-scope",
                tools: {},
                generate: async () => { calls += 1; return { output: { v: calls } }; },
            };
            const first = smithers(() => (
                <Workflow name="global-scope-a">
                    <Task id="t" output={outputs.out} agent={agent} cache={{ scope: "global", key: "shared" }}>
                        same prompt
                    </Task>
                </Workflow>
            ));
            const second = smithers(() => (
                <Workflow name="global-scope-b">
                    <Task id="t" output={outputs.out} agent={agent} cache={{ scope: "global", key: "shared" }}>
                        same prompt
                    </Task>
                </Workflow>
            ));
            await Effect.runPromise(runWorkflow(first, { input: {}, runId: "global-scope-r1" }));
            await Effect.runPromise(runWorkflow(second, { input: {}, runId: "global-scope-r2" }));
            expect(calls).toBe(1);
        } finally {
            cleanup();
        }
    });
    test("two tasks with the same key but different scopes do not collide", async () => {
        const { smithers, outputs, cleanup } = createTestSmithers({
            out: z.object({ v: z.number() }),
        });
        try {
            let runCalls = 0;
            let workflowCalls = 0;
            const runAgent = {
                id: "scope-collision-run",
                tools: {},
                generate: async () => { runCalls += 1; return { output: { v: runCalls } }; },
            };
            const workflowAgent = {
                id: "scope-collision-workflow",
                tools: {},
                generate: async () => { workflowCalls += 1; return { output: { v: workflowCalls } }; },
            };
            const workflow = smithers(() => (
                <Workflow name="scope-collision-cache">
                    <Task id="run-task" output={outputs.out} agent={runAgent} cache={{ scope: "run", key: "shared" }}>
                        same prompt
                    </Task>
                    <Task id="workflow-task" output={outputs.out} agent={workflowAgent} cache={{ scope: "workflow", key: "shared" }}>
                        same prompt
                    </Task>
                </Workflow>
            ));
            await Effect.runPromise(runWorkflow(workflow, { input: {}, runId: "scope-collision-r1" }));
            await Effect.runPromise(runWorkflow(workflow, { input: {}, runId: "scope-collision-r2" }));
            expect(runCalls).toBe(2);
            expect(workflowCalls).toBe(1);
        } finally {
            cleanup();
        }
    });
});
