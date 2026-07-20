/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { Loop, Sequence, Task, Workflow, runWorkflow } from "smithers-orchestrator";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { z } from "zod";
import { Effect } from "effect";

const schemas = {
    input: z.object({}),
    find: z.object({ done: z.boolean() }),
    fable: z.object({ note: z.string() }),
    impl: z.object({ status: z.string() }),
    verify: z.object({ passed: z.boolean() }),
};

describe("dependsOn onto a needs-deferred task inside a Loop", () => {
    test("dependsOn onto a needs-deferred task resolves once the chain mounts (regression: ddd-test-coverage deadlock)", async () => {
        const { smithers, outputs, cleanup } = createTestSmithers(schemas);
        try {
            const agent = {
                id: "fake",
                model: "fake",
                cliEngine: "fake-cli",
                tools: {},
                async generate({ prompt }) {
                    if (prompt.includes("FIND")) return { output: { done: true } };
                    if (prompt.includes("FABLE")) return { output: { note: "ok" } };
                    return { output: { status: "done" } };
                },
            };
            const workflow = smithers((ctx) => (
                <Workflow name="deferred-dependson">
                    <Loop id="loop" until={() => true} maxIterations={2} onMaxReached="return-last">
                        <Sequence>
                            <Task id="find-candidates" output={outputs.find} agent={agent}>
                                FIND things
                            </Task>
                            <Task
                                id="fable-check"
                                output={outputs.fable}
                                agent={agent}
                                dependsOn={["find-candidates"]}
                                needs={{ find: "find-candidates" }}
                                deps={{ find: outputs.find }}
                            >
                                {(deps) => `FABLE check ${JSON.stringify(deps.find)}`}
                            </Task>
                            <Task
                                id="implement"
                                output={outputs.impl}
                                agent={agent}
                                dependsOn={["fable-check"]}
                                needs={{ find: "find-candidates", fable: "fable-check" }}
                                deps={{ find: outputs.find, fable: outputs.fable }}
                            >
                                {(deps) => `IMPLEMENT ${JSON.stringify(deps.fable)}`}
                            </Task>
                            <Task id="verify" output={outputs.verify} dependsOn={["implement"]}>
                                {async () => ({ passed: true })}
                            </Task>
                        </Sequence>
                    </Loop>
                </Workflow>
            ));
            const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
            expect(result.error?.message ?? "").not.toContain("deadlock");
            expect(result.status).toBe("finished");
        } finally {
            cleanup();
        }
    }, 30_000);
});
