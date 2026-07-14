/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import { z } from "zod";
import { Sequence, SmithersDb, Task, Workflow, runWorkflow } from "smithers-orchestrator";
import { diagnoseRunEffect } from "../../../apps/cli/src/why-diagnosis.js";
import { canonicalJson, digestProofRow } from "../../driver/src/provenance.js";
import { createTestSmithers } from "../../smithers/tests/helpers.js";

const schemas = {
    authority: z.object({ value: z.number(), verdict: z.string() }),
    result: z.object({ executed: z.boolean() }),
};

describe("provenance binding", () => {
    test("canonical row hashing is stable and excludes persistence identity", () => {
        const left = {
            runId: "run-a",
            nodeId: "authority",
            iteration: 1,
            verdict: "approve",
            nested: { z: 3, a: [2, { y: true, x: null }] },
        };
        const right = {
            nested: { a: [2, { x: null, y: true }], z: 3 },
            verdict: "approve",
            iteration: 99,
            nodeId: "different",
            runId: "run-b",
        };
        const expectedCanonical = '{"nested":{"a":[2,{"x":null,"y":true}],"z":3},"verdict":"approve"}';
        expect(canonicalJson({ nested: left.nested, verdict: left.verdict })).toBe(expectedCanonical);
        expect(digestProofRow(left)).toBe(digestProofRow(right));
        expect(digestProofRow(left)).toBe(`sha256:${createHash("sha256").update(expectedCanonical).digest("hex")}`);
    });

    test("stale authority parks, remains stale across resume, and unblocks when the row is re-produced", async () => {
        const { smithers, outputs, tables, db, cleanup } = createTestSmithers(schemas);
        const adapter = new SmithersDb(db);
        let tampered = false;
        let firstProof;
        let observedBoundStale = false;
        const workflow = smithers((ctx) => {
            const proof = ctx.prove(outputs.authority, { nodeId: "authority" });
            firstProof ??= proof;
            if (proof && !tampered) {
                tampered = true;
                // Real schedule-time race: mutate the durable authority row
                // after ctx.prove() captured it but before the engine submits
                // this render's graph to the scheduler.
                db.update(tables.authority)
                    .set({ value: 2 })
                    .where(and(eq(tables.authority.runId, ctx.runId), eq(tables.authority.nodeId, "authority"), eq(tables.authority.iteration, 0)))
                    .run();
            }
            observedBoundStale ||= ctx.boundStale("consumer");
            return (
                <Workflow name="provenance-binding-resume">
                    <Sequence>
                        <Task id="authority" output={outputs.authority}>
                            {{ value: 1, verdict: "approve" }}
                        </Task>
                        <Task id="consumer" output={outputs.result} bind={proof}>
                            {{ executed: true }}
                        </Task>
                    </Sequence>
                </Workflow>
            );
        });

        try {
            const first = await Effect.runPromise(runWorkflow(workflow, {
                input: {},
                runId: "provenance-binding-resume",
            }));
            expect(first.status).toBe("waiting-event");
            expect(firstProof).toEqual({
                table: "authority",
                nodeId: "authority",
                iteration: 0,
                digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
            });
            expect(observedBoundStale).toBe(true);

            const parkedNode = await adapter.getNode(first.runId, "consumer", 0);
            expect(parkedNode?.state).toBe("bound-stale");
            expect(await adapter.listAttempts(first.runId, "consumer", 0)).toHaveLength(0);
            expect(await db.select().from(tables.result)).toHaveLength(0);
            const parkedRun = await adapter.getRun(first.runId);
            expect(parkedRun?.status).toBe("waiting-event");
            expect(JSON.parse(parkedRun?.errorJson ?? "{}").code).toBe("BOUND_STALE");

            const diagnosis = await Effect.runPromise(diagnoseRunEffect(adapter, first.runId));
            expect(diagnosis.blockers).toContainEqual(expect.objectContaining({
                kind: "bound-stale",
                nodeId: "consumer",
                reason: expect.stringContaining("BOUND_STALE"),
            }));

            // A fresh workflow session must restore the original binding from
            // the durable frame. Re-rendering ctx.prove() over the mutated row
            // must not silently bless its new digest.
            const stillParked = await Effect.runPromise(runWorkflow(workflow, {
                input: {},
                runId: first.runId,
                resume: true,
            }));
            expect(stillParked.status).toBe("waiting-event");
            expect((await adapter.getNode(first.runId, "consumer", 0))?.state).toBe("bound-stale");
            expect(await adapter.listAttempts(first.runId, "consumer", 0)).toHaveLength(0);

            // Re-produce the exact authority content at the pinned row identity.
            await db.update(tables.authority)
                .set({ value: 1, verdict: "approve" })
                .where(and(eq(tables.authority.runId, first.runId), eq(tables.authority.nodeId, "authority"), eq(tables.authority.iteration, 0)));

            const resumed = await Effect.runPromise(runWorkflow(workflow, {
                input: {},
                runId: first.runId,
                resume: true,
            }));
            expect(resumed.status).toBe("finished");
            expect((await adapter.getNode(first.runId, "consumer", 0))?.state).toBe("finished");
            expect(await db.select().from(tables.result)).toEqual([
                expect.objectContaining({
                    runId: first.runId,
                    nodeId: "consumer",
                    iteration: 0,
                    executed: true,
                }),
            ]);
        }
        finally {
            cleanup();
        }
    }, 30_000);

    test("bind={undefined} waits without reporting stale or executing", async () => {
        const { smithers, outputs, db, cleanup } = createTestSmithers(schemas);
        const adapter = new SmithersDb(db);
        let observedStale = true;
        const workflow = smithers((ctx) => {
            observedStale = ctx.boundStale("consumer");
            return (
                <Workflow name="provenance-binding-missing">
                    <Task id="consumer" output={outputs.result} bind={undefined}>
                        {{ executed: true }}
                    </Task>
                </Workflow>
            );
        });
        try {
            const result = await Effect.runPromise(runWorkflow(workflow, {
                input: {},
                runId: "provenance-binding-missing",
            }));
            expect(result.status).toBe("waiting-event");
            expect(observedStale).toBe(false);
            expect((await adapter.getNode(result.runId, "consumer", 0))?.state).toBe("waiting-bound");
            expect(await adapter.listAttempts(result.runId, "consumer", 0)).toHaveLength(0);
        }
        finally {
            cleanup();
        }
    });
});
