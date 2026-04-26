/** @jsxImportSource smithers-orchestrator */
// Tests for cachePolicy.ttlMs and cachePolicy.scope.
//
// These options are declared on `CachePolicy` in
// packages/scheduler/src/CachePolicy.ts, but the engine implementation
// in packages/engine/src/engine.js does NOT consult `ttlMs` or `scope`
// when computing or invalidating cache keys (it only honors `by`,
// `version`, and `key`). The tests below are kept skipped with FIXMEs
// so they fail loudly the moment those features land.
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Effect } from "effect";
import { Workflow, Task, runWorkflow } from "smithers-orchestrator";
import { createTestSmithers } from "../../smithers/tests/helpers.js";

describe("cachePolicy.ttlMs (FIXME: not yet implemented in engine)", () => {
    test.skip("FIXME(cache-ttl): ttlMs expiration causes re-execution", async () => {
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

describe("cachePolicy.scope (FIXME: not yet implemented in engine)", () => {
    test.skip("FIXME(cache-scope): scope=run keeps cache local to a single run", async () => {
        // With scope=run, two separate runs of the same workflow with the
        // same prompt should each re-execute (cache must NOT be shared
        // across runIds).
        expect(true).toBe(true);
    });
    test.skip("FIXME(cache-scope): scope=workflow shares cache across runs of the same workflow", async () => {
        expect(true).toBe(true);
    });
    test.skip("FIXME(cache-scope): scope=global shares across distinct workflows", async () => {
        expect(true).toBe(true);
    });
    test.skip("FIXME(cache-scope-collisions): two tasks with the same key but different scopes do not collide", async () => {
        expect(true).toBe(true);
    });
});
