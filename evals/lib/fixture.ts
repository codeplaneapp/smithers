// A deterministic, smithers-shaped run-history SQLite fixture so db-query evals
// have known answers. The candidate is given the schema + path, writes SQL, and
// the `query` verifier runs THAT SQL against this db and checks the scalar.
//
// Rebuilt idempotently (drop + reseed) so answers never drift.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { repoRoot } from "./paths.js";

/** Relative to repo root, so committed cases stay machine-independent (verify
 * opens it relative to cwd, which is always the repo root for eval runs). */
export const FIXTURE_DB_REL = ".smithers/state/fixture-runs.db";

export function fixtureDbAbs(): string {
  return join(repoRoot(), FIXTURE_DB_REL);
}

/** Plain-English schema handed to the candidate (a real user would inspect this). */
export const SCHEMA_DOC = `The SQLite run-history DB has these tables:
  runs(run_id TEXT, workflow TEXT, status TEXT, model TEXT, created_at INTEGER, finished_at INTEGER, token_cost INTEGER)
  events(id INTEGER, run_id TEXT, seq INTEGER, type TEXT, node_id TEXT, ts INTEGER)
  node_outputs(run_id TEXT, node_id TEXT, schema_name TEXT, payload TEXT)
  scores(run_id TEXT, node_id TEXT, scorer TEXT, score REAL)`;

type RunRow = [string, string, string, string, number, number | null, number];
// run_id, workflow, status, model, created_at, finished_at, token_cost
const RUNS: RunRow[] = [
  ["r1", "implement", "finished", "sonnet", 1000, 1100, 1200],
  ["r2", "implement", "finished", "haiku", 1010, 1080, 800],
  ["r3", "review", "finished", "sonnet", 1020, 1200, 1500],
  ["r4", "plan", "finished", "opus", 1030, 1400, 3000],
  ["r5", "implement", "failed", "sonnet", 1040, 1050, 400],
  ["r6", "review", "cancelled", "haiku", 1050, 1060, 200],
  ["r7", "debug", "waiting-approval", "sonnet", 1060, null, 600],
];

type EventRow = [string, number, string, string, number];
const EVENTS: EventRow[] = [
  ["r1", 1, "run_started", "", 1000],
  ["r1", 2, "node_finished", "implement", 1100],
  ["r3", 1, "run_started", "", 1020],
  ["r3", 2, "node_finished", "review", 1200],
  ["r5", 1, "run_started", "", 1040],
  ["r5", 2, "node_failed", "implement", 1050],
  ["r7", 1, "run_started", "", 1060],
  ["r7", 2, "approval_requested", "deploy", 1065],
];

type ScoreRow = [string, string, string, number];
const SCORES: ScoreRow[] = [
  ["r1", "implement", "faithfulness", 0.8],
  ["r3", "review", "faithfulness", 0.6],
  ["r4", "plan", "faithfulness", 1.0],
  ["r1", "implement", "one-shot", 1.0],
];

/** Known answers, asserted by the db-query cases (kept here as documentation). */
export const KNOWN = {
  finishedRuns: 4,
  failedRuns: 1,
  mostRunsWorkflow: "implement",
  finishedTokenCost: 6500,
  sonnetRuns: 4,
  highestCostRun: "r4",
  distinctWorkflows: 4,
  approvalRequestedEvents: 1,
};

export function buildFixture(): string {
  const abs = fixtureDbAbs();
  mkdirSync(dirname(abs), { recursive: true });
  const db = new Database(abs);
  db.exec("DROP TABLE IF EXISTS runs; DROP TABLE IF EXISTS events; DROP TABLE IF EXISTS node_outputs; DROP TABLE IF EXISTS scores;");
  db.exec(`CREATE TABLE runs(run_id TEXT PRIMARY KEY, workflow TEXT, status TEXT, model TEXT, created_at INTEGER, finished_at INTEGER, token_cost INTEGER);
           CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, seq INTEGER, type TEXT, node_id TEXT, ts INTEGER);
           CREATE TABLE node_outputs(run_id TEXT, node_id TEXT, schema_name TEXT, payload TEXT);
           CREATE TABLE scores(run_id TEXT, node_id TEXT, scorer TEXT, score REAL);`);
  const ins = db.prepare("INSERT INTO runs VALUES (?,?,?,?,?,?,?)");
  for (const r of RUNS) ins.run(...r);
  const ie = db.prepare("INSERT INTO events(run_id,seq,type,node_id,ts) VALUES (?,?,?,?,?)");
  for (const e of EVENTS) ie.run(...e);
  const is = db.prepare("INSERT INTO scores VALUES (?,?,?,?)");
  for (const s of SCORES) is.run(...s);
  db.close();
  return abs;
}

if (import.meta.main) {
  const p = buildFixture();
  console.log(`fixture seeded → ${p}`);
}
