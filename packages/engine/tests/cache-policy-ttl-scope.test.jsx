/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { z } from "zod";
import { Effect } from "effect";
import { Workflow, Task, runWorkflow } from "smithers-orchestrator";
import { createTestSmithers } from "../../smithers/tests/helpers.js";

function outputShape() {
    return {
        out: z.object({ v: z.number() }),
    };
}

function countingAgent(id) {
    let calls = 0;
    return {
        agent: {
            id,
            tools: {},
            generate: async () => {
                calls += 1;
                return { output: { v: calls } };
            },
        },
        get calls() {
            return calls;
        },
    };
}

describe("cachePolicy.ttlMs", () => {
    test("ttlMs expiration causes re-execution and refreshes the cache row", async () => {
        const { smithers, outputs, dbPath, cleanup } = createTestSmithers(outputShape());
        const counter = countingAgent("ttl");
        try {
            const workflow = smithers(() => (
                <Workflow name="ttl-cache">
                    <Task id="t" output={outputs.out} agent={counter.agent} cache={{ ttlMs: 1000 }}>
                        same prompt
                    </Task>
                </Workflow>
            ));

            await Effect.runPromise(runWorkflow(workflow, { input: {}, runId: "ttl-r1" }));
            const sqlite = new Database(dbPath);
            try {
                sqlite.query("UPDATE _smithers_cache SET created_at_ms = ?").run(Date.now() - 5000);
            }
            finally {
                sqlite.close();
            }
            await Effect.runPromise(runWorkflow(workflow, { input: {}, runId: "ttl-r2" }));
            await Effect.runPromise(runWorkflow(workflow, { input: {}, runId: "ttl-r3" }));

            expect(counter.calls).toBe(2);
        }
        finally {
            cleanup();
        }
    });
});

describe("cachePolicy.scope", () => {
    test("scope=run keeps cache local to a single run", async () => {
        const { smithers, outputs, cleanup } = createTestSmithers(outputShape());
        const counter = countingAgent("scope-run");
        try {
            const workflow = smithers(() => (
                <Workflow name="scope-run-cache">
                    <Task id="t" output={outputs.out} agent={counter.agent} cache={{ scope: "run" }}>
                        same prompt
                    </Task>
                </Workflow>
            ));

            await Effect.runPromise(runWorkflow(workflow, { input: {}, runId: "scope-run-r1" }));
            await Effect.runPromise(runWorkflow(workflow, { input: {}, runId: "scope-run-r2" }));

            expect(counter.calls).toBe(2);
        }
        finally {
            cleanup();
        }
    });

    test("scope=workflow shares cache across runs of the same workflow", async () => {
        const { smithers, outputs, cleanup } = createTestSmithers(outputShape());
        const counter = countingAgent("scope-workflow");
        try {
            const workflow = smithers(() => (
                <Workflow name="scope-workflow-cache">
                    <Task id="t" output={outputs.out} agent={counter.agent} cache={{ scope: "workflow" }}>
                        same prompt
                    </Task>
                </Workflow>
            ));

            await Effect.runPromise(runWorkflow(workflow, { input: {}, runId: "scope-workflow-r1" }));
            await Effect.runPromise(runWorkflow(workflow, { input: {}, runId: "scope-workflow-r2" }));

            expect(counter.calls).toBe(1);
        }
        finally {
            cleanup();
        }
    });

    test("scope=global shares across distinct workflows", async () => {
        const { smithers, outputs, cleanup } = createTestSmithers(outputShape());
        const counter = countingAgent("scope-global");
        try {
            const first = smithers(() => (
                <Workflow name="scope-global-a">
                    <Task id="t" output={outputs.out} agent={counter.agent} cache={{ scope: "global" }}>
                        same prompt
                    </Task>
                </Workflow>
            ));
            const second = smithers(() => (
                <Workflow name="scope-global-b">
                    <Task id="t" output={outputs.out} agent={counter.agent} cache={{ scope: "global" }}>
                        same prompt
                    </Task>
                </Workflow>
            ));

            await Effect.runPromise(runWorkflow(first, { input: {}, runId: "scope-global-r1" }));
            await Effect.runPromise(runWorkflow(second, { input: {}, runId: "scope-global-r2" }));

            expect(counter.calls).toBe(1);
        }
        finally {
            cleanup();
        }
    });

    test("same task key with different scopes does not collide", async () => {
        const { smithers, outputs, cleanup } = createTestSmithers(outputShape());
        const counter = countingAgent("scope-collision");
        try {
            const globalWorkflow = smithers(() => (
                <Workflow name="scope-collision">
                    <Task id="t" output={outputs.out} agent={counter.agent} cache={{ scope: "global" }}>
                        same prompt
                    </Task>
                </Workflow>
            ));
            const workflowScoped = smithers(() => (
                <Workflow name="scope-collision">
                    <Task id="t" output={outputs.out} agent={counter.agent} cache={{ scope: "workflow" }}>
                        same prompt
                    </Task>
                </Workflow>
            ));

            await Effect.runPromise(runWorkflow(globalWorkflow, { input: {}, runId: "scope-collision-r1" }));
            await Effect.runPromise(runWorkflow(workflowScoped, { input: {}, runId: "scope-collision-r2" }));

            expect(counter.calls).toBe(2);
        }
        finally {
            cleanup();
        }
    });
});
