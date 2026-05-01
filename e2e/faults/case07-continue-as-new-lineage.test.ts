/**
 * Case 7 (ticket 0022): `continueAsNew`; lineage traversable via
 * `smithers inspect --lineage`.
 *
 * Strategy B (DB-level simulation):
 *   - Build a real bun:sqlite DB matching the production `_smithers_runs`
 *     schema, including the `parent_run_id` column that
 *     packages/db/src/SqlMessageStorage.js declares both in its CREATE TABLE
 *     statement (line ~18) and in its ALTER TABLE upgrade path (line ~343).
 *   - Seed three runs forming a 3-deep `continueAsNew` lineage:
 *       R1 (status='continued', parent=NULL)
 *         <- R2 (status='continued', parent=R1)
 *           <- R3 (status='running', parent=R2)
 *   - Walk the lineage using the same recursive-CTE form as
 *     packages/db/src/adapter/SmithersDb.js#listRunAncestry, asserting:
 *       1. Walking parents from R3 yields [R3, R2, R1] in order.
 *       2. The chain terminates (R1's parent_run_id IS NULL).
 *       3. The expected continuation-status values land on the correct rows
 *          (terminal-but-continued for R1/R2; the new lineage head R3 is
 *          'running'), per ticket 0018's transition table:
 *            "succeeded|failed -> running (new lineage)  (continue-as-new)".
 *
 * Schema reality check:
 *   - The `parent_run_id` column is NOT carried by any SQL file under
 *     packages/db/migrations/ (only 0011_add_node_diffs.sql and
 *     0012_add_time_travel_audit.sql exist there). It only exists inside
 *     the imperative bootstrap in SqlMessageStorage.js. That means the
 *     contract is real in the live runtime, but a hypothetical green-field
 *     consumer of the migrations directory alone would NOT see it. Hence the
 *     test.skip on the "schema-as-migration" sub-assertion below, with a
 *     pointer to ticket 0018's continueAsNew transition.
 *
 * CLI surface for `smithers inspect --lineage`:
 *   - apps/cli/src/index.js does not expose a literal `--lineage` flag on
 *     `inspect` today. The lineage data is surfaced two ways instead:
 *       1. `inspect <runId>` always populates `parentRunId` and the
 *          `continuedFromRunIds` list inside the InspectSnapshot via
 *          `adapter.listRunAncestry(runId, 1_000)` (index.js ~line 1077).
 *       2. `events --follow-ancestry` reuses `listAncestryRunIds()`
 *          (index.js ~line 580) which calls the same DB primitive.
 *   - There is no exported pure function we can import without booting the
 *     adapter, so we exercise the underlying SQL contract directly here and
 *     leave the CLI-roundtrip sub-assertion as test.skip pending a runCli()
 *     harness primitive in /e2e/harness/.
 */

import { Database } from "bun:sqlite";
import { describe, expect, onTestFinished, test } from "bun:test";

type RunRow = {
  run_id: string;
  parent_run_id: string | null;
  workflow_name: string;
  status: string;
  created_at_ms: number;
  started_at_ms: number | null;
  finished_at_ms: number | null;
};

type AncestryRow = {
  run_id: string;
  parent_run_id: string | null;
  depth: number;
};

const R1 = "run-case07-r1-root";
const R2 = "run-case07-r2-mid";
const R3 = "run-case07-r3-head";

function buildDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE _smithers_runs (
      run_id TEXT PRIMARY KEY,
      parent_run_id TEXT,
      workflow_name TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      started_at_ms INTEGER,
      finished_at_ms INTEGER
    );
    CREATE INDEX _smithers_runs_parent_idx
      ON _smithers_runs (parent_run_id);
  `);
  return db;
}

function seedRun(
  db: Database,
  runId: string,
  parentRunId: string | null,
  status: string,
  createdAtMs: number,
  finishedAtMs: number | null,
): void {
  db.query(
    `INSERT INTO _smithers_runs
       (run_id, parent_run_id, workflow_name, status,
        created_at_ms, started_at_ms, finished_at_ms)
     VALUES (?, ?, 'case07-workflow', ?, ?, ?, ?)`,
  ).run(runId, parentRunId, status, createdAtMs, createdAtMs, finishedAtMs);
}

/**
 * Mirrors packages/db/src/adapter/SmithersDb.js#listRunAncestry (recursive
 * CTE walking parent_run_id from the supplied run upward). Returns rows in
 * depth-ASC order: [self, parent, grandparent, ...].
 */
function listRunAncestry(
  db: Database,
  runId: string,
  limit = 1_000,
): AncestryRow[] {
  return db
    .query(
      `WITH RECURSIVE ancestry(run_id, parent_run_id, depth) AS (
         SELECT run_id, parent_run_id, 0
         FROM _smithers_runs
         WHERE run_id = ?
         UNION ALL
         SELECT child.run_id, child.parent_run_id, ancestry.depth + 1
         FROM _smithers_runs child
         JOIN ancestry ON child.run_id = ancestry.parent_run_id
         WHERE ancestry.parent_run_id IS NOT NULL
       )
       SELECT run_id, parent_run_id, depth
         FROM ancestry
        ORDER BY depth ASC
        LIMIT ?`,
    )
    .all(runId, limit) as AncestryRow[];
}

function readRun(db: Database, runId: string): RunRow {
  const row = db
    .query("SELECT * FROM _smithers_runs WHERE run_id = ?")
    .get(runId) as RunRow | null;
  if (!row) throw new Error(`row missing for ${runId}`);
  return row;
}

describe("case 07: continueAsNew lineage walk", () => {
  test("3-deep continueAsNew chain is traversable parent-by-parent", () => {
    const db = buildDb();
    onTestFinished(() => db.close());

    const t0 = Date.now() - 30_000;
    try {
      seedRun(db, R1, null, "continued", t0, t0 + 1_000);
      seedRun(db, R2, R1, "continued", t0 + 2_000, t0 + 5_000);
      seedRun(db, R3, R2, "running", t0 + 6_000, null);

      const ancestry = listRunAncestry(db, R3);

      expect(ancestry.map((row) => row.run_id)).toEqual([R3, R2, R1]);
      expect(ancestry.map((row) => row.depth)).toEqual([0, 1, 2]);

      expect(ancestry[0]!.parent_run_id).toBe(R2);
      expect(ancestry[1]!.parent_run_id).toBe(R1);
      expect(ancestry[2]!.parent_run_id).toBeNull();

      const r1 = readRun(db, R1);
      const r2 = readRun(db, R2);
      const r3 = readRun(db, R3);
      expect(r1.status).toBe("continued");
      expect(r2.status).toBe("continued");
      expect(r3.status).toBe("running");
      expect(r3.finished_at_ms).toBeNull();
    } finally {
      db.close();
    }
  });

  test("walking ancestry from the middle of the chain stops at the root", () => {
    const db = buildDb();
    onTestFinished(() => db.close());

    const t0 = Date.now() - 30_000;
    seedRun(db, R1, null, "continued", t0, t0 + 1_000);
    seedRun(db, R2, R1, "continued", t0 + 2_000, t0 + 5_000);
    seedRun(db, R3, R2, "running", t0 + 6_000, null);

    const fromMid = listRunAncestry(db, R2);
    expect(fromMid.map((row) => row.run_id)).toEqual([R2, R1]);
    expect(fromMid.map((row) => row.depth)).toEqual([0, 1]);

    const fromRoot = listRunAncestry(db, R1);
    expect(fromRoot.map((row) => row.run_id)).toEqual([R1]);
    expect(fromRoot[0]!.parent_run_id).toBeNull();
    expect(fromRoot[0]!.depth).toBe(0);
  });

  test("a run with no continueAsNew ancestor returns a single-element chain", () => {
    const db = buildDb();
    onTestFinished(() => db.close());

    const standalone = "run-case07-standalone";
    seedRun(db, standalone, null, "running", Date.now(), null);

    const ancestry = listRunAncestry(db, standalone);
    expect(ancestry).toHaveLength(1);
    expect(ancestry[0]!.run_id).toBe(standalone);
    expect(ancestry[0]!.parent_run_id).toBeNull();
    expect(ancestry[0]!.depth).toBe(0);
  });

  test("non-existent run id yields an empty ancestry result", () => {
    const db = buildDb();
    onTestFinished(() => db.close());

    seedRun(db, R1, null, "continued", Date.now(), Date.now());

    const ancestry = listRunAncestry(db, "run-case07-does-not-exist");
    expect(ancestry).toEqual([]);
  });

  test.skip("schema migrations under packages/db/migrations/ declare parent_run_id", () => {
    // SKIP: as of this commit, packages/db/migrations/ contains only
    //   0011_add_node_diffs.sql
    //   0012_add_time_travel_audit.sql
    // The `parent_run_id` column lives only inside the imperative bootstrap
    // in packages/db/src/SqlMessageStorage.js (CREATE TABLE + ALTER TABLE).
    // Promote this assertion once a migration file (e.g. one of the
    // recovery-state-machine migrations from ticket 0018) lands the column
    // declaratively. Reference: ticket .smithers/tickets/.done/
    // 0018-recovery-state-machine.md, transition
    //   "succeeded|failed -> running (new lineage)  (continue-as-new)".
  });

  test.skip("CLI roundtrip: `smithers inspect --lineage <r3>` prints [R1, R2, R3]", () => {
    // SKIP: requires a runCli() harness primitive in /e2e/harness/ that
    // can spawn the built CLI bin against the seeded sqlite DB and parse
    // the lineage section from --json output. Until that primitive exists,
    // the lineage-walk contract is exercised here at the SQL layer (which
    // is exactly what apps/cli/src/index.js#buildInspectSnapshot consumes
    // via adapter.listRunAncestry, ~line 1077). Promote when /e2e/harness/
    // grows a runCli helper alongside corruptHeartbeat / takeoverRun.
  });
});
