import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLatestScore } from "./readLatestScore";

function makeDb(path: string): Database {
  const db = new Database(path);
  db.run(`CREATE TABLE _smithers_scorers (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    iteration INTEGER NOT NULL DEFAULT 0,
    attempt INTEGER NOT NULL DEFAULT 0,
    scorer_id TEXT NOT NULL,
    scorer_name TEXT NOT NULL,
    source TEXT NOT NULL,
    score REAL NOT NULL,
    reason TEXT,
    meta_json TEXT,
    input_json TEXT,
    output_json TEXT,
    latency_ms REAL,
    scored_at_ms INTEGER NOT NULL,
    duration_ms REAL
  )`);
  return db;
}

describe("readLatestScore", () => {
  let root: string;
  let dbPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "score-helper-"));
    dbPath = join(root, "test.db");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("returns missing when the db file does not exist", async () => {
    const result = await readLatestScore({
      runId: "r1",
      nodeId: "n1",
      scorerName: "s1",
      dbPath: join(root, "nope.db"),
    });
    expect(result).toEqual({ status: "missing" });
  });

  test("returns pending when no row matches", async () => {
    const db = makeDb(dbPath);
    db.close();
    const result = await readLatestScore({
      runId: "r1",
      nodeId: "n1",
      scorerName: "s1",
      dbPath,
    });
    expect(result).toEqual({ status: "pending" });
  });

  test("returns ready with the latest score by scored_at_ms", async () => {
    const db = makeDb(dbPath);
    const insert = db.prepare(
      `INSERT INTO _smithers_scorers (id, run_id, node_id, iteration, attempt, scorer_id, scorer_name, source, score, reason, scored_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run("a", "r1", "n1", 0, 0, "rctf", "rctf", "live", 0.5, "early", 100);
    insert.run("b", "r1", "n1", 0, 0, "rctf", "rctf", "live", 0.9, "late", 200);
    insert.run("c", "r1", "other", 0, 0, "rctf", "rctf", "live", 0.1, "elsewhere", 150);
    db.close();

    const result = await readLatestScore({
      runId: "r1",
      nodeId: "n1",
      scorerName: "rctf",
      dbPath,
    });
    expect(result).toEqual({
      status: "ready",
      score: 0.9,
      reason: "late",
      scoredAtMs: 200,
    });
  });

  test("respects iteration filter when provided", async () => {
    const db = makeDb(dbPath);
    const insert = db.prepare(
      `INSERT INTO _smithers_scorers (id, run_id, node_id, iteration, attempt, scorer_id, scorer_name, source, score, reason, scored_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run("a", "r1", "n1", 0, 0, "rctf", "rctf", "live", 0.4, "iter0", 100);
    insert.run("b", "r1", "n1", 1, 0, "rctf", "rctf", "live", 0.8, "iter1", 200);
    db.close();

    const result = await readLatestScore({
      runId: "r1",
      nodeId: "n1",
      scorerName: "rctf",
      iteration: 0,
      dbPath,
    });
    expect(result).toMatchObject({ status: "ready", score: 0.4 });
  });
});
