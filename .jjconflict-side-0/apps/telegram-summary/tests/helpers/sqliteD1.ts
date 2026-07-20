import { Database } from "bun:sqlite";
import type { D1Database, D1PreparedStatement, D1Result } from "../../src/env.ts";

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
    const statement = this.db.query(this.query);
    const row = statement.get(...(this.args as never[])) as T | null;
    return row ?? null;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const statement = this.db.query(this.query);
    const rows = statement.all(...(this.args as never[])) as T[];
    return { results: rows, success: true, meta: { rows_read: rows.length } };
  }

  async run(): Promise<D1Result> {
    const statement = this.db.query(this.query);
    const result = statement.run(...(this.args as never[]));
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

  async exec(query: string): Promise<D1Result> {
    this.raw.exec(query);
    return { results: [], success: true, meta: {} };
  }

  async batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    const results: Array<Promise<D1Result<T>>> = [];
    this.raw.transaction(() => {
      for (const statement of statements) {
        results.push(statement.run() as Promise<D1Result<T>>);
      }
    })();
    return await Promise.all(results);
  }
}

export function sqliteD1(): D1Database & { raw: Database } {
  return new SqliteD1(new Database(":memory:"));
}
