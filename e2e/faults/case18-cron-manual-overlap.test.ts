/**
 * Case 18 (ticket 0022): a cron-fired launch and a manual launch of the same
 * workflow currently produce two distinct runs (no dedupe policy), and an
 * identical run_id collapses to a single row.
 *
 * REAL product path (no-mocks):
 *   - Build a real in-memory DB via `ensureSmithersTables` and drive it through
 *     the real `@smthrs/db/adapter` `SmithersDb`.
 *   - Cron rows go through the REAL `adapter.upsertCron` / `adapter.listCrons` /
 *     `adapter.updateCronRunTime`; run rows through the REAL `adapter.insertRun`
 *     (whose INSERT-OR-IGNORE is exactly the dedupe-by-run_id mechanism this case
 *     asserts); runs are read back through the REAL `adapter.listRuns(...)`
 *     workflow filter.
 *
 * This case previously fabricated its own `_smithers_runs` and `_smithers_cron`
 * tables and reimplemented every insert/read with raw SQL, validating a mock of
 * the contract. It also seeded runs with status `pending`, which is NOT a member
 * of DB_RUN_ALLOWED_STATUSES and which the real `insertRun` rejects — so the
 * conversion uses a real launch status (`running`) and encodes the trigger
 * source in the run's `configJson`, matching how the product records it.
 */

