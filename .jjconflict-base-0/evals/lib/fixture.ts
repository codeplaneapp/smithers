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

// ── Ops fixture: Smithers' REAL run-history schema, so "investigate my runs"
//    evals query the actual _smithers_* tables a user would. ────────────────
export const OPS_DB_REL = ".smithers/state/fixture-ops.db";
export function opsDbAbs(): string {
  return join(repoRoot(), OPS_DB_REL);
}

export const OPS_SCHEMA_DOC = `The run-history DB uses Smithers' real schema. Key tables:
  _smithers_runs(run_id, workflow_name, status, created_at_ms, finished_at_ms, error_json, ...)
  _smithers_nodes(run_id, node_id, iteration, state, label, ...)   -- state: finished|failed|running|pending
  _smithers_events(run_id, seq, type, payload_json, timestamp_ms)  -- type: run_started|node_finished|node_failed|approval_requested
  _smithers_approvals(run_id, node_id, status, ...)                -- status: pending|approved|denied
  _smithers_scorers(run_id, node_id, scorer_name, score, ...)`;

export const KNOWN_OPS = {
  waitingApprovalRun: "or4",
  failedRun: "or3",
  failedNodeInOr3: "implement",
  failedRunsCount: 1,
  mostRunsWorkflow: "implement",
  nodeFailedEvents: 1,
  approvalRequestedEvents: 1,
};

export function buildOpsFixture(): string {
  const abs = opsDbAbs();
  mkdirSync(dirname(abs), { recursive: true });
  const db = new Database(abs);
  for (const t of ["_smithers_runs", "_smithers_nodes", "_smithers_events", "_smithers_approvals", "_smithers_scorers"]) {
    db.exec(`DROP TABLE IF EXISTS ${t};`);
  }
  db.exec(`
    CREATE TABLE _smithers_runs(run_id TEXT PRIMARY KEY, workflow_name TEXT, status TEXT, created_at_ms INTEGER, finished_at_ms INTEGER, error_json TEXT);
    CREATE TABLE _smithers_nodes(run_id TEXT, node_id TEXT, iteration INTEGER, state TEXT, label TEXT);
    CREATE TABLE _smithers_events(run_id TEXT, seq INTEGER, type TEXT, payload_json TEXT, timestamp_ms INTEGER);
    CREATE TABLE _smithers_approvals(run_id TEXT, node_id TEXT, status TEXT, requested_at_ms INTEGER);
    CREATE TABLE _smithers_scorers(run_id TEXT, node_id TEXT, scorer_name TEXT, score REAL);`);
  const runs: Array<[string, string, string, number, number | null, string | null]> = [
    ["or1", "implement", "finished", 1000, 1100, null],
    ["or2", "review", "finished", 1010, 1200, null],
    ["or3", "implement", "failed", 1020, 1050, JSON.stringify({ message: "TypeError: cannot read property 'id' of undefined" })],
    ["or4", "deploy", "waiting-approval", 1030, null, null],
    ["or5", "implement", "cancelled", 1040, 1045, null],
    ["or6", "research", "running", 1050, null, null],
  ];
  const ri = db.prepare("INSERT INTO _smithers_runs VALUES (?,?,?,?,?,?)");
  for (const r of runs) ri.run(...r);
  const nodes: Array<[string, string, number, string, string]> = [
    ["or1", "analyze", 0, "finished", "Analyze"],
    ["or1", "implement", 0, "finished", "Implement"],
    ["or2", "review", 0, "finished", "Review"],
    ["or3", "analyze", 0, "finished", "Analyze"],
    ["or3", "implement", 0, "failed", "Implement"],
    ["or4", "build", 0, "finished", "Build"],
    ["or4", "deploy", 0, "pending", "Deploy"],
    ["or6", "search", 0, "running", "Search"],
  ];
  const ni = db.prepare("INSERT INTO _smithers_nodes VALUES (?,?,?,?,?)");
  for (const n of nodes) ni.run(...n);
  const events: Array<[string, number, string]> = [
    ["or1", 1, "run_started"], ["or1", 2, "node_finished"],
    ["or3", 1, "run_started"], ["or3", 2, "node_failed"],
    ["or4", 1, "run_started"], ["or4", 2, "approval_requested"],
  ];
  const ei = db.prepare("INSERT INTO _smithers_events(run_id,seq,type) VALUES (?,?,?)");
  for (const e of events) ei.run(...e);
  db.prepare("INSERT INTO _smithers_approvals(run_id,node_id,status) VALUES (?,?,?)").run("or4", "deploy", "pending");
  const si = db.prepare("INSERT INTO _smithers_scorers(run_id,node_id,scorer_name,score) VALUES (?,?,?,?)");
  si.run("or1", "implement", "faithfulness", 0.9);
  si.run("or2", "review", "faithfulness", 0.7);
  db.close();
  return abs;
}

if (import.meta.main) {
  console.log(`fixture seeded → ${buildFixture()}`);
  console.log(`ops fixture seeded → ${buildOpsFixture()}`);
}
