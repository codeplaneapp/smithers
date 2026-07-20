import { Database } from "bun:sqlite";
import type {
  D1Database,
  D1ExecResult,
  D1PreparedStatement,
  D1Result,
} from "../../../src/server/d1.ts";

/**
 * bun:sqlite shaped to look like Cloudflare D1, just enough for the worker.
 *
 * Why this exists: tests want the worker code to run unchanged against an
 * in-memory database. The worker only needs prepare/bind/first/all/run plus
 * exec — this adapter provides exactly that. Returning fresh statement
 * wrappers from .bind() preserves D1's chainable shape; rebinding once is
 * intentional (D1 allows it too).
 */
class SqlitePreparedStatement implements D1PreparedStatement {
  constructor(
    private readonly db: Database,
    private readonly query: string,
    private readonly args: unknown[] = [],
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    return new SqlitePreparedStatement(this.db, this.query, values);
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const stmt = this.db.query(this.query);
    const row = stmt.get(...(this.args as never[])) as T | null;
    return row ?? null;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const stmt = this.db.query(this.query);
    const rows = stmt.all(...(this.args as never[])) as T[];
    return { results: rows, success: true, meta: { rows_read: rows.length } };
  }

  async run(): Promise<D1Result> {
    const stmt = this.db.query(this.query);
    const result = stmt.run(...(this.args as never[]));
    return {
      results: [],
      success: true,
      meta: {
        changes: Number(result.changes ?? 0),
        last_row_id: Number(result.lastInsertRowid ?? 0),
      },
    };
  }
}

class SqliteD1 implements D1Database {
  constructor(public readonly raw: Database) {}

  prepare(query: string): D1PreparedStatement {
    return new SqlitePreparedStatement(this.raw, query);
  }

  async exec(query: string): Promise<D1ExecResult> {
    const start = performance.now();
    this.raw.exec(query);
    return { count: 1, duration: performance.now() - start };
  }
}

export function sqliteD1(): D1Database & { raw: Database } {
  return new SqliteD1(new Database(":memory:"));
}
