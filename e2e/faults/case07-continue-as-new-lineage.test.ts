/**
 * Case 7 (ticket 0022): `continueAsNew`; lineage traversable via
 * `smithers inspect --lineage`.
 *
 * REAL product path (no-mocks):
 *   - Build a real in-memory DB via `ensureSmithersTables` (the same schema the
 *     runtime bootstraps) and drive it through the real
 *     `@smthrs/db/adapter` `SmithersDb`.
 *   - Seed a 3-deep `continueAsNew` lineage with the real `adapter.insertRun`
 *     (which validates the row and writes `parent_run_id`):
 *       R1 (status='continued', parent=NULL)
 *         <- R2 (status='continued', parent=R1)
 *           <- R3 (status='running', parent=R2)
 *   - Walk it with the REAL `adapter.listRunAncestry(runId, limit)` — the exact
 *     recursive-CTE primitive that `apps/cli/src/index.js#buildInspectSnapshot`
 *     consumes for the inspect snapshot's `parentRunId` /
 *     `continuedFromRunIds`, and that `events --follow-ancestry` reuses. No SQL
 *     is reimplemented in-test; the assertions check the real adapter's output.
 *
 * This case previously fabricated its own `_smithers_runs` table and pasted a
 * copy of the recursive CTE into the test, so it validated a mock of the
 * contract rather than the product. The conversion below exercises the shipping
 * `listRunAncestry`, including its cycle-guard and depth-limit — behaviors the
 * hand-copied query did not have.
 */

import { describe, expect, onTestFinished, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SmithersDb } from "@smthrs/db/adapter";
import { ensureSmithersTables } from "@smthrs/db/ensure";

const R1 = "run-case07-r1-root";
const R2 = "run-case07-r2-mid";
const R3 = "run-case07-r3-head";

function buildAdapter(): { sqlite: Database; adapter: SmithersDb } {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return { sqlite, adapter: new SmithersDb(db) };
}

async function seedRun(
  adapter: SmithersDb,
  runId: string,
  parentRunId: string | null,
  status: string,
  createdAtMs: number,
  finishedAtMs: number | null,
): Promise<void> {
  await adapter.insertRun({
    runId,
    parentRunId,
    workflowName: "case07-workflow",
    status,
    createdAtMs,
    startedAtMs: createdAtMs,
    finishedAtMs,
  });
}

