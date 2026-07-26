/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import { z } from "zod";
import { Loop, Parallel, Sequence, SmithersDb, Task, Workflow, runWorkflow } from "smithers-orchestrator";
import { diagnoseRunEffect } from "../../../apps/cli/src/why-diagnosis.js";
import { SmithersCtx } from "../../driver/src/SmithersCtx.js";
import { canonicalJson, digestProofRow } from "../../driver/src/provenance.js";
import { pinTaskProofBindings, verifyTaskProofBindings } from "../src/provenance.js";
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

  test("canonical JSON serializes sparse array holes as null", () => {
    const sparse = [];
    sparse.length = 3;
    sparse[1] = { b: 2, a: 1 };

    expect(canonicalJson(sparse)).toBe('[null,{"a":1,"b":2},null]');
    expect(canonicalJson(sparse)).toBe(JSON.stringify([null, { a: 1, b: 2 }, null]));
  });

  test("ctx.prove selects the latest row by default and an explicit iteration when requested", () => {
    const rows = [
      { runId: "run-prove", nodeId: "authority", iteration: 0, value: 1, verdict: "first" },
      { runId: "run-prove", nodeId: "authority", iteration: 2, value: 3, verdict: "latest" },
      { runId: "run-prove", nodeId: "authority", iteration: 1, value: 2, verdict: "middle" },
    ];
    const ctx = new SmithersCtx({
      runId: "run-prove",
      iteration: 2,
      input: {},
      outputs: { authority: rows },
    });

    expect(ctx.prove("authority", { nodeId: "authority" })).toEqual({
      table: "authority",
      nodeId: "authority",
      iteration: 2,
      digest: digestProofRow(rows[1]),
    });
    expect(ctx.prove("authority", { nodeId: "authority", iteration: 0 })).toEqual({
      table: "authority",
      nodeId: "authority",
      iteration: 0,
      digest: digestProofRow(rows[0]),
    });
    expect(ctx.prove("authority", { nodeId: "authority", iteration: 9 })).toBeUndefined();
  });

  test("ctx.boundStale only reports the current task iteration", () => {
    const olderStale = new SmithersCtx({
      runId: "run-bound-state",
      iteration: 1,
      input: {},
      outputs: {},
      taskStates: new Map([["consumer::0", "bound-stale"]]),
      taskIterations: new Map([["consumer", 1]]),
    });
    const currentStale = new SmithersCtx({
      runId: "run-bound-state",
      iteration: 1,
      input: {},
      outputs: {},
      taskStates: new Map([
        ["consumer::0", "finished"],
        ["consumer::1", "bound-stale"],
      ]),
    });

    expect(olderStale.boundStale("consumer")).toBe(false);
    expect(currentStale.boundStale("consumer")).toBe(true);
  });

  test("repins mixed binding arrays per row identity", () => {
    const authorityA0 = { nodeId: "authority-a", iteration: 0, value: 1 };
    const authorityA1 = { nodeId: "authority-a", iteration: 1, value: 2 };
    const authorityB0 = { nodeId: "authority-b", iteration: 0, value: 10 };
    const mutatedB0 = { nodeId: "authority-b", iteration: 0, value: 11 };
    const pinned = new Map([
      [
        "consumer::0",
        [
          { table: "authority", nodeId: "authority-a", iteration: 0, digest: digestProofRow(authorityA0) },
          { table: "authority", nodeId: "authority-b", iteration: 0, digest: digestProofRow(authorityB0) },
        ],
      ],
    ]);
    const task = {
      nodeId: "consumer",
      iteration: 0,
      proofBindingRequired: true,
      proofBindings: [
        { table: "authority", nodeId: "authority-a", iteration: 1, digest: digestProofRow(authorityA1) },
        { table: "authority", nodeId: "authority-b", iteration: 0, digest: digestProofRow(mutatedB0) },
      ],
    };

    pinTaskProofBindings([task], pinned);
    verifyTaskProofBindings([task], { authority: [authorityA1, mutatedB0] });

    expect(task.proofBindings).toEqual([
      { table: "authority", nodeId: "authority-a", iteration: 1, digest: digestProofRow(authorityA1) },
      { table: "authority", nodeId: "authority-b", iteration: 0, digest: digestProofRow(authorityB0) },
    ]);
    expect(task.proofBindingStatus).toBe("stale");
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
          .where(
            and(
              eq(tables.authority.runId, ctx.runId),
              eq(tables.authority.nodeId, "authority"),
              eq(tables.authority.iteration, 0),
            ),
          )
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
      const first = await Effect.runPromise(
        runWorkflow(workflow, {
          input: {},
          runId: "provenance-binding-resume",
        }),
      );
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
      expect(diagnosis.blockers).toContainEqual(
        expect.objectContaining({
          kind: "bound-stale",
          nodeId: "consumer",
          reason: expect.stringContaining("BOUND_STALE"),
        }),
      );

      // A fresh workflow session must restore the original binding from
      // the durable frame. Re-rendering ctx.prove() over the mutated row
      // must not silently bless its new digest.
      const stillParked = await Effect.runPromise(
        runWorkflow(workflow, {
          input: {},
          runId: first.runId,
          resume: true,
        }),
      );
      expect(stillParked.status).toBe("waiting-event");
      expect((await adapter.getNode(first.runId, "consumer", 0))?.state).toBe("bound-stale");
      expect(await adapter.listAttempts(first.runId, "consumer", 0)).toHaveLength(0);

      // Re-produce the exact authority content at the pinned row identity.
      await db
        .update(tables.authority)
        .set({ value: 1, verdict: "approve" })
        .where(
          and(
            eq(tables.authority.runId, first.runId),
            eq(tables.authority.nodeId, "authority"),
            eq(tables.authority.iteration, 0),
          ),
        );

      const resumed = await Effect.runPromise(
        runWorkflow(workflow, {
          input: {},
          runId: first.runId,
          resume: true,
        }),
      );
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
    } finally {
      cleanup();
    }
  }, 30_000);

  test("a later authority iteration is genuinely produced after durable resume and repins only that identity", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers(schemas);
    const adapter = new SmithersDb(db);
    let tampered = false;
    const workflow = smithers((ctx) => {
      const stale = ctx.boundStale("consumer");
      const latest = ctx.latest(outputs.authority, "authority");
      const proof = ctx.prove(outputs.authority, { nodeId: "authority" });
      if (proof && !tampered) {
        tampered = true;
        db.update(tables.authority)
          .set({ value: 99 })
          .where(
            and(
              eq(tables.authority.runId, ctx.runId),
              eq(tables.authority.nodeId, "authority"),
              eq(tables.authority.iteration, 0),
            ),
          )
          .run();
      }
      return (
        <Workflow name="provenance-later-iteration">
          <Sequence>
            {stale ? (
              <Loop id="authority-correction" until={latest?.value === 2} maxIterations={3}>
                <Task id="authority" output={outputs.authority}>
                  {{ value: 2, verdict: "approve" }}
                </Task>
              </Loop>
            ) : (
              <Task id="authority" output={outputs.authority}>
                {{ value: 1, verdict: "approve" }}
              </Task>
            )}
            <Task id="consumer" output={outputs.result} bind={proof}>
              {{ executed: true }}
            </Task>
          </Sequence>
        </Workflow>
      );
    });

    try {
      const first = await Effect.runPromise(
        runWorkflow(workflow, {
          input: {},
          runId: "provenance-later-iteration",
        }),
      );
      expect(first.status).toBe("waiting-event");
      expect((await adapter.getNode(first.runId, "consumer", 0))?.state).toBe("bound-stale");

      // Advance the durable correction-loop cursor as a resumed process
      // would observe it after the authority producer is re-entered.
      await Effect.runPromise(
        adapter.insertOrUpdateRalph({
          runId: first.runId,
          ralphId: "authority-correction",
          iteration: 1,
          done: false,
          updatedAtMs: Date.now(),
        }),
      );

      const resumed = await Effect.runPromise(
        runWorkflow(workflow, {
          input: {},
          runId: first.runId,
          resume: true,
        }),
      );
      expect(resumed.status).toBe("finished");
      expect(await db.select().from(tables.authority)).toEqual(
        expect.arrayContaining([expect.objectContaining({ nodeId: "authority", iteration: 1, value: 2 })]),
      );
      expect((await adapter.getNode(first.runId, "consumer", 0))?.state).toBe("finished");
    } finally {
      cleanup();
    }
  }, 30_000);

  test("retry dispatch revalidates its binding and parks without creating another failed attempt", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers(schemas);
    const adapter = new SmithersDb(db);
    let consumerCalls = 0;
    const workflow = smithers((ctx) => {
      const proof = ctx.prove(outputs.authority, { nodeId: "authority" });
      return (
        <Workflow name="provenance-retry-revalidation">
          <Sequence>
            <Task id="authority" output={outputs.authority}>
              {{ value: 1, verdict: "approve" }}
            </Task>
            <Task
              id="consumer"
              output={outputs.result}
              bind={proof}
              retries={1}
              retryPolicy={{ backoff: "fixed", initialDelayMs: 1 }}
            >
              {() => {
                consumerCalls += 1;
                if (consumerCalls === 1) {
                  db.update(tables.authority)
                    .set({ value: 2 })
                    .where(
                      and(
                        eq(tables.authority.runId, ctx.runId),
                        eq(tables.authority.nodeId, "authority"),
                        eq(tables.authority.iteration, 0),
                      ),
                    )
                    .run();
                  throw new Error("fail after mutating authority");
                }
                return { executed: true };
              }}
            </Task>
          </Sequence>
        </Workflow>
      );
    });

    try {
      const result = await Effect.runPromise(
        runWorkflow(workflow, {
          input: {},
          runId: "provenance-retry-revalidation",
        }),
      );
      expect(result.status).toBe("waiting-event");
      expect(consumerCalls).toBe(1);
      expect((await adapter.getNode(result.runId, "consumer", 0))?.state).toBe("bound-stale");
      expect(await adapter.listAttempts(result.runId, "consumer", 0)).toHaveLength(1);
      expect(await db.select().from(tables.result)).toHaveLength(0);
      expect(JSON.parse((await adapter.getRun(result.runId))?.errorJson ?? "{}").code).toBe("BOUND_STALE");
    } finally {
      cleanup();
    }
  }, 30_000);

  test("parallel stale tasks are all persisted and enumerated by why diagnostics", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers(schemas);
    const adapter = new SmithersDb(db);
    let tampered = false;
    const workflow = smithers((ctx) => {
      const proof = ctx.prove(outputs.authority, { nodeId: "authority" });
      if (proof && !tampered) {
        tampered = true;
        db.update(tables.authority)
          .set({ value: 2 })
          .where(
            and(
              eq(tables.authority.runId, ctx.runId),
              eq(tables.authority.nodeId, "authority"),
              eq(tables.authority.iteration, 0),
            ),
          )
          .run();
      }
      return (
        <Workflow name="provenance-parallel-stale">
          <Sequence>
            <Task id="authority" output={outputs.authority}>
              {{ value: 1, verdict: "approve" }}
            </Task>
            <Parallel>
              <Task id="consumer-a" output={outputs.result} bind={proof}>
                {{ executed: true }}
              </Task>
              <Task id="consumer-b" output={outputs.result} bind={proof}>
                {{ executed: true }}
              </Task>
            </Parallel>
          </Sequence>
        </Workflow>
      );
    });

    try {
      const result = await Effect.runPromise(
        runWorkflow(workflow, {
          input: {},
          runId: "provenance-parallel-stale",
        }),
      );
      expect(result.status).toBe("waiting-event");
      expect((await adapter.getNode(result.runId, "consumer-a", 0))?.state).toBe("bound-stale");
      expect((await adapter.getNode(result.runId, "consumer-b", 0))?.state).toBe("bound-stale");

      const diagnosis = await Effect.runPromise(diagnoseRunEffect(adapter, result.runId));
      const staleBlockers = diagnosis.blockers.filter((blocker) => blocker.kind === "bound-stale");
      expect(staleBlockers.map((blocker) => blocker.nodeId).sort()).toEqual(["consumer-a", "consumer-b"]);
      expect(staleBlockers.every((blocker) => blocker.context?.includes("authority/authority (iteration 0)"))).toBe(
        true,
      );
    } finally {
      cleanup();
    }
  }, 30_000);

  test("bind={[]} waits like bind={undefined} instead of dispatching unproven", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers(schemas);
    const adapter = new SmithersDb(db);
    const workflow = smithers(() => (
      <Workflow name="provenance-binding-empty">
        <Sequence>
          <Task id="unbound" output={outputs.result}>
            {{ executed: true }}
          </Task>
          <Task id="consumer" output={outputs.result} bind={[]}>
            {{ executed: true }}
          </Task>
        </Sequence>
      </Workflow>
    ));
    try {
      const result = await Effect.runPromise(
        runWorkflow(workflow, {
          input: {},
          runId: "provenance-binding-empty",
        }),
      );
      expect(result.status).toBe("waiting-event");
      expect((await adapter.getNode(result.runId, "unbound", 0))?.state).toBe("finished");
      expect((await adapter.getNode(result.runId, "consumer", 0))?.state).toBe("waiting-bound");
      expect(await adapter.listAttempts(result.runId, "consumer", 0)).toHaveLength(0);
      expect(await db.select().from(tables.result)).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  test("an empty binding list never verifies as current", () => {
    const task = { nodeId: "consumer", iteration: 0, proofBindingRequired: true, proofBindings: [] };
    verifyTaskProofBindings([task], {});
    expect(task.proofBindingStatus).toBe("missing");
  });

  test("omitting bind executes while bind={undefined} waits without reporting stale", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers(schemas);
    const adapter = new SmithersDb(db);
    let observedStale = true;
    const workflow = smithers((ctx) => {
      observedStale = ctx.boundStale("consumer");
      return (
        <Workflow name="provenance-binding-missing">
          <Sequence>
            <Task id="unbound" output={outputs.result}>
              {{ executed: true }}
            </Task>
            <Task id="consumer" output={outputs.result} bind={undefined}>
              {{ executed: true }}
            </Task>
          </Sequence>
        </Workflow>
      );
    });
    try {
      const result = await Effect.runPromise(
        runWorkflow(workflow, {
          input: {},
          runId: "provenance-binding-missing",
        }),
      );
      expect(result.status).toBe("waiting-event");
      expect(observedStale).toBe(false);
      expect((await adapter.getNode(result.runId, "unbound", 0))?.state).toBe("finished");
      expect((await adapter.getNode(result.runId, "consumer", 0))?.state).toBe("waiting-bound");
      expect(await adapter.listAttempts(result.runId, "consumer", 0)).toHaveLength(0);
      expect(await db.select().from(tables.result)).toHaveLength(1);
    } finally {
      cleanup();
    }
  });
});
