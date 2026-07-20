/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Effect } from "effect";
import { Workflow, Task, runWorkflow } from "smithers-orchestrator";
import { createTestSmithers } from "../../smithers/tests/helpers.js";

const TIMEOUT_MS = 30_000;

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

// Pin the run to a VCS-free rootDir so the cache key's jj pointer is stable
// even when concurrent commits land in this repo while the test runs.
function stableRootDir() {
    return mkdtempSync(join(tmpdir(), "smithers-cache-root-"));
}

function cacheRows(dbPath) {
    const sqlite = new Database(dbPath);
    try {
        return sqlite.query("SELECT cache_key, payload_json FROM _smithers_cache").all();
    } finally {
        sqlite.close();
    }
}

async function run(workflow, opts) {
    const result = await Effect.runPromise(runWorkflow(workflow, opts));
    expect(result.status).toBe("finished");
    return result;
}

describe("cachePolicy.version invalidation", () => {
    test("bumping version misses the cache while the previous version's entry stays live", async () => {
        const { smithers, outputs, dbPath, cleanup } = createTestSmithers(outputShape());
        const counter = countingAgent("version");
        const rootDir = stableRootDir();
        try {
            const buildWorkflow = (version) =>
                smithers(() => (
                    <Workflow name="version-cache">
                        <Task id="t" output={outputs.out} agent={counter.agent} cache={{ scope: "workflow", key: "vkey", version }}>
                            same prompt
                        </Task>
                    </Workflow>
                ));
            const v1 = buildWorkflow("v1");
            const v2 = buildWorkflow("v2");

            await run(v1, { input: {}, runId: "version-r1", rootDir });
            expect(counter.calls).toBe(1);
            await run(v1, { input: {}, runId: "version-r2", rootDir });
            expect(counter.calls).toBe(1);

            await run(v2, { input: {}, runId: "version-r3", rootDir });
            expect(counter.calls).toBe(2);

            // The v1 entry was not evicted by the v2 miss: going back hits again.
            await run(v1, { input: {}, runId: "version-r4", rootDir });
            expect(counter.calls).toBe(2);

            expect(cacheRows(dbPath)).toHaveLength(2);
        } finally {
            cleanup();
        }
    }, TIMEOUT_MS);
});

describe("cachePolicy.by callback", () => {
    test("by payload derived from the run input keys the cache: same input hits, different input misses", async () => {
        const { smithers, outputs, cleanup } = createTestSmithers(outputShape());
        const counter = countingAgent("by-input");
        const rootDir = stableRootDir();
        try {
            const workflow = smithers(() => (
                <Workflow name="by-input-cache">
                    <Task
                        id="t"
                        output={outputs.out}
                        agent={counter.agent}
                        cache={{ scope: "workflow", key: "by-input", by: (ctx) => ({ topic: ctx.input.topic }) }}
                    >
                        same prompt
                    </Task>
                </Workflow>
            ));

            await run(workflow, { input: { topic: "alpha" }, runId: "by-input-r1", rootDir });
            expect(counter.calls).toBe(1);
            await run(workflow, { input: { topic: "alpha" }, runId: "by-input-r2", rootDir });
            expect(counter.calls).toBe(1);
            await run(workflow, { input: { topic: "beta" }, runId: "by-input-r3", rootDir });
            expect(counter.calls).toBe(2);
        } finally {
            cleanup();
        }
    }, TIMEOUT_MS);

    test("a throwing by callback disables caching for the task without failing the run", async () => {
        const { smithers, outputs, dbPath, cleanup } = createTestSmithers(outputShape());
        const counter = countingAgent("by-throws");
        const rootDir = stableRootDir();
        try {
            const workflow = smithers(() => (
                <Workflow name="by-throws-cache">
                    <Task
                        id="t"
                        output={outputs.out}
                        agent={counter.agent}
                        cache={{
                            scope: "workflow",
                            key: "by-throws",
                            by: () => {
                                throw new Error("cache-by boom");
                            },
                        }}
                    >
                        same prompt
                    </Task>
                </Workflow>
            ));

            await run(workflow, { input: {}, runId: "by-throws-r1", rootDir });
            await run(workflow, { input: {}, runId: "by-throws-r2", rootDir });

            // No caching: the task executed on every run and stored no cache row.
            expect(counter.calls).toBe(2);
            expect(cacheRows(dbPath)).toHaveLength(0);
        } finally {
            cleanup();
        }
    }, TIMEOUT_MS);

    test("by sees dependency outputs resolved through needs", async () => {
        const { smithers, outputs, cleanup } = createTestSmithers({
            dep: z.object({ v: z.number() }),
            out: z.object({ v: z.number() }),
        });
        const depCounter = countingAgent("by-needs-dep");
        const constantDep = {
            id: "by-needs-constant",
            tools: {},
            generate: async () => {
                depCounter.agent.generate();
                return { output: { v: 42 } };
            },
        };
        const counter = countingAgent("by-needs");
        const seenPayloads = [];
        const rootDir = stableRootDir();
        try {
            const workflow = smithers(() => (
                <Workflow name="by-needs-cache">
                    <Task id="dep-task" output={outputs.dep} agent={constantDep}>
                        produce dep
                    </Task>
                    <Task
                        id="t"
                        output={outputs.out}
                        agent={counter.agent}
                        needs={{ dep: "dep-task" }}
                        cache={{
                            scope: "workflow",
                            key: "by-needs",
                            by: (ctx) => {
                                seenPayloads.push(ctx.dep?.v);
                                return { depValue: ctx.dep?.v };
                            },
                        }}
                    >
                        consume dep
                    </Task>
                </Workflow>
            ));

            await run(workflow, { input: {}, runId: "by-needs-r1", rootDir });
            await run(workflow, { input: {}, runId: "by-needs-r2", rootDir });

            // The dep re-ran per run, but its constant output keyed the cache
            // so the consumer only executed once across both runs.
            expect(depCounter.calls).toBe(2);
            expect(counter.calls).toBe(1);
            expect(seenPayloads).toContain(42);
        } finally {
            cleanup();
        }
    }, TIMEOUT_MS);
});