describe("case 07: continueAsNew lineage walk", () => {
  test("3-deep continueAsNew chain is traversable parent-by-parent", async () => {
    const { sqlite, adapter } = buildAdapter();
    onTestFinished(() => sqlite.close());

    const t0 = Date.now() - 30_000;
    await seedRun(adapter, R1, null, "continued", t0, t0 + 1_000);
    await seedRun(adapter, R2, R1, "continued", t0 + 2_000, t0 + 5_000);
    await seedRun(adapter, R3, R2, "running", t0 + 6_000, null);

    const ancestry = await adapter.listRunAncestry(R3);

    expect(ancestry.map((row) => row.runId)).toEqual([R3, R2, R1]);
    expect(ancestry.map((row) => row.depth)).toEqual([0, 1, 2]);

    expect(ancestry[0]!.parentRunId).toBe(R2);
    expect(ancestry[1]!.parentRunId).toBe(R1);
    expect(ancestry[2]!.parentRunId).toBeNull();

    const r1 = await adapter.getRun(R1);
    const r2 = await adapter.getRun(R2);
    const r3 = await adapter.getRun(R3);
    expect(r1?.status).toBe("continued");
    expect(r2?.status).toBe("continued");
    expect(r3?.status).toBe("running");
    expect(r3?.finishedAtMs ?? null).toBeNull();
  });

  test("walking ancestry from the middle of the chain stops at the root", async () => {
    const { sqlite, adapter } = buildAdapter();
    onTestFinished(() => sqlite.close());

    const t0 = Date.now() - 30_000;
    await seedRun(adapter, R1, null, "continued", t0, t0 + 1_000);
    await seedRun(adapter, R2, R1, "continued", t0 + 2_000, t0 + 5_000);
    await seedRun(adapter, R3, R2, "running", t0 + 6_000, null);

    const fromMid = await adapter.listRunAncestry(R2);
    expect(fromMid.map((row) => row.runId)).toEqual([R2, R1]);
    expect(fromMid.map((row) => row.depth)).toEqual([0, 1]);

    const fromRoot = await adapter.listRunAncestry(R1);
    expect(fromRoot.map((row) => row.runId)).toEqual([R1]);
    expect(fromRoot[0]!.parentRunId).toBeNull();
    expect(fromRoot[0]!.depth).toBe(0);
  });

  test("a run with no continueAsNew ancestor returns a single-element chain", async () => {
    const { sqlite, adapter } = buildAdapter();
    onTestFinished(() => sqlite.close());

    const standalone = "run-case07-standalone";
    await seedRun(adapter, standalone, null, "running", Date.now(), null);

    const ancestry = await adapter.listRunAncestry(standalone);
    expect(ancestry).toHaveLength(1);
    expect(ancestry[0]!.runId).toBe(standalone);
    expect(ancestry[0]!.parentRunId).toBeNull();
    expect(ancestry[0]!.depth).toBe(0);
  });

  test("non-existent run id yields an empty ancestry result", async () => {
    const { sqlite, adapter } = buildAdapter();
    onTestFinished(() => sqlite.close());

    await seedRun(adapter, R1, null, "continued", Date.now(), Date.now());

    const ancestry = await adapter.listRunAncestry("run-case07-does-not-exist");
    expect(ancestry).toEqual([]);
  });

  test("the real adapter honors the ancestry depth limit", async () => {
    const { sqlite, adapter } = buildAdapter();
    onTestFinished(() => sqlite.close());

    const t0 = Date.now() - 30_000;
    await seedRun(adapter, R1, null, "continued", t0, t0 + 1_000);
    await seedRun(adapter, R2, R1, "continued", t0 + 2_000, t0 + 5_000);
    await seedRun(adapter, R3, R2, "running", t0 + 6_000, null);

    // limit === 0 must short-circuit to no rows (the seed member is gated on
    // `? > 0`), and a limit shorter than the chain must truncate at the head.
    expect(await adapter.listRunAncestry(R3, 0)).toEqual([]);
    const capped = await adapter.listRunAncestry(R3, 2);
    expect(capped.map((row) => row.runId)).toEqual([R3, R2]);
  });

  test("the real adapter's cycle guard terminates a cyclic parent chain", async () => {
    const { sqlite, adapter } = buildAdapter();
    onTestFinished(() => sqlite.close());

    // A corrupt lineage where two runs point at each other. The hand-copied CTE
    // this case used to embed had NO visited-path guard and would recurse
    // without bound; the shipping `listRunAncestry` carries one, so the walk
    // must terminate and visit each run at most once.
    const t0 = Date.now() - 30_000;
    await seedRun(adapter, R1, R2, "continued", t0, t0 + 1_000);
    await seedRun(adapter, R2, R1, "running", t0 + 2_000, null);

    const ancestry = await adapter.listRunAncestry(R2);
    const ids = ancestry.map((row) => row.runId);
    expect(ids).toEqual([R2, R1]);
    // No run appears twice — the cycle back to R2 is pruned by the guard.
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("schema migrations declare parent_run_id and its lookup index", () => {
    const migrationSource = readFileSync(
      resolve(process.cwd(), "../packages/db/src/schema-migrations.js"),
      "utf8",
    );

    expect(migrationSource).toContain('["parent_run_id", "parent_run_id TEXT"]');
    expect(migrationSource).toContain(
      "CREATE INDEX IF NOT EXISTS _smithers_runs_parent_idx ON _smithers_runs (parent_run_id)",
    );
  });

  test.skip("CLI roundtrip: `smithers inspect --lineage <r3>` prints [R1, R2, R3]", () => {
    // SKIP: requires a runCli() harness primitive in /e2e/harness/ that
    // can spawn the built CLI bin against the seeded sqlite DB and parse
    // the lineage section from --json output. Until that primitive exists,
    // the lineage-walk contract is exercised here against the real
    // adapter.listRunAncestry — exactly what apps/cli/src/index.js
    // #buildInspectSnapshot consumes (~line 1077). Promote when /e2e/harness/
    // grows a runCli helper alongside corruptHeartbeat / takeoverRun.
  });
});