import { describe, expect, onTestFinished, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "@smthrs/db/adapter";
import { ensureSmithersTables } from "@smthrs/db/ensure";

const WORKFLOW_PATH = "workflows/case18.tsx";
const WORKFLOW_NAME = "case18-workflow";
const CRON_PATTERN = "*/5 * * * *";

function buildAdapter(): { sqlite: Database; adapter: SmithersDb } {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return { sqlite, adapter: new SmithersDb(db) };
}

async function seedCron(adapter: SmithersDb, cronId: string, nowMs: number): Promise<void> {
  await adapter.upsertCron({
    cronId,
    pattern: CRON_PATTERN,
    workflowPath: WORKFLOW_PATH,
    enabled: true,
    createdAtMs: nowMs,
    lastRunAtMs: null,
    nextRunAtMs: nowMs - 1,
  });
}

function createRunId(suffix: string): string {
  return `run_${Date.now().toString(36)}_${suffix}`;
}

async function triggerRun(
  adapter: SmithersDb,
  runId: string,
  triggerSource: "cron" | "manual",
  nowMs: number,
): Promise<void> {
  await adapter.insertRun({
    runId,
    workflowName: WORKFLOW_NAME,
    workflowPath: WORKFLOW_PATH,
    status: "running",
    createdAtMs: nowMs,
    configJson: JSON.stringify({ triggerSource }),
  });
}

type RunRecord = { runId: string; configJson: string | null };

async function readRunsForWorkflow(adapter: SmithersDb): Promise<RunRecord[]> {
  const rows = await adapter.listRuns(50, undefined, WORKFLOW_NAME);
  return rows.map((r) => ({
    runId: r.runId as string,
    configJson: (r.configJson ?? null) as string | null,
  }));
}

async function readCron(adapter: SmithersDb, cronId: string): Promise<Record<string, unknown>> {
  const rows = await adapter.listCrons(false);
  const row = rows.find((r) => r.cronId === cronId);
  if (!row) throw new Error(`cron missing for ${cronId}`);
  return row;
}

function parseTriggerSource(configJson: string | null): string | null {
  if (!configJson) return null;
  try {
    const parsed = JSON.parse(configJson) as { triggerSource?: string };
    return parsed.triggerSource ?? null;
  } catch {
    return null;
  }
}

describe("case 18: cron + manual trigger overlap", () => {
  test("cron-fired and manual triggers produce two distinct runs (no dedupe enforced)", async () => {
    const { sqlite, adapter } = buildAdapter();
    onTestFinished(() => sqlite.close());

    const cronId = "cron-case18";
    const baseMs = Date.now();
    await seedCron(adapter, cronId, baseMs);

    const cronRunId = createRunId("croninst");
    const manualRunId = createRunId("manual01");

    await triggerRun(adapter, cronRunId, "cron", baseMs);
    await triggerRun(adapter, manualRunId, "manual", baseMs + 1);

    await adapter.updateCronRunTime(cronId, baseMs, baseMs + 5 * 60_000, null);

    const runs = await readRunsForWorkflow(adapter);
    expect(runs.length).toBe(2);

    const ids = new Set(runs.map((r) => r.runId));
    expect(ids.size).toBe(2);
    expect(ids.has(cronRunId)).toBe(true);
    expect(ids.has(manualRunId)).toBe(true);

    const sources = runs.map((r) => parseTriggerSource(r.configJson)).sort();
    expect(sources).toEqual(["cron", "manual"]);

    const cronRow = await readCron(adapter, cronId);
    expect(cronRow.lastRunAtMs).toBe(baseMs);
    expect(cronRow.nextRunAtMs).toBe(baseMs + 5 * 60_000);
  });

  test("regression guard: insertRun on identical run_id collapses to one row", async () => {
    const { sqlite, adapter } = buildAdapter();
    onTestFinished(() => sqlite.close());

    const baseMs = Date.now();
    const sharedRunId = createRunId("shared01");

    // The real `insertRun` is INSERT-OR-IGNORE on the run_id PK, so the second
    // launch for the same id is a no-op — the first (cron) launch is kept.
    await triggerRun(adapter, sharedRunId, "cron", baseMs);
    await triggerRun(adapter, sharedRunId, "manual", baseMs + 1);

    const runs = await readRunsForWorkflow(adapter);
    expect(runs.length).toBe(1);
    expect(runs[0]?.runId).toBe(sharedRunId);
    expect(parseTriggerSource(runs[0]?.configJson ?? null)).toBe("cron");
  });

  test("regression guard: two cron retriggers mint distinct run_ids (no PK collision)", async () => {
    const { sqlite, adapter } = buildAdapter();
    onTestFinished(() => sqlite.close());

    const cronId = "cron-case18-retrigger";
    const baseMs = Date.now();
    await seedCron(adapter, cronId, baseMs);

    const firstCronRun = createRunId("cron-a");
    const secondCronRun = createRunId("cron-b");

    await triggerRun(adapter, firstCronRun, "cron", baseMs);
    await triggerRun(adapter, secondCronRun, "cron", baseMs + 2);

    const runs = await readRunsForWorkflow(adapter);
    expect(runs.length).toBe(2);
    const ids = runs.map((r) => r.runId);
    expect(new Set(ids).size).toBe(2);
  });

  test.skip("policy: dedupe overlapping cron+manual to a single active run per workflow", () => {
    // Skipped: as of this commit the smithers cron path (apps/cli/src/scheduler.js
    // -> spawn `bun run src/index.js up <workflow> -d`) and the manual `up`
    // command both call `WorkflowDriver.createRunId()` which produces a fresh
    // random run_id every time. There is no `trigger_source` column on
    // `_smithers_runs` (see packages/db/src/internal-schema/smithersRuns.js) and
    // no idempotency key shared between cron-fired and manual launches. The only
    // dedupe mechanism is INSERT OR IGNORE on the run_id PK (exercised above via
    // the real adapter.insertRun), which never collides because each launch mints
    // a new id.
    //
    // When the dedupe policy is decided (likely as part of ticket 0022 or a
    // follow-up), this test should:
    //   1. trigger a cron run while a manual run for the same workflow is
    //      already in-flight (status in ('running')),
    //   2. assert exactly one of: the second insert is rejected, the second
    //      insert is queued, or the second insert reuses the first run's id,
    //   3. depending on which option is chosen, assert the corresponding
    //      observable surface (rejection error, queue row, or shared run_id).
    expect(true).toBe(true);
  });
});
