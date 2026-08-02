/** @jsxImportSource smthrs */
/**
 * A/B equivalence for the incremental frame-snapshot cache: the same fixture
 * workflow runs once with SMITHERS_INCREMENTAL_FRAME_SNAPSHOTS=0 (the full
 * listNodes/loadInput/loadOutputs path) and once with the default incremental
 * path, and every persisted per-frame snapshot must carry identical content.
 * Snapshots feed resume/time-travel, so any divergence is a corrupted resume
 * waiting to happen. Comparison is canonical (sorted keys, order-insensitive
 * row arrays) — row order inside a snapshot is storage order and may legally
 * differ; timestamps/hashes are excluded the same way.
 *
 * A second test proves the cache actually engages: a task mutates the input
 * row out-of-band mid-run, which later frames only notice when they re-load
 * input from the DB — so the full path must see the mutation and the
 * incremental path must keep serving the seeded row.
 *
 * A third test covers the lost-patch safety valve: a completion whose output
 * row never reached the cache (simulated by committing an output row plus its
 * finished node row out-of-band, exactly what a completion racing a cache
 * reseed leaves behind) must force a full reload rather than persist a
 * snapshot with a finished node and no output row — the corruption that would
 * poison resume/time-travel for up to FRAME_KEYFRAME_INTERVAL frames.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Loop, Task, Workflow, runWorkflow } from "smthrs";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { z } from "zod";
import { Effect } from "effect";
import { loadSnapshot } from "@smthrs/time-travel";
import { SmithersDb } from "@smthrs/db/adapter";

const ENV_KEY = "SMITHERS_INCREMENTAL_FRAME_SNAPSHOTS";
const savedEnv = process.env[ENV_KEY];
afterEach(() => {
  if (savedEnv === undefined) {
    delete process.env[ENV_KEY];
  } else {
    process.env[ENV_KEY] = savedEnv;
  }
});
/**
 * @param {string | undefined} value
 */
function setIncrementalEnv(value) {
  if (value === undefined) {
    delete process.env[ENV_KEY];
  } else {
    process.env[ENV_KEY] = value;
  }
}
/**
 * @param {any} db
 */
function queryClient(db) {
  return db.$client ?? db.session?.client;
}
/**
 * @param {any} db
 * @param {string} runId
 * @returns {Array<{ frameNo: number; nodesJson: string; outputsJson: string; ralphJson: string; inputJson: string }>}
 */
function readSnapshots(db, runId) {
  return queryClient(db)
    .query(`SELECT
         frame_no AS frameNo,
         nodes_json AS nodesJson,
         outputs_json AS outputsJson,
         ralph_json AS ralphJson,
         input_json AS inputJson
       FROM _smithers_snapshots
      WHERE run_id = ?
      ORDER BY frame_no ASC`)
    .all(runId);
}
/**
 * Order-insensitive canonical form: object keys sorted, arrays sorted by the
 * canonical JSON of their elements. Applied identically to both runs, so any
 * content difference still fails while legal storage-order differences don't.
 * @param {unknown} value
 * @returns {unknown}
 */
function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize).sort((a, b) => {
      const aJson = JSON.stringify(a);
      const bJson = JSON.stringify(b);
      return aJson < bJson ? -1 : aJson > bJson ? 1 : 0;
    });
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(/** @type {Record<string, unknown>} */ (value)[key])]),
    );
  }
  return value;
}
const fixtureSchemas = {
  input: z.object({ tag: z.string() }),
  plan: z.object({ title: z.string(), urgent: z.boolean() }),
  step: z.object({ note: z.string(), meta: z.object({ round: z.number() }) }),
};
/**
 * Run the fixture (a task, a two-iteration loop task with a dep on it) under
 * the given env value and return the run result plus its per-frame snapshots.
 * @param {string | undefined} envValue
 * @param {string} runId
 */
