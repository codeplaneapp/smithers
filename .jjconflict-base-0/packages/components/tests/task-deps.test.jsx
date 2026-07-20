/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { SmithersCtx } from "@smithers-orchestrator/react-reconciler/context";
import { renderFrame, runWorkflow } from "smithers-orchestrator";
import { createTestSmithers } from "./helpers.js";
import { z } from "zod";
import { createSmithers } from "smithers-orchestrator";
import { renderToStaticMarkup } from "react-dom/server";
import { Effect } from "effect";
/**
 * @template T
 * @param {() => T} render
 * @returns {T}
 */
function withSuppressedReactPropWarnings(render) {
    const originalConsoleError = console.error;
    console.error = (...args) => {
        const message = String(args[0] ?? "");
        if (message.includes("React does not recognize the `smithersContext` prop") ||
            message.includes("React does not recognize the `dependsOn` prop") ||
            message.includes("React does not recognize the `__smithersKind` prop") ||
            message.includes("React does not recognize the `__smithersPayload` prop")) {
            return;
        }
        originalConsoleError(...args);
    };
    try {
        return render();
    }
    finally {
        console.error = originalConsoleError;
    }
}
describe("Task deps", () => {
    test("gates mounting until upstream output exists and renders typed prompt children", async () => {
        const { smithers, Workflow, Task, outputs, cleanup } = createTestSmithers({
            source: z.object({ message: z.string() }),
            report: z.object({ summary: z.string() }),
        });
        const agent = {
            generate: async () => ({ text: '{"summary":"ok"}' }),
        };
        const workflow = smithers(() => (<Workflow name="deps-prompt">
        <Task id="source" output={outputs.source}>
          {{ message: "ready" }}
        </Task>
        <Task id="report" output={outputs.report} agent={agent} deps={{ source: outputs.source }}>
          {(deps) => `Summarize: ${deps.source.message}`}
        </Task>
      </Workflow>));
        const before = await Effect.runPromise(renderFrame(workflow, new SmithersCtx({
            runId: "deps-before",
            iteration: 0,
            input: {},
            outputs: {},
            zodToKeyName: workflow.zodToKeyName,
        })));
        expect(before.tasks.map((task) => task.nodeId)).toEqual(["source"]);
        const after = await Effect.runPromise(renderFrame(workflow, new SmithersCtx({
            runId: "deps-after",
            iteration: 0,
            input: {},
            outputs: {
                source: [{ runId: "deps-after", nodeId: "source", iteration: 0, message: "ready" }],
            },
            zodToKeyName: workflow.zodToKeyName,
        })));
        const report = after.tasks.find((task) => task.nodeId === "report");
        expect(report).toBeDefined();
        expect(report?.prompt).toContain("Summarize: ready");
        expect(report?.dependsOn).toEqual(["source"]);
        cleanup();
    });
    test("uses matching needs entries when dep key differs from the upstream task id", async () => {
        const { smithers, Workflow, Task, outputs, tables, db, cleanup } = createTestSmithers({
            contract: z.object({ title: z.string() }),
            summary: z.object({ title: z.string() }),
        });
        const workflow = smithers(() => (<Workflow name="deps-needs">
        <Task id="parse-contract" output={outputs.contract}>
          {{ title: "Orders API" }}
        </Task>
        <Task id="summary" output={outputs.summary} needs={{ contract: "parse-contract" }} deps={{ contract: outputs.contract }}>
          {(deps) => ({ title: deps.contract.title })}
        </Task>
      </Workflow>));
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        expect(result.status).toBe("finished");
        const summaryRows = db.select().from(tables.summary).all();
        expect(summaryRows[0]?.title).toBe("Orders API");
        cleanup();
    }, 15_000);
    test("optional deps render while preserving dependency gating", async () => {
        const { smithers, Workflow, Task, outputs, cleanup } = createTestSmithers({
            review: z.object({ verdict: z.string() }),
            summary: z.object({ text: z.string() }),
        });
        const workflow = smithers(() => (<Workflow name="optional-deps">
        <Task id="review-a" output={outputs.review}>
          {{ verdict: "approved" }}
        </Task>
        <Task id="review-b" output={outputs.review}>
          {{ verdict: "failed before output" }}
        </Task>
        <Task
          id="summary"
          output={outputs.summary}
          needs={{ a: "review-a", b: "review-b" }}
          deps={{ a: outputs.review, b: outputs.review }}
          depsOptional
        >
          {(deps) => ({ text: `a=${deps.a?.verdict ?? "missing"} b=${deps.b?.verdict ?? "missing"}` })}
        </Task>
      </Workflow>));
        const frame = await Effect.runPromise(renderFrame(workflow, new SmithersCtx({
            runId: "optional-deps",
            iteration: 0,
            input: {},
            outputs: {
                review: [{ runId: "optional-deps", nodeId: "review-a", iteration: 0, verdict: "approved" }],
            },
            zodToKeyName: workflow.zodToKeyName,
        })));
        const summary = frame.tasks.find((task) => task.nodeId === "summary");
        expect(summary).toBeDefined();
        expect(summary?.staticPayload).toEqual({ text: "a=approved b=missing" });
        expect(new Set(summary?.dependsOn)).toEqual(new Set(["review-a", "review-b"]));
        cleanup();
    });
    test("does not resolve deps from another createSmithers context", async () => {
        const api1 = createSmithers({
            source: z.object({ message: z.string() }),
        }, { dbPath: ":memory:" });
        const api2 = createSmithers({
            source: z.object({ message: z.string() }),
        }, { dbPath: ":memory:" });
        try {
            const workflow = api1.smithers(() => (<>
          <api1.Workflow name="ctx-one">
            <api1.Task id="source" output={api1.outputs.source}>
              {{ message: "ready" }}
            </api1.Task>
          </api1.Workflow>
          <api2.Task id="shadow" output={api2.outputs.source} deps={{ source: api2.outputs.source }}>
            {(deps) => `Shadow: ${deps.source.message}`}
          </api2.Task>
        </>));
            const ctx = new SmithersCtx({
                runId: "ctx-one",
                iteration: 0,
                input: {},
                outputs: {
                    source: [{ runId: "ctx-one", nodeId: "source", iteration: 0, message: "ready" }],
                },
                zodToKeyName: workflow.zodToKeyName,
            });
            expect(() => withSuppressedReactPropWarnings(() => renderToStaticMarkup(workflow.build(ctx)))).toThrow("Task deps require a workflow context");
        }
        finally {
            try {
                api1.db.$client?.close?.();
            }
            catch { }
            try {
                api2.db.$client?.close?.();
            }
            catch { }
        }
    });
});
