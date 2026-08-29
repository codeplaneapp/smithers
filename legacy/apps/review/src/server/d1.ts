/**
 * Minimal Cloudflare D1 surface this worker depends on.
 *
 * Production receives an Alchemy-bound D1Database. Tests receive a bun:sqlite
 * adapter implementing the same shape (see tests/server/helpers/sqliteD1.ts).
 * Keep this interface narrow: only the methods the worker actually calls.
 */
export interface D1ExecResult {
  count: number;
  duration: number;
}

export interface D1Meta {
  changes?: number;
  last_row_id?: number;
  rows_read?: number;
  rows_written?: number;
}

export interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: D1Meta;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  exec(query: string): Promise<D1ExecResult>;
}