async function runEquivalenceFixture(envValue, runId) {
  setIncrementalEnv(envValue);
  const { smithers, outputs, db, cleanup } = createTestSmithers(fixtureSchemas);
  try {
    const workflow = smithers((ctx) => {
      const ranTwice = ctx.iterationCount("step", "step") >= 2;
      return (
        <Workflow name="incremental-frame-equivalence">
          <Task id="plan" output={outputs.plan}>
            {{ title: "kickoff", urgent: true }}
          </Task>
          <Loop id="work-loop" until={ranTwice} maxIterations={4}>
            <Task id="step" output={outputs.step} needs={{ plan: "plan" }} deps={{ plan: outputs.plan }}>
              {(deps) => ({
                note: `after ${deps.plan.title}`,
                meta: { round: 1 },
              })}
            </Task>
          </Loop>
        </Workflow>
      );
    });
    const result = await Effect.runPromise(
      runWorkflow(workflow, {
        runId,
        input: { tag: "original" },
        maxConcurrency: 1,
      }),
    );
    const rows = readSnapshots(db, runId);
    const snapshots = await Promise.all(rows.map((row) => loadSnapshot(new SmithersDb(db), runId, row.frameNo)));
    return { result, snapshots };
  } finally {
    cleanup();
  }
}
describe("incremental frame snapshots", () => {
  test("per-frame snapshot content is equivalent with the cache on and off", async () => {
    const runId = "incremental-frame-equivalence";
    const full = await runEquivalenceFixture("0", runId);
    const incremental = await runEquivalenceFixture(undefined, runId);
    expect(full.result.status).toBe("finished");
    expect(incremental.result.status).toBe("finished");
    // Same frames on both sides — several of them, so the incremental path
    // exercised patched (not just seeded) snapshots.
    expect(incremental.snapshots.map((snap) => snap.frameNo)).toEqual(full.snapshots.map((snap) => snap.frameNo));
    expect(incremental.snapshots.length).toBeGreaterThanOrEqual(3);
    for (let i = 0; i < full.snapshots.length; i += 1) {
      const fullSnap = full.snapshots[i];
      const incrementalSnap = incremental.snapshots[i];
      for (const column of ["nodesJson", "outputsJson", "ralphJson", "inputJson"]) {
        expect(canonicalize(JSON.parse(incrementalSnap[column]))).toEqual(canonicalize(JSON.parse(fullSnap[column])));
      }
    }
    // Guard against trivially-equal empty snapshots: the final frame must
    // carry the finished nodes and every output row (including the json and
    // boolean columns, which take distinct decode paths on read-back).
    const finalSnapshot = incremental.snapshots[incremental.snapshots.length - 1];
    const finalOutputs = JSON.parse(finalSnapshot.outputsJson);
    expect(finalOutputs.plan).toEqual([
      {
        runId,
        nodeId: "plan",
        iteration: 0,
        title: "kickoff",
        urgent: true,
        __smithersProvenanceSeq: 0,
      },
    ]);
    expect(finalOutputs.step.length).toBeGreaterThanOrEqual(2);
    expect(finalOutputs.step[0]).toMatchObject({
      nodeId: "step",
      note: "after kickoff",
      meta: { round: 1 },
    });
    const finalNodes = JSON.parse(finalSnapshot.nodesJson);
    expect(finalNodes.filter((node) => node.state === "finished").length).toBeGreaterThanOrEqual(3);
    const finalRalph = JSON.parse(finalSnapshot.ralphJson);
    expect(finalRalph).toEqual([{ ralphId: "work-loop", iteration: 1, done: false }]);
    expect(JSON.parse(finalSnapshot.inputJson)).toEqual({
      runId,
      tag: "original",
    });
  }, 30_000);
  test("cache engages by default and the kill switch restores per-frame input loads", async () => {
    /**
     * @param {string | undefined} envValue
     * @param {string} runId
     */
    const runInputMutationFixture = async (envValue, runId) => {
      setIncrementalEnv(envValue);
      const { smithers, outputs, db, cleanup } = createTestSmithers({
        input: z.object({ tag: z.string() }),
        first: z.object({ ok: z.boolean() }),
        second: z.object({ ok: z.boolean() }),
      });
      try {
        const workflow = smithers(() => (
          <Workflow name="frame-cache-input-probe">
            <Task id="first" output={outputs.first}>
              {() => {
                // Out-of-band write the frame loads only see by re-reading
                // the input table.
                queryClient(db).run(`UPDATE input SET tag = 'mutated' WHERE run_id = '${runId}'`);
                return { ok: true };
              }}
            </Task>
            <Task id="second" output={outputs.second} dependsOn={["first"]}>
              {{ ok: true }}
            </Task>
          </Workflow>
        ));
        const result = await Effect.runPromise(
          runWorkflow(workflow, {
            runId,
            input: { tag: "original" },
            maxConcurrency: 1,
          }),
        );
        expect(result.status).toBe("finished");
        const snapshots = await Promise.all(
          readSnapshots(db, runId).map((row) => loadSnapshot(new SmithersDb(db), runId, row.frameNo)),
        );
        expect(snapshots.length).toBeGreaterThanOrEqual(2);
        return JSON.parse(snapshots[snapshots.length - 1].inputJson);
      } finally {
        cleanup();
      }
    };
    // Kill switch off (default): later frames serve the input row seeded on
    // the first frame — proof the incremental cache actually engaged.
    const cachedInput = await runInputMutationFixture(undefined, "frame-cache-probe-incremental");
    expect(cachedInput.tag).toBe("original");
    // Kill switch on: every frame re-loads input, so the final snapshot
    // must observe the mid-run mutation.
    const reloadedInput = await runInputMutationFixture("0", "frame-cache-probe-full");
    expect(reloadedInput.tag).toBe("mutated");
  }, 30_000);
  test("a finished node whose output row never reached the cache forces a full reload", async () => {
    setIncrementalEnv(undefined);
    const runId = "frame-cache-lost-patch";
    const { smithers, outputs, db, cleanup } = createTestSmithers({
      input: z.object({ tag: z.string() }),
      first: z.object({ ok: z.boolean() }),
      second: z.object({ ok: z.boolean() }),
      ghost: z.object({ note: z.string() }),
    });
    try {
      const workflow = smithers(() => (
        <Workflow name="frame-cache-lost-patch-probe">
          <Task id="first" output={outputs.first}>
            {() => {
              // Simulate a completion whose cache patch was lost: its
              // output row and finished node row are committed (the
              // atomic pair every real completion writes) but the frame
              // cache never hears about them. The next frame's node
              // listing sees the finished node, so serving the seeded
              // cache would persist a snapshot with no matching output
              // row — the cross-check must force a full reload instead.
              const client = queryClient(db);
              client.run(
                `INSERT INTO ghost (run_id, node_id, iteration, note) VALUES ('${runId}', 'ghost-node', 0, 'injected')`,
              );
              client.run(`INSERT INTO _smithers_nodes (run_id, node_id, iteration, state, last_attempt, updated_at_ms, output_table, label)
               VALUES ('${runId}', 'ghost-node', 0, 'finished', NULL, ${Date.now()}, 'ghost', NULL)`);
              return { ok: true };
            }}
          </Task>
          <Task id="second" output={outputs.second} dependsOn={["first"]}>
            {{ ok: true }}
          </Task>
        </Workflow>
      ));
      const result = await Effect.runPromise(
        runWorkflow(workflow, {
          runId,
          input: { tag: "original" },
          maxConcurrency: 1,
        }),
      );
      expect(result.status).toBe("finished");
      const snapshots = await Promise.all(
        readSnapshots(db, runId).map((row) => loadSnapshot(new SmithersDb(db), runId, row.frameNo)),
      );
      expect(snapshots.length).toBeGreaterThanOrEqual(2);
      // The invariant the full-load path always upheld (output row and
      // finished node commit atomically, nodes are read before outputs):
      // no frame may record a finished node whose in-schema output row
      // is absent.
      for (const snapshot of snapshots) {
        const nodes = JSON.parse(snapshot.nodesJson);
        const outputRows = JSON.parse(snapshot.outputsJson);
        for (const node of nodes) {
          if (node.state !== "finished" || !node.outputTable) continue;
          const rows = outputRows[node.outputTable];
          if (!rows) continue;
          expect(rows.some((row) => row.nodeId === node.nodeId && (row.iteration ?? 0) === (node.iteration ?? 0))).toBe(
            true,
          );
        }
      }
      // The frames after the injection run with the cache engaged again
      // (it reseeds on the reload), and the healed cache must carry the
      // injected row through to the final snapshot.
      const finalSnapshot = snapshots[snapshots.length - 1];
      expect(JSON.parse(finalSnapshot.outputsJson).ghost).toEqual([
        { runId, nodeId: "ghost-node", iteration: 0, note: "injected" },
      ]);
      const finalNodes = JSON.parse(finalSnapshot.nodesJson);
      expect(finalNodes).toContainEqual(
        expect.objectContaining({
          nodeId: "ghost-node",
          state: "finished",
          outputTable: "ghost",
        }),
      );
    } finally {
      cleanup();
    }
  }, 30_000);
});
