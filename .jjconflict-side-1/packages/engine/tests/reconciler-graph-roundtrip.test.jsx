/** @jsxImportSource smithers-orchestrator */
// Round-trip integration tests: React component tree → host tree →
// extracted task plan → engine schedule + execute.
//
// These exercise the public surface that workflow authors actually use,
// so failures here indicate a wiring break across the
// reconciler→graph→engine boundary rather than a problem in any one
// package.
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Effect } from "effect";
import { Sandbox, Task, Workflow, runWorkflow } from "smithers-orchestrator";
import { SmithersRenderer } from "@smithers-orchestrator/react-reconciler/dom/renderer";
import { extractFromHost } from "@smithers-orchestrator/graph/dom/extract";
import { createTestSmithers } from "../../smithers/tests/helpers.js";

describe("reconciler→graph→engine pipeline", () => {
    test("renders, extracts, schedules, and executes a one-task workflow", async () => {
        const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
            outputA: z.object({ value: z.number() }),
        });
        try {
            const workflow = smithers(() => (
                <Workflow name="rt-one">
                    <Task id="only" output={outputs.outputA}>
                        {{ value: 42 }}
                    </Task>
                </Workflow>
            ));
            const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
            expect(result.status).toBe("finished");
            const rows = await db.select().from(tables.outputA);
            expect(rows.length).toBe(1);
            expect(rows[0].value).toBe(42);
        } finally {
            cleanup();
        }
    }, 30_000);

    test("executes a provider-backed sandbox through the public React pipeline", async () => {
        const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
            result: z.object({ value: z.number() }),
        });
        const providerCalls = [];
        const provider = {
            id: "roundtrip-provider",
            run: async (request) => {
                providerCalls.push(request);
                return {
                    status: "finished",
                    output: { value: 1 },
                    runId: "remote-roundtrip",
                    workspaceId: "workspace-roundtrip",
                };
            },
        };
        try {
            const childWorkflow = { build: () => null };
            const workflow = smithers(() => (
                <Workflow name="rt-sandbox-provider">
                    <Sandbox
                        id="remote"
                        provider={provider}
                        workflow={childWorkflow}
                        input={{ prompt: "ship it" }}
                        output={outputs.result}
                        reviewDiffs={false}
                        retries={0}
                    />
                </Workflow>
            ));

            const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));

            expect(result.status).toBe("finished");
            expect(providerCalls).toHaveLength(1);
            expect(providerCalls[0]).toMatchObject({
                sandboxId: "remote",
                input: { prompt: "ship it" },
            });
            const rows = await db.select().from(tables.result);
            expect(rows).toHaveLength(1);
            expect(rows[0].value).toBe(1);
        } finally {
            cleanup();
        }
    }, 30_000);

    test("changing Task props on re-render is reflected in extraction", async () => {
        const renderer = new SmithersRenderer();
        const first = await renderer.render(
            <Workflow name="rt-update">
                <Task id="t" output="out_a">{{ value: 1 }}</Task>
            </Workflow>,
        );
        expect(first.tasks[0]?.staticPayload).toEqual({ value: 1 });
        const second = await renderer.render(
            <Workflow name="rt-update">
                <Task id="t" output="out_a">{{ value: 999 }}</Task>
            </Workflow>,
        );
        expect(second.tasks[0]?.staticPayload).toEqual({ value: 999 });
    });

    test("conditional rendering changes the extracted task plan", async () => {
        const renderer = new SmithersRenderer();
        /** @param {boolean} enabled */
        const tree = (enabled) => (
            <Workflow name="rt-cond">
                <Task id="always" output="out_a">{{ value: 1 }}</Task>
                {enabled ? <Task id="maybe" output="out_a">{{ value: 2 }}</Task> : null}
            </Workflow>
        );
        const off = await renderer.render(tree(false));
        expect(off.tasks.map((t) => t.nodeId).sort()).toEqual(["always"]);
        const on = await renderer.render(tree(true));
        expect(on.tasks.map((t) => t.nodeId).sort()).toEqual(["always", "maybe"]);
        const offAgain = await renderer.render(tree(false));
        expect(offAgain.tasks.map((t) => t.nodeId).sort()).toEqual(["always"]);
    });
});

describe("extraction scaling", () => {
    test("5000-node tree extracts in under 5 seconds and yields a plan with all tasks", () => {
        const N = 5000;
        /** @type {any[]} */
        const children = [];
        for (let i = 0; i < N; i += 1) {
            children.push({
                kind: "element",
                tag: "smithers:task",
                props: { id: `task-${i}`, output: "out" },
                rawProps: {
                    id: `task-${i}`,
                    output: "out",
                    __smithersKind: "static",
                    __smithersPayload: { value: i },
                },
                children: [],
            });
        }
        const root = {
            kind: "element",
            tag: "smithers:workflow",
            props: { name: "big" },
            rawProps: { name: "big" },
            children,
        };
        const start = performance.now();
        const result = extractFromHost(root);
        const elapsed = performance.now() - start;
        expect(result.tasks.length).toBe(N);
        // 5s upper bound — generous for cold runs, but well above the
        // ~100ms steady-state we observe locally. Tighten if it ever
        // helps catch perf regressions.
        expect(elapsed).toBeLessThan(5000);
    });
});
