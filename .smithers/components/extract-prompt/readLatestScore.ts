import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

export type ScoreStatus =
  | { status: "ready"; score: number; reason: string | null; scoredAtMs: number }
  | { status: "pending" }
  | { status: "missing" };

export type ReadLatestScoreArgs = {
  runId: string;
  nodeId: string;
  scorerName: string;
  iteration?: number;
  /** Path to smithers.db. Defaults to ./smithers.db relative to cwd. */
  dbPath?: string;
};

type Row = {
  score: number;
  reason: string | null;
  scored_at_ms: number;
};

/**
 * Reads the latest score for (runId, nodeId, scorerName, iteration?) from
 * `_smithers_scorers`. Distinguishes three states:
 *
 *   - "ready"   : a score row exists, returns the value.
 *   - "pending" : a scorer is registered for the node but no row yet.
 *   - "missing" : no scorer registered for that name.
 *
 * Pending vs missing cannot be perfectly distinguished from the scores table
 * alone — `_smithers_scorers` only records *finished* runs. We approximate:
 * if no row is found, we return "pending". Callers who need true "missing"
 * detection should pass a scorerName they know is registered.
 */
export async function readLatestScore(
  args: ReadLatestScoreArgs,
): Promise<ScoreStatus> {
  const dbPath = resolve(args.dbPath ?? "smithers.db");
  if (!existsSync(dbPath)) {
    return { status: "missing" };
  }

  const db = new Database(dbPath, { readonly: true });
  try {
    const where = [
      "run_id = ?",
      "node_id = ?",
      "scorer_name = ?",
    ];
    const params: (string | number)[] = [args.runId, args.nodeId, args.scorerName];
    if (typeof args.iteration === "number") {
      where.push("iteration = ?");
      params.push(args.iteration);
    }
    const sql = `SELECT score, reason, scored_at_ms
      FROM _smithers_scorers
      WHERE ${where.join(" AND ")}
      ORDER BY scored_at_ms DESC
      LIMIT 1`;
    const row = db.query(sql).get(...params) as Row | null;
    if (row === null || row === undefined) {
      return { status: "pending" };
    }
    return {
      status: "ready",
      score: row.score,
      reason: row.reason,
      scoredAtMs: row.scored_at_ms,
    };
  } finally {
    db.close();
  }
}