describe("cachePolicy schema validation of cached rows", () => {
    test("a cached row that no longer matches the output schema is ignored, re-executed, and healed", async () => {
        const { smithers, outputs, dbPath, cleanup } = createTestSmithers(outputShape());
        const counter = countingAgent("schema-heal");
        const rootDir = stableRootDir();
        try {
            const workflow = smithers(() => (
                <Workflow name="schema-heal-cache">
                    <Task id="t" output={outputs.out} agent={counter.agent} cache={{ scope: "workflow", key: "schema-heal" }}>
                        same prompt
                    </Task>
                </Workflow>
            ));

            await run(workflow, { input: {}, runId: "schema-heal-r1", rootDir });
            expect(counter.calls).toBe(1);

            const sqlite = new Database(dbPath);
            try {
                sqlite
                    .query("UPDATE _smithers_cache SET payload_json = ?")
                    .run(JSON.stringify({ v: "not-a-number" }));
            } finally {
                sqlite.close();
            }

            // The corrupted entry fails output validation → miss → re-execute.
            await run(workflow, { input: {}, runId: "schema-heal-r2", rootDir });
            expect(counter.calls).toBe(2);

            // Re-execution upserted a fresh payload under the same key…
            const rows = cacheRows(dbPath);
            expect(rows).toHaveLength(1);
            expect(JSON.parse(rows[0].payload_json)).toMatchObject({ v: 2 });

            // …so a third run hits the healed entry.
            await run(workflow, { input: {}, runId: "schema-heal-r3", rootDir });
            expect(counter.calls).toBe(2);
        } finally {
            cleanup();
        }
    }, TIMEOUT_MS);

    test("a cache row with malformed JSON degrades to a miss instead of failing the attempt", async () => {
        // Regression: JSON.parse of a corrupt _smithers_cache payload used to
        // throw inside the task attempt (before the agent ran), so the default
        // infinite retry policy re-hit the same poisoned row forever.
        const { smithers, outputs, dbPath, cleanup } = createTestSmithers(outputShape());
        const counter = countingAgent("malformed-heal");
        const rootDir = stableRootDir();
        try {
            const workflow = smithers(() => (
                <Workflow name="malformed-heal-cache">
                    <Task id="t" output={outputs.out} agent={counter.agent} cache={{ scope: "workflow", key: "malformed-heal" }}>
                        same prompt
                    </Task>
                </Workflow>
            ));

            await run(workflow, { input: {}, runId: "malformed-heal-r1", rootDir });
            expect(counter.calls).toBe(1);

            const sqlite = new Database(dbPath);
            try {
                sqlite.query("UPDATE _smithers_cache SET payload_json = 'not json {'").run();
            } finally {
                sqlite.close();
            }

            await run(workflow, { input: {}, runId: "malformed-heal-r2", rootDir });
            expect(counter.calls).toBe(2);

            // Completion upserted a parseable payload back under the same key.
            const rows = cacheRows(dbPath);
            expect(rows).toHaveLength(1);
            expect(JSON.parse(rows[0].payload_json)).toMatchObject({ v: 2 });
        } finally {
            cleanup();
        }
    }, TIMEOUT_MS);
});
