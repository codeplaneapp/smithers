import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

type RawRunRow = {
  run_id: string;
  workflow_name: string;
  workflow_path: string | null;
  status: string;
  created_at_ms: number;
  config_json: string | null;
};

type RawCronRow = {
  cron_id: string;
  pattern: string;
  workflow_path: string;
  enabled: number;
  created_at_ms: number;
  last_run_at_ms: number | null;
  next_run_at_ms: number | null;
};

const WORKFLOW_PATH = "workflows/case18.tsx";
const WORKFLOW_NAME = "case18-workflow";
const CRON_PATTERN = "*/5 * * * *";

function buildDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE _smithers_runs (
      run_id TEXT PRIMARY KEY,
      parent_run_id TEXT,
      workflow_name TEXT NOT NULL,
      workflow_path TEXT,
      workflow_hash TEXT,
      status TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      started_at_ms INTEGER,
      finished_at_ms INTEGER,
      heartbeat_at_ms INTEGER,
      runtime_owner_id TEXT,
      cancel_requested_at_ms INTEGER,
      hijack_requested_at_ms INTEGER,
      hijack_target TEXT,
      vcs_type TEXT,
      vcs_root TEXT,
      vcs_revision TEXT,
      error_json TEXT,
      config_json TEXT
    );
    CREATE TABLE _smithers_cron (
      cron_id TEXT PRIMARY KEY,
      pattern TEXT NOT NULL,
      workflow_path TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      created_at_ms INTEGER NOT NULL,
      last_run_at_ms INTEGER,
      next_run_at_ms INTEGER,
      error_json TEXT
    );
  `);
  return db;
}

function seedCron(db: Database, cronId: string, nowMs: number): void {
  db.query(
    `INSERT INTO _smithers_cron
       (cron_id, pattern, workflow_path, enabled, created_at_ms, last_run_at_ms, next_run_at_ms, error_json)
     VALUES (?, ?, ?, 1, ?, NULL, ?, NULL)`,
  ).run(cronId, CRON_PATTERN, WORKFLOW_PATH, nowMs, nowMs - 1);
}

function createRunId(suffix: string): string {
  return `run_${Date.now().toString(36)}_${suffix}`;
}

function triggerRun(
  db: Database,
  runId: string,
  triggerSource: "cron" | "manual",
  nowMs: number,
): void {
  const configJson = JSON.stringify({ triggerSource });
  db.query(
    `INSERT OR IGNORE INTO _smithers_runs
       (run_id, workflow_name, workflow_path, status, created_at_ms, config_json)
     VALUES (?, ?, ?, 'pending', ?, ?)`,
  ).run(runId, WORKFLOW_NAME, WORKFLOW_PATH, nowMs, configJson);
}

function readRunsForWorkflow(
  db: Database,
  workflowPath: string,
): readonly RawRunRow[] {
  return db
    .query(
      `SELECT run_id, workflow_name, workflow_path, status, created_at_ms, config_json
         FROM _smithers_runs
        WHERE workflow_path = ?
        ORDER BY created_at_ms ASC`,
    )
    .all(workflowPath) as RawRunRow[];
}

function readCron(db: Database, cronId: string): RawCronRow {
  const row = db
    .query("SELECT * FROM _smithers_cron WHERE cron_id = ?")
    .get(cronId) as RawCronRow | null;
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
  test("cron-fired and manual triggers produce two distinct runs (no dedupe enforced)", () => {
    const db = buildDb();
    const cronId = "cron-case18";
    const baseMs = Date.now();

    try {
      seedCron(db, cronId, baseMs);

      const cronRunId = createRunId("croninst");
      const manualRunId = createRunId("manual01");

      triggerRun(db, cronRunId, "cron", baseMs);
      triggerRun(db, manualRunId, "manual", baseMs + 1);

      db.query(
        `UPDATE _smithers_cron SET last_run_at_ms = ?, next_run_at_ms = ? WHERE cron_id = ?`,
      ).run(baseMs, baseMs + 5 * 60_000, cronId);

      const runs = readRunsForWorkflow(db, WORKFLOW_PATH);
      expect(runs.length).toBe(2);

      const ids = new Set(runs.map((r) => r.run_id));
      expect(ids.size).toBe(2);
      expect(ids.has(cronRunId)).toBe(true);
      expect(ids.has(manualRunId)).toBe(true);

      const sources = runs
        .map((r) => parseTriggerSource(r.config_json))
        .sort();
      expect(sources).toEqual(["cron", "manual"]);

      const cronRow = readCron(db, cronId);
      expect(cronRow.last_run_at_ms).toBe(baseMs);
      expect(cronRow.next_run_at_ms).toBe(baseMs + 5 * 60_000);
    } finally {
      db.close();
    }
  });

  test("regression guard: insertIgnore on identical run_id collapses to one row", () => {
    const db = buildDb();
    const baseMs = Date.now();
    const sharedRunId = createRunId("shared01");

    try {
      triggerRun(db, sharedRunId, "cron", baseMs);
      triggerRun(db, sharedRunId, "manual", baseMs + 1);

      const runs = readRunsForWorkflow(db, WORKFLOW_PATH);
      expect(runs.length).toBe(1);
      expect(runs[0]?.run_id).toBe(sharedRunId);
      expect(parseTriggerSource(runs[0]?.config_json ?? null)).toBe("cron");
    } finally {
      db.close();
    }
  });

  test("regression guard: cron retrigger before next_run_at_ms must not be observable as a duplicate run by run_id", () => {
    const db = buildDb();
    const cronId = "cron-case18-retrigger";
    const baseMs = Date.now();

    try {
      seedCron(db, cronId, baseMs);

      const firstCronRun = createRunId("cron-a");
      const secondCronRun = createRunId("cron-b");

      triggerRun(db, firstCronRun, "cron", baseMs);
      triggerRun(db, secondCronRun, "cron", baseMs + 2);

      const runs = readRunsForWorkflow(db, WORKFLOW_PATH);
      expect(runs.length).toBe(2);
      const ids = runs.map((r) => r.run_id);
      expect(new Set(ids).size).toBe(2);
    } finally {
      db.close();
    }
  });

  test.skip("policy: dedupe overlapping cron+manual to a single active run per workflow", () => {
    // Skipped: as of this commit the smithers cron path (apps/cli/src/scheduler.js
    // -> spawn `bun run src/index.js up <workflow> -d`) and the manual `up`
    // command both call `WorkflowDriver.createRunId()` which produces a fresh
    // random run_id every time. There is no `trigger_source` column on
    // `_smithers_runs` (see packages/db/src/internal-schema/smithersRuns.js)
    // and no idempotency key shared between cron-fired and manual launches.
    // The only dedupe mechanism is `INSERT OR IGNORE` on the run_id PK, which
    // never collides because each launch mints a new id.
    //
    // When the dedupe policy is decided (likely as part of ticket 0022 or a
    // follow-up), this test should:
    //   1. trigger a cron run while a manual run for the same workflow is
    //      already in-flight (status in ('pending','running')),
    //   2. assert exactly one of: the second insert is rejected, the second
    //      insert is queued, or the second insert reuses the first run's id,
    //   3. depending on which option is chosen, assert the corresponding
    //      observable surface (rejection error, queue row, or shared run_id).
    expect(true).toBe(true);
  });
});
