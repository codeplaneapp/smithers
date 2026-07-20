/** @jsxImportSource smithers-orchestrator */
// Spike acceptance criterion (b) for the durable-knowledge substrate
// (upstream-memory RFC): the CONSOLIDATION flow — N observation notes are
// superseded by ONE synthesis via an Approval-gated workflow — run end-to-end
// under the real engine (runWorkflow → waiting-approval → approve/deny →
// resume), with provenance stamped from the run's actual coordinates.
//
// The gate itself is an ordinary approval-gated task: storage only remembers
// the answer (the synthesis note's status), exactly the userland pattern the
// RFC proposes. While the gate is open the synthesis is PENDING, so the
// default read contract still returns the original observations — approving
// flips visibility atomically with the status write; denying leaves the
// corpus untouched.
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Sequence, Task, Workflow, runWorkflow, approveNode, denyNode, createMemoryStore, } from "../src/index.js";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { Effect } from "effect";
import { dirname } from "node:path";
import { createTestSmithers } from "./helpers.js";

const NS = { kind: "user", id: "consolidation-spike" };

const schemas = {
    consolidation: z.object({ noteId: z.string() }),
    ratification: z.object({ ratifiedNoteId: z.string() }),
};

function runInTestRoot(workflow, dbPath, opts) {
    return Effect.runPromise(runWorkflow(workflow, {
        ...opts,
        rootDir: dirname(dbPath),
    }));
}

/** Build the consolidation workflow + seed the observation corpus. */
async function setup() {
    const api = createTestSmithers(schemas);
    const { smithers, outputs, tables, db, dbPath } = api;
    ensureSmithersTables(db);
    const store = createMemoryStore(db);
    const observations = [];
    for (const body of [
        "obs: deploys fail on Tuesdays",
        "obs: deploys fail when the cache is cold",
        "obs: deploys fail under peak load",
    ]) {
        observations.push(await store.saveNote({ namespace: NS, body }));
    }
    const workflow = smithers((ctx) => (<Workflow name="consolidate-memory">
      <Sequence>
        <Task id="consolidate" output={outputs.consolidation}>
          {async () => {
            // The consolidator: writes the synthesis PENDING, superseding the
            // observations, stamped with this run's coordinates. In production
            // this is an agent+tool; the seam under test is the substrate.
            const synthesis = await store.saveNote({
                namespace: NS,
                body: "synthesis: deploys fail whenever the cache is cold (Tuesday + peak-load reports are the same root cause)",
                status: "pending",
                supersedes: observations.map((o) => o.id),
                provenance: { runId: ctx.runId, nodeId: "consolidate", iteration: 0 },
            });
            return { noteId: synthesis.id };
        }}
        </Task>
        <Task id="ratify" output={outputs.ratification} needsApproval>
          {async () => {
            // Post-approval: flip the synthesis to accepted — the ONE mutable
            // write. Read the note id from the durable output table (a closure
            // variable would not survive the resume across processes).
            const rows = await db.select().from(tables.consolidation);
            const noteId = rows[0].noteId;
            await store.setNoteStatus(noteId, "accepted");
            return { ratifiedNoteId: noteId };
        }}
        </Task>
      </Sequence>
    </Workflow>));
    return { ...api, store, observations, workflow };
}

describe("consolidation under the engine (criterion b)", () => {
    test("approve path: gate parks the run, synthesis stays pending until approval, then hides the N", async () => {
        const { workflow, dbPath, db, store, observations, cleanup } = await setup();
        // Run 1: consolidate executes, ratify parks at the gate.
        const r1 = await runInTestRoot(workflow, dbPath, { input: {} });
        expect(r1.status).toBe("waiting-approval");
        // MID-GATE INVARIANT (criterion c, live): the pending synthesis hides
        // nothing — the default read still returns all 3 observations.
        const midGate = await store.listNotes(NS);
        expect(midGate.map((n) => n.body).sort()).toEqual(observations.map((o) => o.body).sort());
        const pending = await store.listNotes(NS, { status: "pending" });
        expect(pending).toHaveLength(1);
        const synthesis = pending[0];
        // P1 under the engine: the synthesis carries the run's REAL coordinates.
        expect(synthesis.runId).toBe(r1.runId);
        expect(synthesis.nodeId).toBe("consolidate");
        // Approve + resume: ratify runs, flips the synthesis to accepted.
        const adapter = new SmithersDb(db);
        await Effect.runPromise(approveNode(adapter, r1.runId, "ratify", 0, "ship it", "spike-tester"));
        const r2 = await runInTestRoot(workflow, dbPath, { input: {}, runId: r1.runId, resume: true });
        expect(r2.status).toBe("finished");
        // THE CONSOLIDATION READ (criterion b): default read = the synthesis
        // alone; the 3 observations are hidden; widening shows all 4.
        const after = await store.listNotes(NS);
        expect(after.map((n) => n.id)).toEqual([synthesis.id]);
        const widened = await store.listNotes(NS, { includeSuperseded: true, status: "any" });
        expect(widened).toHaveLength(4);
        cleanup();
    }, 30_000);

    test("deny path: rejection leaves the corpus untouched and the synthesis dead", async () => {
        const { workflow, dbPath, db, store, observations, cleanup } = await setup();
        const r1 = await runInTestRoot(workflow, dbPath, { input: {} });
        expect(r1.status).toBe("waiting-approval");
        const adapter = new SmithersDb(db);
        await Effect.runPromise(denyNode(adapter, r1.runId, "ratify", 0, "not convinced", "spike-tester"));
        const r2 = await runInTestRoot(workflow, dbPath, { input: {}, runId: r1.runId, resume: true });
        // Denial fails the gated node (default onDeny) — the flow ends without
        // the status flip. Storage remembers only what actually happened.
        expect(r2.status).not.toBe("finished");
        const after = await store.listNotes(NS);
        expect(after.map((n) => n.body).sort()).toEqual(observations.map((o) => o.body).sort());
        const stillPending = await store.listNotes(NS, { status: "pending" });
        expect(stillPending).toHaveLength(1);
        cleanup();
    }, 30_000);
});
